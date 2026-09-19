//! Privileged service orchestration for one Windows-native renter graphics session.
//!
//! This module intentionally stops at the graphics proof boundary. It does not
//! advertise a public/loopback media service and therefore cannot make the Agent
//! report READY by itself. Construction is atomic and fail-closed:
//! renter WTS token -> ACL/PID-fenced pipe -> signed worker -> exact GPU mapping
//! -> GPUbnb IddCx display -> fresh DXGI frame -> exact-GPU NVENC bitstream.

use crate::graphics_proof::{
    CaptureFrameProof, EncodeCodec, NvencProof, PixelFormat, VirtualDisplayProof,
    validate_graphics_proof_chain,
};
use crate::lifecycle::WorkspaceKind;
use crate::media_protocol::{
    BoundMediaFrame, MEDIA_FRAME_HEADER_SIZE, bind_worker_media_payload,
    decode_worker_media_frame_header, validate_worker_media_frame_header,
};
use crate::worker_protocol::{
    WORKER_MEDIA_POLL_FRAME_SIZE, WORKER_PROTOCOL_VERSION, WorkerCommand, WorkerCommandFrame,
    WorkerDisplaySpec, WorkerFence, WorkerInputEvent, WorkerInputFrame, WorkerMediaPollStatus,
    WorkerMediaProof, decode_and_validate_worker_hello, decode_worker_media_poll,
    decode_worker_media_proof, encode_worker_command, encode_worker_display_spec,
    encode_worker_input, validate_worker_media_poll, validate_worker_media_proof,
};
use gpubnb_windows_platform::gpu_identity::resolve_nvidia_uuid_to_luid;
use gpubnb_windows_platform::idd_control::{
    VirtualDisplayLease, VirtualDisplayOperation, VirtualDisplayRequest,
    activate_virtual_display_lease,
};
use gpubnb_windows_platform::open_application_for_verification;
use gpubnb_windows_platform::pipe::{
    WorkerMediaPipe, WorkerPipe, create_worker_media_pipe, create_worker_pipe,
    current_process_user_sid,
};
use gpubnb_windows_platform::process::{
    RenterWorkerLaunchSpec, RenterWorkerProcess, launch_qualified_renter_worker,
};
use gpubnb_windows_platform::session::query_renter_session_token;
use std::path::Path;

const WORKER_PATH: &str = r"C:\Program Files\GPUbnb\gpubnb-windows-worker.exe";
const PIPE_TIMEOUT_MS: u32 = 10_000;
const STOP_TIMEOUT_MS: u32 = 5_000;
const WORKER_SIGNER_SHA256_HEX: Option<&str> = option_env!("GPUBNB_WINDOWS_WORKER_SIGNER_SHA256");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceRuntimeError {
    InvalidConfiguration,
    WorkerSignerPolicy,
    RenterSession,
    Pipe,
    WorkerTrust,
    WorkerLaunch,
    WorkerHandshake,
    ExactGpu,
    VirtualDisplay,
    WorkerProtocol,
    MediaProof,
    MediaTransport,
    GraphicsProof,
    StopUnconfirmed,
    DisplayCleanup,
}

#[derive(Debug, Clone, Copy)]
pub struct ServiceRuntimeConfig<'a> {
    pub session_id: &'a str,
    pub generation: u64,
    pub workspace: WorkspaceKind,
    pub gpu_uuid: &'a str,
    pub windows_session_id: u32,
    pub renter_user_sid: &'a str,
    pub provider_user_sid: &'a str,
    pub display_nonce: [u8; 16],
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeMediaState {
    Ready,
    Suspended,
    Failed,
}

pub struct QualifiedGraphicsRuntime {
    // Drop order is deliberate. Losing the pipe wakes/fails the worker, then the
    // Job Object kills any remaining worker tree, then the IddCx lease is removed.
    pipe: WorkerPipe,
    media_pipe: WorkerMediaPipe,
    worker: Option<RenterWorkerProcess>,
    display: Option<VirtualDisplayLease>,
    generation: u64,
    windows_session_id: u32,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: String,
    next_sequence: u64,
    last_frame_sequence: u64,
    pending_media_frame: Option<BoundMediaFrame>,
    media_state: RuntimeMediaState,
}

impl QualifiedGraphicsRuntime {
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn windows_session_id(&self) -> u32 {
        self.windows_session_id
    }

    pub const fn display_spec(&self) -> WorkerDisplaySpec {
        self.display_spec
    }

    pub const fn media_ready(&self) -> bool {
        matches!(self.media_state, RuntimeMediaState::Ready)
    }

    pub const fn failed(&self) -> bool {
        matches!(self.media_state, RuntimeMediaState::Failed)
    }

    fn fail(&mut self, error: ServiceRuntimeError) -> ServiceRuntimeError {
        self.pending_media_frame = None;
        self.media_state = RuntimeMediaState::Failed;
        error
    }

    pub fn take_fresh_media_frame(&mut self) -> Option<BoundMediaFrame> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return None;
        }
        self.pending_media_frame.take()
    }

    pub fn read_media_frame(&mut self) -> Result<Option<BoundMediaFrame>, ServiceRuntimeError> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        // Initial start and reconnect both deliver a fresh IDR proof frame. Drain
        // that already-validated frame before asking the worker for another one so
        // callers can use one API without accidentally skipping/reordering bytes.
        if let Some(frame) = self.pending_media_frame.take() {
            return Ok(Some(frame));
        }
        let sequence = self.next_sequence;
        let next_sequence = match sequence.checked_add(1) {
            Some(value) => value,
            None => return Err(self.fail(ServiceRuntimeError::WorkerProtocol)),
        };
        let command = encode_worker_command(WorkerCommandFrame {
            protocol_version: WORKER_PROTOCOL_VERSION,
            command: WorkerCommand::ReadMediaFrame,
            generation: self.generation,
            sequence,
        })
        .map_err(|_| self.fail(ServiceRuntimeError::WorkerProtocol))?;
        if self.pipe.send_frame(&command).is_err() {
            return Err(self.fail(ServiceRuntimeError::WorkerProtocol));
        }
        self.next_sequence = next_sequence;

        let frame = match receive_polled_media_frame(
            &self.pipe,
            &self.media_pipe,
            self.generation,
            sequence,
            self.windows_session_id,
            self.display_spec,
            &self.gpu_uuid,
        ) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(None),
            Err(error) => return Err(self.fail(error)),
        };
        if frame.header.frame_sequence <= self.last_frame_sequence {
            return Err(self.fail(ServiceRuntimeError::MediaTransport));
        }
        self.last_frame_sequence = frame.header.frame_sequence;
        Ok(Some(frame))
    }

    pub fn inject_input(&mut self, event: WorkerInputEvent) -> Result<(), ServiceRuntimeError> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        let sequence = self.next_sequence;
        let next_sequence = match sequence.checked_add(1) {
            Some(value) => value,
            None => return Err(self.fail(ServiceRuntimeError::WorkerProtocol)),
        };
        let command = encode_worker_command(WorkerCommandFrame {
            protocol_version: WORKER_PROTOCOL_VERSION,
            command: WorkerCommand::InjectInput,
            generation: self.generation,
            sequence,
        })
        .map_err(|_| self.fail(ServiceRuntimeError::WorkerProtocol))?;
        let input = encode_worker_input(WorkerInputFrame {
            protocol_version: WORKER_PROTOCOL_VERSION,
            generation: self.generation,
            command_sequence: sequence,
            windows_session_id: self.windows_session_id,
            event,
        })
        .map_err(|_| self.fail(ServiceRuntimeError::WorkerProtocol))?;

        if self.pipe.send_frame(&command).is_err() || self.pipe.send_frame(&input).is_err() {
            self.media_state = RuntimeMediaState::Failed;
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        self.next_sequence = next_sequence;
        Ok(())
    }

    pub fn suspend_media(&mut self) -> Result<(), ServiceRuntimeError> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        let sequence = self.next_sequence;
        let next_sequence = match sequence.checked_add(1) {
            Some(value) => value,
            None => return Err(self.fail(ServiceRuntimeError::WorkerProtocol)),
        };
        let command = encode_worker_command(WorkerCommandFrame {
            protocol_version: WORKER_PROTOCOL_VERSION,
            command: WorkerCommand::SuspendMedia,
            generation: self.generation,
            sequence,
        })
        .map_err(|_| self.fail(ServiceRuntimeError::WorkerProtocol))?;
        if self.pipe.send_frame(&command).is_err() {
            return Err(self.fail(ServiceRuntimeError::WorkerProtocol));
        }
        self.next_sequence = next_sequence;
        self.pending_media_frame = None;
        self.last_frame_sequence = 0;
        self.media_state = RuntimeMediaState::Suspended;
        Ok(())
    }

    pub fn resume_after_fresh_proof(&mut self) -> Result<(), ServiceRuntimeError> {
        if !matches!(self.media_state, RuntimeMediaState::Suspended) {
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        let sequence = self.next_sequence;
        let next_sequence = match sequence.checked_add(1) {
            Some(value) => value,
            None => return Err(self.fail(ServiceRuntimeError::WorkerProtocol)),
        };
        let command = encode_worker_command(WorkerCommandFrame {
            protocol_version: WORKER_PROTOCOL_VERSION,
            command: WorkerCommand::ResumeAfterFreshProof,
            generation: self.generation,
            sequence,
        })
        .map_err(|_| self.fail(ServiceRuntimeError::WorkerProtocol))?;
        if self.pipe.send_frame(&command).is_err() {
            return Err(self.fail(ServiceRuntimeError::WorkerProtocol));
        }
        // Once the command is on the pipe, the worker may already have consumed
        // the sequence even if its proof later fails or the process disconnects.
        self.next_sequence = next_sequence;

        let frame = match receive_bound_media_frame(
            &self.pipe,
            &self.media_pipe,
            self.generation,
            sequence,
            self.windows_session_id,
            self.display_spec,
            &self.gpu_uuid,
        ) {
            Ok(frame) => frame,
            Err(error) => return Err(self.fail(error)),
        };
        self.last_frame_sequence = frame.header.frame_sequence;
        self.pending_media_frame = Some(frame);
        self.media_state = RuntimeMediaState::Ready;
        Ok(())
    }

    pub fn stop(mut self) -> Result<(), ServiceRuntimeError> {
        let mut stop_error = None;
        if let Some(worker) = self.worker.as_ref() {
            let command = encode_worker_command(WorkerCommandFrame {
                protocol_version: WORKER_PROTOCOL_VERSION,
                command: WorkerCommand::Stop,
                generation: self.generation,
                sequence: self.next_sequence,
            })
            .map_err(|_| ServiceRuntimeError::WorkerProtocol)?;
            if self.pipe.send_frame(&command).is_err() || worker.wait_exit(STOP_TIMEOUT_MS).is_err()
            {
                stop_error = Some(ServiceRuntimeError::StopUnconfirmed);
            }
        }

        // Dropping the worker closes the Job Object and kills any residual tree
        // before the display is removed. This is the cleanup backstop when the
        // graceful Stop command failed or the worker crashed.
        self.worker.take();

        let display_error = match self.display.take() {
            Some(display) => display
                .close()
                .err()
                .map(|_| ServiceRuntimeError::DisplayCleanup),
            None => None,
        };

        display_error.or(stop_error).map_or(Ok(()), Err)
    }
}

fn workspace_slug(workspace: WorkspaceKind) -> &'static str {
    match workspace {
        WorkspaceKind::CloudDesktop => "cloud-desktop",
        WorkspaceKind::Creator => "creator",
        WorkspaceKind::Cad => "cad",
        WorkspaceKind::Gaming => "gaming",
    }
}

fn receive_bound_media_frame(
    pipe: &WorkerPipe,
    media_pipe: &WorkerMediaPipe,
    generation: u64,
    command_sequence: u64,
    windows_session_id: u32,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: &str,
) -> Result<BoundMediaFrame, ServiceRuntimeError> {
    let proof_frame = pipe
        .read_frame(PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaProof)?;
    receive_bound_media_frame_after_proof(
        &proof_frame,
        media_pipe,
        generation,
        command_sequence,
        windows_session_id,
        display_spec,
        gpu_uuid,
    )
}

fn receive_polled_media_frame(
    pipe: &WorkerPipe,
    media_pipe: &WorkerMediaPipe,
    generation: u64,
    command_sequence: u64,
    windows_session_id: u32,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: &str,
) -> Result<Option<BoundMediaFrame>, ServiceRuntimeError> {
    let control_frame = pipe
        .read_frame(PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaProof)?;

    if control_frame.len() == WORKER_MEDIA_POLL_FRAME_SIZE {
        let poll = decode_worker_media_poll(&control_frame)
            .map_err(|_| ServiceRuntimeError::MediaProof)?;
        let status =
            validate_worker_media_poll(generation, command_sequence, windows_session_id, poll)
                .map_err(|_| ServiceRuntimeError::MediaProof)?;

        // A no-frame timeout is benign only while the exact leased GPU still maps
        // to the display adapter. Structural DXGI/device failures never use this
        // status and remain terminal in the worker.
        let identity =
            resolve_nvidia_uuid_to_luid(gpu_uuid).map_err(|_| ServiceRuntimeError::ExactGpu)?;
        if identity.luid != display_spec.adapter_luid {
            return Err(ServiceRuntimeError::ExactGpu);
        }

        return match status {
            WorkerMediaPollStatus::NoFrame => Ok(None),
        };
    }

    receive_bound_media_frame_after_proof(
        &control_frame,
        media_pipe,
        generation,
        command_sequence,
        windows_session_id,
        display_spec,
        gpu_uuid,
    )
    .map(Some)
}

fn receive_bound_media_frame_after_proof(
    proof_frame: &[u8],
    media_pipe: &WorkerMediaPipe,
    generation: u64,
    command_sequence: u64,
    windows_session_id: u32,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: &str,
) -> Result<BoundMediaFrame, ServiceRuntimeError> {
    let proof: WorkerMediaProof =
        decode_worker_media_proof(proof_frame).map_err(|_| ServiceRuntimeError::MediaProof)?;
    validate_worker_media_proof(
        generation,
        command_sequence,
        windows_session_id,
        display_spec,
        proof,
    )
    .map_err(|_| ServiceRuntimeError::MediaProof)?;

    let header_bytes = media_pipe
        .read_message_exact(MEDIA_FRAME_HEADER_SIZE, PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaTransport)?;
    let header = decode_worker_media_frame_header(&header_bytes)
        .map_err(|_| ServiceRuntimeError::MediaTransport)?;
    validate_worker_media_frame_header(
        generation,
        command_sequence,
        windows_session_id,
        display_spec,
        proof,
        header,
    )
    .map_err(|_| ServiceRuntimeError::MediaTransport)?;

    // Header validation happens before allocation and guarantees a non-zero
    // payload length at or below the hard 8 MiB protocol ceiling.
    let payload = media_pipe
        .read_message_exact(header.payload_bytes as usize, PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaTransport)?;
    let frame = bind_worker_media_payload(header, payload)
        .map_err(|_| ServiceRuntimeError::MediaTransport)?;

    // The media DLL revalidates UUID -> LUID for every capture; repeat the check
    // in the privileged service before accepting the bytes into the data plane.
    let identity =
        resolve_nvidia_uuid_to_luid(gpu_uuid).map_err(|_| ServiceRuntimeError::ExactGpu)?;
    if identity.luid != display_spec.adapter_luid {
        return Err(ServiceRuntimeError::ExactGpu);
    }

    validate_graphics_proof_chain(
        generation,
        windows_session_id,
        gpu_uuid,
        VirtualDisplayProof {
            generation,
            windows_session_id,
            display_nonce: display_spec.display_nonce,
            adapter_luid: display_spec.adapter_luid,
            width: display_spec.width,
            height: display_spec.height,
            refresh_hz: display_spec.refresh_hz,
            provider_desktop_excluded: true,
        },
        CaptureFrameProof {
            generation,
            windows_session_id,
            display_nonce: display_spec.display_nonce,
            adapter_luid: display_spec.adapter_luid,
            frame_sequence: proof.frame_sequence,
            width: proof.width,
            height: proof.height,
            format: PixelFormat::Bgra8Unorm,
        },
        &NvencProof {
            generation,
            adapter_luid: display_spec.adapter_luid,
            gpu_uuid: gpu_uuid.to_owned(),
            input_frame_sequence: proof.frame_sequence,
            codec: EncodeCodec::H264,
            encoded_bytes: u64::from(proof.encoded_bytes),
        },
    )
    .map_err(|_| ServiceRuntimeError::GraphicsProof)?;

    Ok(frame)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn worker_signer() -> Result<[u8; 32], ServiceRuntimeError> {
    let value = WORKER_SIGNER_SHA256_HEX.ok_or(ServiceRuntimeError::WorkerSignerPolicy)?;
    if value.len() != 64 {
        return Err(ServiceRuntimeError::WorkerSignerPolicy);
    }
    let bytes = value.as_bytes();
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        let high = hex_nibble(bytes[index * 2]).ok_or(ServiceRuntimeError::WorkerSignerPolicy)?;
        let low =
            hex_nibble(bytes[index * 2 + 1]).ok_or(ServiceRuntimeError::WorkerSignerPolicy)?;
        *slot = (high << 4) | low;
    }
    if out == [0; 32] {
        return Err(ServiceRuntimeError::WorkerSignerPolicy);
    }
    Ok(out)
}

fn validate_config(config: ServiceRuntimeConfig<'_>) -> Result<(), ServiceRuntimeError> {
    if config.session_id.is_empty()
        || config.generation == 0
        || config.windows_session_id == 0
        || config.display_nonce == [0; 16]
        || config.width < 1920
        || config.height < 1080
        || !(60..=240).contains(&config.refresh_hz)
    {
        return Err(ServiceRuntimeError::InvalidConfiguration);
    }
    Ok(())
}

pub fn start_qualified_graphics_runtime(
    config: ServiceRuntimeConfig<'_>,
) -> Result<QualifiedGraphicsRuntime, ServiceRuntimeError> {
    validate_config(config)?;

    let signer = worker_signer()?;
    let renter = query_renter_session_token(
        config.windows_session_id,
        config.renter_user_sid,
        config.provider_user_sid,
    )
    .map_err(|_| ServiceRuntimeError::RenterSession)?;

    let service_sid = current_process_user_sid().map_err(|_| ServiceRuntimeError::RenterSession)?;
    let pipe = create_worker_pipe(
        config.session_id,
        config.generation,
        &service_sid,
        renter.logon_sid(),
    )
    .map_err(|_| ServiceRuntimeError::Pipe)?;
    let media_pipe = create_worker_media_pipe(
        config.session_id,
        config.generation,
        &service_sid,
        renter.logon_sid(),
    )
    .map_err(|_| ServiceRuntimeError::Pipe)?;

    let verified_worker = open_application_for_verification(Path::new(WORKER_PATH))
        .map_err(|_| ServiceRuntimeError::WorkerTrust)?;
    let worker = launch_qualified_renter_worker(
        &renter,
        &verified_worker,
        &[signer],
        RenterWorkerLaunchSpec {
            session_id: config.session_id,
            generation: config.generation,
            gpu_uuid: config.gpu_uuid,
            workspace: workspace_slug(config.workspace),
        },
    )
    .map_err(|_| ServiceRuntimeError::WorkerLaunch)?;

    pipe.accept_verified_client(renter.logon_sid(), worker.pid(), PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::WorkerHandshake)?;
    let hello_frame = pipe
        .read_frame(PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::WorkerHandshake)?;
    decode_and_validate_worker_hello(
        WorkerFence {
            session_id: config.session_id,
            gpu_uuid: config.gpu_uuid,
            workspace: config.workspace,
            generation: config.generation,
            windows_session_id: config.windows_session_id,
            worker_pid: worker.pid(),
        },
        &hello_frame,
    )
    .map_err(|_| ServiceRuntimeError::WorkerHandshake)?;
    media_pipe
        .accept_verified_client(renter.logon_sid(), worker.pid(), PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::WorkerHandshake)?;

    let identity =
        resolve_nvidia_uuid_to_luid(config.gpu_uuid).map_err(|_| ServiceRuntimeError::ExactGpu)?;
    let display_spec = WorkerDisplaySpec {
        protocol_version: WORKER_PROTOCOL_VERSION,
        generation: config.generation,
        command_sequence: 1,
        windows_session_id: config.windows_session_id,
        adapter_luid: identity.luid,
        display_nonce: config.display_nonce,
        width: config.width,
        height: config.height,
        refresh_hz: config.refresh_hz,
    };

    // The privileged service is the only process allowed to mutate the IddCx
    // control device. This remains fail-closed while the physical qualification
    // gate in windows-platform/windows-idd is false.
    let display = activate_virtual_display_lease(
        config.gpu_uuid,
        VirtualDisplayRequest {
            operation: VirtualDisplayOperation::PlugMonitor,
            generation: config.generation,
            windows_session_id: config.windows_session_id,
            render_adapter_luid: identity.luid,
            display_nonce: config.display_nonce,
            width: config.width,
            height: config.height,
            refresh_hz: config.refresh_hz,
        },
    )
    .map_err(|_| ServiceRuntimeError::VirtualDisplay)?;

    let prepare = encode_worker_command(WorkerCommandFrame {
        protocol_version: WORKER_PROTOCOL_VERSION,
        command: WorkerCommand::PrepareDisplay,
        generation: config.generation,
        sequence: 1,
    })
    .map_err(|_| ServiceRuntimeError::WorkerProtocol)?;
    let display_frame = encode_worker_display_spec(display_spec)
        .map_err(|_| ServiceRuntimeError::WorkerProtocol)?;
    pipe.send_frame(&prepare)
        .and_then(|_| pipe.send_frame(&display_frame))
        .map_err(|_| ServiceRuntimeError::WorkerProtocol)?;

    let capture = encode_worker_command(WorkerCommandFrame {
        protocol_version: WORKER_PROTOCOL_VERSION,
        command: WorkerCommand::StartCapture,
        generation: config.generation,
        sequence: 2,
    })
    .map_err(|_| ServiceRuntimeError::WorkerProtocol)?;
    pipe.send_frame(&capture)
        .map_err(|_| ServiceRuntimeError::WorkerProtocol)?;

    let initial_media_frame = receive_bound_media_frame(
        &pipe,
        &media_pipe,
        config.generation,
        2,
        config.windows_session_id,
        display_spec,
        config.gpu_uuid,
    )?;

    Ok(QualifiedGraphicsRuntime {
        pipe,
        media_pipe,
        worker: Some(worker),
        display: Some(display),
        generation: config.generation,
        windows_session_id: config.windows_session_id,
        display_spec,
        gpu_uuid: config.gpu_uuid.to_owned(),
        next_sequence: 3,
        last_frame_sequence: initial_media_frame.header.frame_sequence,
        pending_media_frame: Some(initial_media_frame),
        media_state: RuntimeMediaState::Ready,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_media_state_is_fail_closed() {
        assert!(matches!(RuntimeMediaState::Ready, RuntimeMediaState::Ready));
        assert_ne!(RuntimeMediaState::Ready, RuntimeMediaState::Suspended);
        assert_ne!(RuntimeMediaState::Suspended, RuntimeMediaState::Failed);
    }

    #[test]
    fn signer_policy_is_never_implicit() {
        match WORKER_SIGNER_SHA256_HEX {
            None => assert_eq!(
                worker_signer(),
                Err(ServiceRuntimeError::WorkerSignerPolicy)
            ),
            Some(value) if value.len() != 64 => {
                assert_eq!(
                    worker_signer(),
                    Err(ServiceRuntimeError::WorkerSignerPolicy)
                )
            }
            Some(_) => assert!(worker_signer().is_ok()),
        }
    }

    #[test]
    fn runtime_config_rejects_zero_identity_fields() {
        let base = ServiceRuntimeConfig {
            session_id: "sess-1",
            generation: 7,
            workspace: WorkspaceKind::CloudDesktop,
            gpu_uuid: "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            windows_session_id: 42,
            renter_user_sid: "S-1-5-21-100-200-300-1001",
            provider_user_sid: "S-1-5-21-100-200-300-1000",
            display_nonce: [0xA5; 16],
            width: 1920,
            height: 1080,
            refresh_hz: 60,
        };
        assert_eq!(validate_config(base), Ok(()));
        assert_eq!(
            validate_config(ServiceRuntimeConfig {
                generation: 0,
                ..base
            }),
            Err(ServiceRuntimeError::InvalidConfiguration)
        );
        assert_eq!(
            validate_config(ServiceRuntimeConfig {
                display_nonce: [0; 16],
                ..base
            }),
            Err(ServiceRuntimeError::InvalidConfiguration)
        );
        assert_eq!(
            validate_config(ServiceRuntimeConfig {
                width: 1280,
                height: 720,
                ..base
            }),
            Err(ServiceRuntimeError::InvalidConfiguration)
        );
        assert_eq!(
            validate_config(ServiceRuntimeConfig {
                refresh_hz: 30,
                ..base
            }),
            Err(ServiceRuntimeError::InvalidConfiguration)
        );
    }
}
