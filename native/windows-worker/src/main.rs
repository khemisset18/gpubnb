//! GPUbnb renter-session graphical worker bootstrap.
//!
//! This binary owns no privileged lifecycle authority. It binds its identity and
//! typed control commands to the local ACL/PID-fenced GPUbnb pipe, then performs
//! exact-GPU media and isolated-input work only inside the renter session. Public
//! readiness remains fail-closed until authenticated media transport and lifecycle
//! wiring can expose those proofs without ever capturing the provider desktop.

#[cfg(target_os = "windows")]
use gpubnb_windows_platform::gpu_identity::resolve_nvidia_uuid_to_luid;
#[cfg(target_os = "windows")]
use gpubnb_windows_platform::input::inject_input;
#[cfg(any(target_os = "windows", test))]
use gpubnb_windows_platform::input::{
    InputEvent as PlatformInputEvent, MouseButton as PlatformMouseButton,
};
#[cfg(any(target_os = "windows", test))]
use gpubnb_windows_platform::media::MediaProbeError;
#[cfg(target_os = "windows")]
use gpubnb_windows_platform::media::{
    EncodedMediaFrame, MediaProbeRequest, MediaSession, open_media_session,
};
#[cfg(target_os = "windows")]
use gpubnb_windows_platform::pipe::{
    WorkerMediaPipeClient, WorkerPipeClient, connect_worker_media_pipe_client,
    connect_worker_pipe_client,
};
#[cfg(target_os = "windows")]
use gpubnb_windows_platform::session::current_process_session_id;
use gpubnb_windows_stream_helper::lifecycle::WorkspaceKind;
#[cfg(target_os = "windows")]
use gpubnb_windows_stream_helper::media_protocol::{
    MEDIA_CODEC_H264, MEDIA_FRAME_FLAG_KEYFRAME, MEDIA_TRANSPORT_PROTOCOL_VERSION,
    WorkerMediaFrameHeader, encode_worker_media_frame_header,
};
#[cfg(target_os = "windows")]
use gpubnb_windows_stream_helper::worker_protocol::{
    WORKER_PROTOCOL_VERSION, WorkerCommand, WorkerDisplaySpec, WorkerHello, WorkerMediaPollFrame,
    WorkerMediaPollStatus, WorkerMediaProof, decode_worker_command, decode_worker_display_spec,
    decode_worker_input, encode_worker_hello, encode_worker_media_poll, encode_worker_media_proof,
    validate_worker_command, validate_worker_display_spec, validate_worker_input,
};
#[cfg(any(target_os = "windows", test))]
use gpubnb_windows_stream_helper::worker_protocol::{WorkerInputEvent, WorkerMouseButton};
use std::env;
use std::process::ExitCode;
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

const MAX_SESSION_ID: usize = 128;
const MAX_GPU_UUID: usize = 64;
const BUILD_MEDIA_SIGNER_SHA256: Option<&str> = option_env!("GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256");
const BUILD_SOURCE_COMMIT: Option<&str> = option_env!("GPUBNB_SOURCE_COMMIT");
#[cfg(target_os = "windows")]
const PIPE_TIMEOUT_MS: u32 = 10_000;
#[cfg(target_os = "windows")]
const MEDIA_POLL_TIMEOUT_MS: u32 = 250;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkerArgs {
    session_id: String,
    generation: u64,
    gpu_uuid: String,
    workspace: WorkspaceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkerError {
    code: &'static str,
    exit_code: u8,
}

impl WorkerError {
    const fn new(code: &'static str, exit_code: u8) -> Self {
        Self { code, exit_code }
    }
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaState {
    Empty,
    DisplayPrepared,
    Ready,
    Suspended,
}

#[cfg(any(target_os = "windows", test))]
impl MediaState {
    fn prepare(self) -> Result<Self, WorkerError> {
        match self {
            Self::Empty | Self::DisplayPrepared => Ok(Self::DisplayPrepared),
            Self::Ready | Self::Suspended => {
                Err(WorkerError::new("media_state_prepare_invalid", 21))
            }
        }
    }

    fn capture(self) -> Result<Self, WorkerError> {
        match self {
            Self::DisplayPrepared | Self::Ready => Ok(Self::Ready),
            Self::Empty => Err(WorkerError::new("display_not_prepared", 21)),
            Self::Suspended => Err(WorkerError::new(
                "media_suspended_requires_fresh_resume",
                21,
            )),
        }
    }

    fn suspend(self) -> Result<Self, WorkerError> {
        match self {
            Self::Ready => Ok(Self::Suspended),
            Self::Suspended => Err(WorkerError::new("media_already_suspended", 21)),
            Self::Empty | Self::DisplayPrepared => Err(WorkerError::new("media_not_ready", 21)),
        }
    }

    fn resume(self) -> Result<Self, WorkerError> {
        match self {
            Self::Suspended => Ok(Self::Ready),
            Self::Empty | Self::DisplayPrepared | Self::Ready => {
                Err(WorkerError::new("media_not_suspended", 21))
            }
        }
    }
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_gpu_uuid(value: &str) -> bool {
    if value.len() > MAX_GPU_UUID || !value.starts_with("GPU-") {
        return false;
    }
    let uuid = &value[4..];
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| {
            let hyphen = matches!(index, 8 | 13 | 18 | 23);
            (hyphen && byte == b'-') || (!hyphen && byte.is_ascii_hexdigit())
        })
}

fn parse_workspace(value: &str) -> Result<WorkspaceKind, WorkerError> {
    match value {
        "cloud-desktop" => Ok(WorkspaceKind::CloudDesktop),
        "creator" => Ok(WorkspaceKind::Creator),
        "cad" => Ok(WorkspaceKind::Cad),
        "gaming" => Ok(WorkspaceKind::Gaming),
        _ => Err(WorkerError::new("unsupported_workspace", 2)),
    }
}

fn take_value(
    args: &[String],
    index: &mut usize,
    missing: &'static str,
) -> Result<String, WorkerError> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| WorkerError::new(missing, 2))
}

fn parse_args(args: &[String]) -> Result<WorkerArgs, WorkerError> {
    let mut session_id = None;
    let mut generation = None;
    let mut gpu_uuid = None;
    let mut workspace = None;
    let mut index = 0usize;

    while index < args.len() {
        match args[index].as_str() {
            "--session-id" if session_id.is_none() => {
                session_id = Some(take_value(args, &mut index, "missing_session_id")?);
            }
            "--generation" if generation.is_none() => {
                let raw = take_value(args, &mut index, "missing_generation")?;
                generation = Some(
                    raw.parse::<u64>()
                        .map_err(|_| WorkerError::new("invalid_generation", 2))?,
                );
            }
            "--gpu-uuid" if gpu_uuid.is_none() => {
                gpu_uuid = Some(take_value(args, &mut index, "missing_gpu_uuid")?);
            }
            "--workspace" if workspace.is_none() => {
                let raw = take_value(args, &mut index, "missing_workspace")?;
                workspace = Some(parse_workspace(&raw)?);
            }
            _ => return Err(WorkerError::new("unknown_or_duplicate_argument", 2)),
        }
        index += 1;
    }

    let session_id = session_id.ok_or_else(|| WorkerError::new("missing_session_id", 2))?;
    let generation = generation.ok_or_else(|| WorkerError::new("missing_generation", 2))?;
    let gpu_uuid = gpu_uuid.ok_or_else(|| WorkerError::new("missing_gpu_uuid", 2))?;
    let workspace = workspace.ok_or_else(|| WorkerError::new("missing_workspace", 2))?;

    if !valid_session_id(&session_id) {
        return Err(WorkerError::new("invalid_session_id", 2));
    }
    if generation == 0 {
        return Err(WorkerError::new("invalid_generation", 2));
    }
    if !valid_gpu_uuid(&gpu_uuid) {
        return Err(WorkerError::new("invalid_gpu_uuid", 2));
    }

    Ok(WorkerArgs {
        session_id,
        generation,
        gpu_uuid,
        workspace,
    })
}

#[cfg(target_os = "windows")]
fn read_required_media_frame(
    session: &mut MediaSession,
    resume: bool,
) -> Result<EncodedMediaFrame, WorkerError> {
    let deadline = Instant::now() + Duration::from_millis(u64::from(PIPE_TIMEOUT_MS));
    loop {
        match session.read_frame() {
            Ok(frame) => return Ok(frame),
            Err(MediaProbeError::CaptureTimeout) if Instant::now() < deadline => continue,
            Err(error) => return Err(media_probe_error(error, resume)),
        }
    }
}

#[cfg(target_os = "windows")]
fn send_no_frame_poll(
    control: &WorkerPipeClient,
    generation: u64,
    command_sequence: u64,
    windows_session_id: u32,
) -> Result<(), WorkerError> {
    let frame = encode_worker_media_poll(WorkerMediaPollFrame {
        protocol_version: WORKER_PROTOCOL_VERSION,
        status: WorkerMediaPollStatus::NoFrame,
        generation,
        command_sequence,
        windows_session_id,
    })
    .map_err(|_| WorkerError::new("media_poll_encode_failed", 21))?;
    control
        .send_frame(&frame)
        .map_err(|_| WorkerError::new("media_poll_send_failed", 21))
}

#[cfg(target_os = "windows")]
fn send_encoded_media_frame(
    control: &WorkerPipeClient,
    media_pipe: &WorkerMediaPipeClient,
    args: &WorkerArgs,
    windows_session_id: u32,
    spec: WorkerDisplaySpec,
    command_sequence: u64,
    media: &EncodedMediaFrame,
) -> Result<(), WorkerError> {
    let encoded_bytes = u32::try_from(media.bytes.len())
        .map_err(|_| WorkerError::new("media_frame_too_large", 21))?;
    let proof_value = WorkerMediaProof {
        protocol_version: WORKER_PROTOCOL_VERSION,
        generation: args.generation,
        command_sequence,
        windows_session_id,
        adapter_luid: media.adapter_luid,
        display_nonce: spec.display_nonce,
        width: media.width,
        height: media.height,
        refresh_hz: media.refresh_hz,
        frame_sequence: media.frame_sequence,
        encoded_bytes,
        proof_flags: media.proof_flags,
    };
    let proof = encode_worker_media_proof(proof_value)
        .map_err(|_| WorkerError::new("media_proof_encode_failed", 21))?;
    let header = encode_worker_media_frame_header(WorkerMediaFrameHeader {
        protocol_version: MEDIA_TRANSPORT_PROTOCOL_VERSION,
        codec: MEDIA_CODEC_H264,
        frame_flags: if media.is_keyframe() {
            MEDIA_FRAME_FLAG_KEYFRAME
        } else {
            0
        },
        generation: args.generation,
        command_sequence,
        windows_session_id,
        adapter_luid: media.adapter_luid,
        display_nonce: spec.display_nonce,
        frame_sequence: media.frame_sequence,
        width: media.width,
        height: media.height,
        refresh_hz: media.refresh_hz,
        payload_bytes: encoded_bytes,
        proof_flags: media.proof_flags,
    })
    .map_err(|_| WorkerError::new("media_header_encode_failed", 21))?;

    // Construct and validate both envelopes before publishing the proof. An
    // oversized/invalid frame therefore cannot leave a proof stranded on the
    // control channel. Once valid, publish the small proof first so the service
    // learns the exact bounded payload length before the potentially large write.
    control
        .send_frame(&proof)
        .map_err(|_| WorkerError::new("media_proof_send_failed", 21))?;
    media_pipe
        .send_message(&header)
        .map_err(|_| WorkerError::new("media_header_send_failed", 21))?;
    media_pipe
        .send_message(&media.bytes)
        .map_err(|_| WorkerError::new("media_payload_send_failed", 21))?;
    Ok(())
}

fn execute(args: &WorkerArgs) -> Result<(), WorkerError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = args;
        Err(WorkerError::new("windows_required", 20))
    }

    #[cfg(target_os = "windows")]
    {
        let windows_session_id = current_process_session_id()
            .map_err(|_| WorkerError::new("windows_session_unavailable", 21))?;
        let client = connect_worker_pipe_client(&args.session_id, args.generation, PIPE_TIMEOUT_MS)
            .map_err(|_| WorkerError::new("worker_pipe_connect_failed", 21))?;
        let hello = WorkerHello {
            protocol_version: WORKER_PROTOCOL_VERSION,
            session_id: &args.session_id,
            gpu_uuid: &args.gpu_uuid,
            workspace: args.workspace,
            generation: args.generation,
            windows_session_id,
            worker_pid: std::process::id(),
        };
        let frame =
            encode_worker_hello(hello).map_err(|_| WorkerError::new("worker_hello_invalid", 21))?;
        client
            .send_frame(&frame)
            .map_err(|_| WorkerError::new("worker_hello_send_failed", 21))?;
        let media_client =
            connect_worker_media_pipe_client(&args.session_id, args.generation, PIPE_TIMEOUT_MS)
                .map_err(|_| WorkerError::new("worker_media_pipe_connect_failed", 21))?;

        let mut expected_sequence = 1u64;
        let mut display_spec = None;
        let mut media_state = MediaState::Empty;
        let mut media_session: Option<MediaSession> = None;
        loop {
            let frame = client
                .read_frame(PIPE_TIMEOUT_MS)
                .map_err(|_| WorkerError::new("worker_command_read_failed", 21))?;
            let command_frame = decode_worker_command(&frame)
                .map_err(|_| WorkerError::new("worker_command_invalid", 21))?;
            let command =
                validate_worker_command(args.generation, expected_sequence, command_frame)
                    .map_err(|_| WorkerError::new("worker_command_fence_failed", 21))?;
            let command_sequence = command_frame.sequence;
            expected_sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| WorkerError::new("worker_command_sequence_exhausted", 21))?;

            match command {
                WorkerCommand::Stop => return Ok(()),
                WorkerCommand::PrepareDisplay => {
                    let next_state = media_state.prepare()?;
                    let frame = client
                        .read_frame(PIPE_TIMEOUT_MS)
                        .map_err(|_| WorkerError::new("display_spec_read_failed", 21))?;
                    let spec = decode_worker_display_spec(&frame)
                        .map_err(|_| WorkerError::new("display_spec_invalid", 21))?;
                    validate_worker_display_spec(
                        args.generation,
                        command_sequence,
                        windows_session_id,
                        spec,
                    )
                    .map_err(|_| WorkerError::new("display_spec_fence_failed", 21))?;

                    let identity = resolve_nvidia_uuid_to_luid(&args.gpu_uuid)
                        .map_err(|_| WorkerError::new("exact_gpu_mapping_failed", 21))?;
                    if identity.luid != spec.adapter_luid {
                        return Err(WorkerError::new("display_gpu_luid_mismatch", 21));
                    }
                    display_spec = Some(spec);
                    media_state = next_state;
                }
                WorkerCommand::StartCapture => {
                    let next_state = media_state.capture()?;
                    let spec =
                        display_spec.ok_or_else(|| WorkerError::new("display_not_prepared", 21))?;

                    let identity = resolve_nvidia_uuid_to_luid(&args.gpu_uuid)
                        .map_err(|_| WorkerError::new("exact_gpu_mapping_failed", 21))?;
                    if identity.luid != spec.adapter_luid {
                        return Err(WorkerError::new("capture_gpu_luid_mismatch", 21));
                    }

                    let mut session = open_media_session(MediaProbeRequest {
                        gpu_uuid: &args.gpu_uuid,
                        adapter_luid: spec.adapter_luid,
                        display_nonce: spec.display_nonce,
                        width: spec.width,
                        height: spec.height,
                        refresh_hz: spec.refresh_hz,
                        capture_timeout_ms: MEDIA_POLL_TIMEOUT_MS,
                    })
                    .map_err(|error| media_probe_error(error, false))?;
                    let media = read_required_media_frame(&mut session, false)?;

                    send_encoded_media_frame(
                        &client,
                        &media_client,
                        args,
                        windows_session_id,
                        spec,
                        command_sequence,
                        &media,
                    )?;
                    media_session = Some(session);
                    media_state = next_state;
                }
                WorkerCommand::ReadMediaFrame => {
                    if !matches!(media_state, MediaState::Ready) {
                        return Err(WorkerError::new("media_read_requires_ready", 21));
                    }
                    let spec =
                        display_spec.ok_or_else(|| WorkerError::new("display_not_prepared", 21))?;
                    let session = media_session
                        .as_mut()
                        .ok_or_else(|| WorkerError::new("media_session_missing", 21))?;
                    match session.read_frame() {
                        Ok(media) => {
                            send_encoded_media_frame(
                                &client,
                                &media_client,
                                args,
                                windows_session_id,
                                spec,
                                command_sequence,
                                &media,
                            )?;
                        }
                        Err(MediaProbeError::CaptureTimeout) => {
                            send_no_frame_poll(
                                &client,
                                args.generation,
                                command_sequence,
                                windows_session_id,
                            )?;
                        }
                        Err(error) => return Err(media_probe_error(error, false)),
                    }
                }
                WorkerCommand::SuspendMedia => {
                    media_state = media_state.suspend()?;
                    media_session.take();
                }
                WorkerCommand::InjectInput => {
                    if !matches!(media_state, MediaState::Ready) {
                        return Err(WorkerError::new("input_requires_media_ready", 21));
                    }
                    let frame = client
                        .read_frame(PIPE_TIMEOUT_MS)
                        .map_err(|_| WorkerError::new("input_frame_read_failed", 21))?;
                    let input = decode_worker_input(&frame)
                        .map_err(|_| WorkerError::new("input_frame_invalid", 21))?;
                    let event = validate_worker_input(
                        args.generation,
                        command_sequence,
                        windows_session_id,
                        input,
                    )
                    .map_err(|_| WorkerError::new("input_frame_fence_failed", 21))?;
                    inject_input(windows_session_id, platform_input(event))
                        .map_err(|_| WorkerError::new("input_injection_failed", 21))?;
                }
                WorkerCommand::ResumeAfterFreshProof => {
                    let next_state = media_state.resume()?;
                    let spec =
                        display_spec.ok_or_else(|| WorkerError::new("display_not_prepared", 21))?;

                    // A resume is never an administrative toggle. Re-prove that the
                    // rented NVIDIA UUID still resolves to the exact display LUID,
                    // then capture and NVENC-encode a new frame before the service
                    // is allowed to re-arm READY/billing.
                    let identity = resolve_nvidia_uuid_to_luid(&args.gpu_uuid)
                        .map_err(|_| WorkerError::new("exact_gpu_mapping_failed", 21))?;
                    if identity.luid != spec.adapter_luid {
                        return Err(WorkerError::new("resume_gpu_luid_mismatch", 21));
                    }

                    let mut session = open_media_session(MediaProbeRequest {
                        gpu_uuid: &args.gpu_uuid,
                        adapter_luid: spec.adapter_luid,
                        display_nonce: spec.display_nonce,
                        width: spec.width,
                        height: spec.height,
                        refresh_hz: spec.refresh_hz,
                        capture_timeout_ms: MEDIA_POLL_TIMEOUT_MS,
                    })
                    .map_err(|error| media_probe_error(error, true))?;
                    let media = read_required_media_frame(&mut session, true)?;

                    send_encoded_media_frame(
                        &client,
                        &media_client,
                        args,
                        windows_session_id,
                        spec,
                        command_sequence,
                        &media,
                    )
                    .map_err(|_| WorkerError::new("resume_media_transport_failed", 21))?;

                    media_session = Some(session);
                    media_state = next_state;
                }
            }

            // Keep the persistent session live across control commands while Ready.
            if matches!(media_state, MediaState::Ready) && media_session.is_none() {
                return Err(WorkerError::new("media_session_missing", 21));
            }
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn platform_input(event: WorkerInputEvent) -> PlatformInputEvent {
    match event {
        WorkerInputEvent::KeyScan {
            scan_code,
            key_up,
            extended,
        } => PlatformInputEvent::KeyScan {
            scan_code,
            key_up,
            extended,
        },
        WorkerInputEvent::MouseMoveRelative { dx, dy } => {
            PlatformInputEvent::MouseMoveRelative { dx, dy }
        }
        WorkerInputEvent::MouseMoveAbsolute { x, y } => {
            PlatformInputEvent::MouseMoveAbsolute { x, y }
        }
        WorkerInputEvent::MouseButton { button, key_up } => PlatformInputEvent::MouseButton {
            button: match button {
                WorkerMouseButton::Left => PlatformMouseButton::Left,
                WorkerMouseButton::Right => PlatformMouseButton::Right,
                WorkerMouseButton::Middle => PlatformMouseButton::Middle,
                WorkerMouseButton::X1 => PlatformMouseButton::X1,
                WorkerMouseButton::X2 => PlatformMouseButton::X2,
            },
            key_up,
        },
        WorkerInputEvent::MouseWheel { delta } => PlatformInputEvent::MouseWheel { delta },
    }
}

#[cfg(any(target_os = "windows", test))]
fn media_probe_error(error: MediaProbeError, resume: bool) -> WorkerError {
    let code = match (resume, error) {
        (_, MediaProbeError::CaptureTimeout) => "media_capture_timeout",
        (_, MediaProbeError::CaptureAccessLost) => "media_capture_access_lost",
        (_, MediaProbeError::DeviceLost) => "media_device_lost",
        (true, _) => "resume_media_reproof_failed",
        (false, _) => "media_frame_proof_failed",
    };
    WorkerError::new(code, 21)
}

fn error_json(error: WorkerError) -> String {
    format!(r#"{{"ok":false,"error":"{}"}}"#, error.code)
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn build_policy_json() -> Result<String, WorkerError> {
    let media_signer = BUILD_MEDIA_SIGNER_SHA256
        .filter(|value| is_lower_hex(value, 64))
        .ok_or_else(|| WorkerError::new("build_media_signer_unconfigured", 21))?;
    let source_commit = BUILD_SOURCE_COMMIT
        .filter(|value| is_lower_hex(value, 40))
        .ok_or_else(|| WorkerError::new("build_source_commit_unconfigured", 21))?;

    Ok(format!(
        r#"{{"schemaVersion":1,"sourceCommit":"{source_commit}","mediaSignerSha256":"{media_signer}"}}"#
    ))
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--build-policy", "--json"] {
        return match build_policy_json() {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                println!("{}", error_json(error));
                ExitCode::from(error.exit_code)
            }
        };
    }

    match parse_args(&args).and_then(|parsed| execute(&parsed)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            println!("{}", error_json(error));
            ExitCode::from(error.exit_code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPU: &str = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn valid_args() -> Vec<String> {
        strings(&[
            "--session-id",
            "sess-123",
            "--generation",
            "7",
            "--gpu-uuid",
            GPU,
            "--workspace",
            "cloud-desktop",
        ])
    }

    #[test]
    fn strict_worker_identity_cli_parses() {
        let parsed = parse_args(&valid_args()).expect("valid worker args");
        assert_eq!(parsed.session_id, "sess-123");
        assert_eq!(parsed.generation, 7);
        assert_eq!(parsed.gpu_uuid, GPU);
        assert_eq!(parsed.workspace, WorkspaceKind::CloudDesktop);
    }

    #[test]
    fn worker_cli_rejects_duplicate_unknown_and_arbitrary_app_arguments() {
        let mut duplicate = valid_args();
        duplicate.extend(strings(&["--workspace", "gaming"]));
        assert_eq!(
            parse_args(&duplicate),
            Err(WorkerError::new("unknown_or_duplicate_argument", 2))
        );

        let mut application = valid_args();
        application.extend(strings(&["--application", r"C:\Windows\System32\cmd.exe"]));
        assert_eq!(
            parse_args(&application),
            Err(WorkerError::new("unknown_or_duplicate_argument", 2))
        );
    }

    #[test]
    fn worker_cli_rejects_invalid_session_generation_gpu_and_workspace() {
        for args in [
            strings(&[
                "--session-id",
                "../provider",
                "--generation",
                "1",
                "--gpu-uuid",
                GPU,
                "--workspace",
                "cloud-desktop",
            ]),
            strings(&[
                "--session-id",
                "sess-1",
                "--generation",
                "0",
                "--gpu-uuid",
                GPU,
                "--workspace",
                "cloud-desktop",
            ]),
            strings(&[
                "--session-id",
                "sess-1",
                "--generation",
                "1",
                "--gpu-uuid",
                "GPU-EXACT",
                "--workspace",
                "cloud-desktop",
            ]),
            strings(&[
                "--session-id",
                "sess-1",
                "--generation",
                "1",
                "--gpu-uuid",
                GPU,
                "--workspace",
                "developer",
            ]),
        ] {
            assert!(parse_args(&args).is_err());
        }
    }

    #[test]
    fn typed_input_mapping_has_no_arbitrary_message_surface() {
        assert_eq!(
            platform_input(WorkerInputEvent::KeyScan {
                scan_code: 30,
                key_up: false,
                extended: false,
            }),
            PlatformInputEvent::KeyScan {
                scan_code: 30,
                key_up: false,
                extended: false,
            }
        );
        assert_eq!(
            platform_input(WorkerInputEvent::MouseButton {
                button: WorkerMouseButton::Left,
                key_up: true,
            }),
            PlatformInputEvent::MouseButton {
                button: PlatformMouseButton::Left,
                key_up: true,
            }
        );
    }

    #[test]
    fn media_state_machine_rejects_out_of_order_and_requires_fresh_resume() {
        assert_eq!(
            MediaState::Empty.capture(),
            Err(WorkerError::new("display_not_prepared", 21))
        );
        let prepared = MediaState::Empty.prepare().expect("prepare");
        let ready = prepared.capture().expect("capture");
        let suspended = ready.suspend().expect("suspend");
        assert_eq!(
            suspended.capture(),
            Err(WorkerError::new(
                "media_suspended_requires_fresh_resume",
                21
            ))
        );
        assert_eq!(
            suspended.prepare(),
            Err(WorkerError::new("media_state_prepare_invalid", 21))
        );
        assert_eq!(suspended.resume(), Ok(MediaState::Ready));
        assert_eq!(
            MediaState::Ready.resume(),
            Err(WorkerError::new("media_not_suspended", 21))
        );
    }

    #[test]
    fn media_failure_codes_are_specific_and_secret_free() {
        for (error, expected) in [
            (MediaProbeError::CaptureTimeout, "media_capture_timeout"),
            (
                MediaProbeError::CaptureAccessLost,
                "media_capture_access_lost",
            ),
            (MediaProbeError::DeviceLost, "media_device_lost"),
            (MediaProbeError::ProbeFailed, "media_frame_proof_failed"),
        ] {
            let mapped = media_probe_error(error, false);
            assert_eq!(mapped.code, expected);
            let json = error_json(mapped);
            assert!(!json.contains("GPU-"));
            assert!(!json.contains("S-1-"));
        }
        assert_eq!(
            media_probe_error(MediaProbeError::ProbeFailed, true).code,
            "resume_media_reproof_failed"
        );
    }

    #[test]
    fn build_policy_is_fail_closed_or_exactly_compiled() {
        match (BUILD_SOURCE_COMMIT, BUILD_MEDIA_SIGNER_SHA256) {
            (Some(commit), Some(signer))
                if is_lower_hex(commit, 40) && is_lower_hex(signer, 64) =>
            {
                let policy = build_policy_json().expect("configured build policy");
                assert!(policy.contains(commit));
                assert!(policy.contains(signer));
                assert!(!policy.contains("GPU-"));
                assert!(!policy.contains("S-1-"));
            }
            _ => assert!(build_policy_json().is_err()),
        }
    }

    #[test]
    fn errors_never_echo_identity_inputs() {
        let error = WorkerError::new("worker_pipe_connect_failed", 21);
        let output = error_json(error);
        assert!(!output.contains("sess-"));
        assert!(!output.contains("GPU-"));
        assert!(output.contains("worker_pipe_connect_failed"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_round_trip_proves_pipe_and_application_fencing() {
        use gpubnb_windows_platform::pipe::{
            create_worker_pipe, current_process_logon_sid, current_process_user_sid,
        };
        use gpubnb_windows_stream_helper::worker_protocol::{
            WorkerCommand, WorkerCommandFrame, WorkerFence, decode_and_validate_worker_hello,
            decode_worker_command, encode_worker_command, validate_worker_command,
        };

        let service_sid = current_process_user_sid().expect("service SID");
        let logon_sid = current_process_logon_sid().expect("logon SID");
        let windows_session_id = current_process_session_id().expect("WTS session");
        let generation = 77u64;
        let session_id = "ci-worker-roundtrip";
        let expected_pid = std::process::id();

        let pipe = create_worker_pipe(session_id, generation, &service_sid, &logon_sid)
            .expect("secure worker pipe");

        let gpu = GPU.to_owned();
        let client = std::thread::spawn(move || {
            let client = connect_worker_pipe_client(session_id, generation, PIPE_TIMEOUT_MS)
                .expect("connect worker pipe");
            let hello = WorkerHello {
                protocol_version: WORKER_PROTOCOL_VERSION,
                session_id,
                gpu_uuid: &gpu,
                workspace: WorkspaceKind::CloudDesktop,
                generation,
                windows_session_id,
                worker_pid: std::process::id(),
            };
            let frame = encode_worker_hello(hello).expect("encode worker hello");
            client.send_frame(&frame).expect("send worker hello");

            let command = client.read_frame(PIPE_TIMEOUT_MS).expect("read command");
            let command = decode_worker_command(&command).expect("decode command");
            assert_eq!(
                validate_worker_command(generation, 1, command),
                Ok(WorkerCommand::Stop)
            );
        });

        let peer = pipe
            .accept_verified_client(&logon_sid, expected_pid, PIPE_TIMEOUT_MS)
            .expect("verify pipe peer");
        assert_eq!(peer.process_id, expected_pid);

        let frame = pipe.read_frame(PIPE_TIMEOUT_MS).expect("read worker hello");
        let expected = WorkerFence {
            session_id,
            gpu_uuid: GPU,
            workspace: WorkspaceKind::CloudDesktop,
            generation,
            windows_session_id,
            worker_pid: expected_pid,
        };
        let hello =
            decode_and_validate_worker_hello(expected, &frame).expect("validate worker hello");
        assert_eq!(hello.worker_pid, expected_pid);
        assert_eq!(hello.windows_session_id, windows_session_id);

        let command = encode_worker_command(WorkerCommandFrame {
            protocol_version: WORKER_PROTOCOL_VERSION,
            command: WorkerCommand::Stop,
            generation,
            sequence: 1,
        })
        .expect("encode stop command");
        pipe.send_frame(&command).expect("send stop command");

        client.join().expect("client thread");
    }

    #[test]
    fn bootstrap_worker_never_reports_success_off_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let parsed = parse_args(&valid_args()).expect("valid worker args");
            assert_eq!(
                execute(&parsed),
                Err(WorkerError::new("windows_required", 20))
            );
        }
    }
}
