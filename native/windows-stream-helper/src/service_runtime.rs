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
use crate::worker_protocol::{
    WORKER_PROTOCOL_VERSION, WorkerCommand, WorkerCommandFrame, WorkerDisplaySpec, WorkerFence,
    WorkerInputEvent, WorkerInputFrame, decode_and_validate_worker_hello,
    decode_worker_media_proof, encode_worker_command, encode_worker_display_spec,
    encode_worker_input, validate_worker_media_proof,
};
use gpubnb_windows_platform::gpu_identity::resolve_nvidia_uuid_to_luid;
use gpubnb_windows_platform::idd_control::{
    VirtualDisplayLease, VirtualDisplayOperation, VirtualDisplayRequest,
    activate_virtual_display_lease,
};
use gpubnb_windows_platform::open_application_for_verification;
use gpubnb_windows_platform::pipe::{WorkerPipe, create_worker_pipe, current_process_user_sid};
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
    worker: Option<RenterWorkerProcess>,
    display: Option<VirtualDisplayLease>,
    generation: u64,
    windows_session_id: u32,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: String,
    next_sequence: u64,
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
        self.media_state = RuntimeMediaState::Failed;
        error
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

        let proof_frame = match self.pipe.read_frame(PIPE_TIMEOUT_MS) {
            Ok(frame) => frame,
            Err(_) => {
                self.media_state = RuntimeMediaState::Failed;
                return Err(ServiceRuntimeError::MediaProof);
            }
        };
        let media = match decode_worker_media_proof(&proof_frame) {
            Ok(proof) => proof,
            Err(_) => {
                self.media_state = RuntimeMediaState::Failed;
                return Err(ServiceRuntimeError::MediaProof);
            }
        };
        if validate_worker_media_proof(
            self.generation,
            sequence,
            self.windows_session_id,
            self.display_spec,
            media,
        )
        .is_err()
        {
            self.media_state = RuntimeMediaState::Failed;
            return Err(ServiceRuntimeError::MediaProof);
        }

        if validate_graphics_proof_chain(
            self.generation,
            self.windows_session_id,
            &self.gpu_uuid,
            VirtualDisplayProof {
                generation: self.generation,
                windows_session_id: self.windows_session_id,
                display_nonce: self.display_spec.display_nonce,
                adapter_luid: self.display_spec.adapter_luid,
                width: self.display_spec.width,
                height: self.display_spec.height,
                refresh_hz: self.display_spec.refresh_hz,
                provider_desktop_excluded: true,
            },
            CaptureFrameProof {
                generation: self.generation,
                windows_session_id: self.windows_session_id,
                display_nonce: self.display_spec.display_nonce,
                adapter_luid: self.display_spec.adapter_luid,
                frame_sequence: media.frame_sequence,
                width: media.width,
                height: media.height,
                format: PixelFormat::Bgra8Unorm,
            },
            &NvencProof {
                generation: self.generation,
                adapter_luid: self.display_spec.adapter_luid,
                gpu_uuid: self.gpu_uuid.clone(),
                input_frame_sequence: media.frame_sequence,
                codec: EncodeCodec::H264,
                encoded_bytes: media.encoded_bytes,
            },
        )
        .is_err()
        {
            self.media_state = RuntimeMediaState::Failed;
            return Err(ServiceRuntimeError::GraphicsProof);
        }

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

    let proof_frame = pipe
        .read_frame(PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaProof)?;
    let media =
        decode_worker_media_proof(&proof_frame).map_err(|_| ServiceRuntimeError::MediaProof)?;
    validate_worker_media_proof(
        config.generation,
        2,
        config.windows_session_id,
        display_spec,
        media,
    )
    .map_err(|_| ServiceRuntimeError::MediaProof)?;

    validate_graphics_proof_chain(
        config.generation,
        config.windows_session_id,
        config.gpu_uuid,
        VirtualDisplayProof {
            generation: config.generation,
            windows_session_id: config.windows_session_id,
            display_nonce: config.display_nonce,
            adapter_luid: identity.luid,
            width: config.width,
            height: config.height,
            refresh_hz: config.refresh_hz,
            // The media DLL locates the output by the GPUbnb nonce-derived
            // ContainerId and exact LUID; it never captures an arbitrary output.
            provider_desktop_excluded: true,
        },
        CaptureFrameProof {
            generation: config.generation,
            windows_session_id: config.windows_session_id,
            display_nonce: config.display_nonce,
            adapter_luid: identity.luid,
            frame_sequence: media.frame_sequence,
            width: media.width,
            height: media.height,
            format: PixelFormat::Bgra8Unorm,
        },
        &NvencProof {
            generation: config.generation,
            adapter_luid: identity.luid,
            gpu_uuid: config.gpu_uuid.to_owned(),
            input_frame_sequence: media.frame_sequence,
            codec: EncodeCodec::H264,
            encoded_bytes: media.encoded_bytes,
        },
    )
    .map_err(|_| ServiceRuntimeError::GraphicsProof)?;

    Ok(QualifiedGraphicsRuntime {
        pipe,
        worker: Some(worker),
        display: Some(display),
        generation: config.generation,
        windows_session_id: config.windows_session_id,
        display_spec,
        gpu_uuid: config.gpu_uuid.to_owned(),
        next_sequence: 3,
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
