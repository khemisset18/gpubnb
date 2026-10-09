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
    WORKER_MEDIA_DIAGNOSTIC_FRAME_SIZE, WORKER_MEDIA_POLL_FRAME_SIZE, WORKER_PROTOCOL_VERSION,
    WorkerCommand, WorkerCommandFrame, WorkerDisplaySpec, WorkerFence, WorkerInputEvent,
    WorkerInputFrame, WorkerMediaPollStatus, WorkerMediaProof, decode_and_validate_worker_hello,
    decode_worker_media_diagnostic, decode_worker_media_poll, decode_worker_media_proof,
    encode_worker_command, encode_worker_display_spec, encode_worker_input,
    validate_worker_media_diagnostic, validate_worker_media_poll, validate_worker_media_proof,
};
use gpubnb_windows_platform::PlatformError;
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
use gpubnb_windows_platform::secret::MediaCapabilityToken;
use gpubnb_windows_platform::session::{
    RenterSessionIsolationProof, ensure_provider_process_absent, query_renter_session_token,
};
use std::path::Path;

const WORKER_PATH: &str = r"C:\Program Files\GPUbnb\gpubnb-windows-worker.exe";
const PIPE_TIMEOUT_MS: u32 = 10_000;
const MEDIA_PROOF_TIMEOUT_MS: u32 = 20_000;
const _: () = assert!(MEDIA_PROOF_TIMEOUT_MS > PIPE_TIMEOUT_MS);
const STOP_TIMEOUT_MS: u32 = 5_000;
const WORKER_SIGNER_SHA256_HEX: Option<&str> = option_env!("GPUBNB_WINDOWS_WORKER_SIGNER_SHA256");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceRuntimeError {
    InvalidConfiguration,
    WorkerSignerPolicy,
    RenterSession,
    RenterSessionNotActive,
    RenterSessionNotConsole,
    RenterAnotherInteractiveSession,
    RenterProviderProcess,
    RenterTokenQuery,
    RenterTokenNotPrimary,
    RenterTokenSessionMismatch,
    RenterTokenUserMismatch,
    RenterIdentityPolicy,
    ServiceIdentity,
    Pipe,
    WorkerTrust,
    WorkerLaunch,
    WorkerHandshake,
    ExactGpu,
    VirtualDisplay,
    VirtualDisplayInterfaceQuery,
    VirtualDisplayInterfaceMissing,
    VirtualDisplayInterfaceAmbiguous,
    VirtualDisplayControlOpen,
    VirtualDisplayControl,
    VirtualDisplayGate,
    WorkerProtocol,
    MediaProof,
    MediaDiagnostic {
        failed_stage: u32,
        hresult: i32,
        nvenc_status: i32,
        proof_flags: u32,
        adapter_luid: u64,
    },
    MediaTransport,
    MediaCapability,
    GraphicsProof,
    StopUnconfirmed,
    DisplayCleanup,
}

impl ServiceRuntimeError {
    /// Stable, bounded, secret-free diagnostic class for physical qualification.
    ///
    /// Never include SIDs, GPU identifiers, tokens, paths or renter-controlled
    /// values here. The authority may return this code across its local control
    /// pipe so the Agent can distinguish fail-closed runtime classes.
    pub const fn diagnostic_code(self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "invalid_configuration",
            Self::WorkerSignerPolicy => "worker_signer_policy",
            Self::RenterSession => "renter_session",
            Self::RenterSessionNotActive => "renter_session_not_active",
            Self::RenterSessionNotConsole => "renter_session_not_console",
            Self::RenterAnotherInteractiveSession => "renter_another_interactive_session",
            Self::RenterProviderProcess => "renter_provider_process",
            Self::RenterTokenQuery => "renter_token_query",
            Self::RenterTokenNotPrimary => "renter_token_not_primary",
            Self::RenterTokenSessionMismatch => "renter_token_session_mismatch",
            Self::RenterTokenUserMismatch => "renter_token_user_mismatch",
            Self::RenterIdentityPolicy => "renter_identity_policy",
            Self::ServiceIdentity => "service_identity",
            Self::Pipe => "pipe",
            Self::WorkerTrust => "worker_trust",
            Self::WorkerLaunch => "worker_launch",
            Self::WorkerHandshake => "worker_handshake",
            Self::ExactGpu => "exact_gpu",
            Self::VirtualDisplay => "virtual_display",
            Self::VirtualDisplayInterfaceQuery => "virtual_display_interface_query",
            Self::VirtualDisplayInterfaceMissing => "virtual_display_interface_missing",
            Self::VirtualDisplayInterfaceAmbiguous => "virtual_display_interface_ambiguous",
            Self::VirtualDisplayControlOpen => "virtual_display_control_open",
            Self::VirtualDisplayControl => "virtual_display_control",
            Self::VirtualDisplayGate => "virtual_display_gate",
            Self::WorkerProtocol => "worker_protocol",
            Self::MediaProof => "media_proof",
            Self::MediaDiagnostic { .. } => "media_diagnostic",
            Self::MediaTransport => "media_transport",
            Self::MediaCapability => "media_capability",
            Self::GraphicsProof => "graphics_proof",
            Self::StopUnconfirmed => "stop_unconfirmed",
            Self::DisplayCleanup => "display_cleanup",
        }
    }
}

fn map_virtual_display_error(error: PlatformError) -> ServiceRuntimeError {
    match error {
        PlatformError::IddInterfaceQueryFailed => ServiceRuntimeError::VirtualDisplayInterfaceQuery,
        PlatformError::IddInterfaceMissing => ServiceRuntimeError::VirtualDisplayInterfaceMissing,
        PlatformError::IddInterfaceAmbiguous => {
            ServiceRuntimeError::VirtualDisplayInterfaceAmbiguous
        }
        PlatformError::IddControlOpenFailed => ServiceRuntimeError::VirtualDisplayControlOpen,
        PlatformError::IddControlFailed => ServiceRuntimeError::VirtualDisplayControl,
        PlatformError::IddUnsafeOperation => ServiceRuntimeError::VirtualDisplayGate,
        PlatformError::GpuGraphicsIdentityUnavailable
        | PlatformError::GpuGraphicsIdentityMismatch => ServiceRuntimeError::ExactGpu,
        _ => ServiceRuntimeError::VirtualDisplay,
    }
}

fn map_renter_session_error(error: PlatformError) -> ServiceRuntimeError {
    match error {
        PlatformError::RenterSessionNotActive => ServiceRuntimeError::RenterSessionNotActive,
        PlatformError::RenterSessionNotConsole => ServiceRuntimeError::RenterSessionNotConsole,
        PlatformError::AnotherInteractiveSessionActive => {
            ServiceRuntimeError::RenterAnotherInteractiveSession
        }
        PlatformError::ProviderProcessInRenterSession => ServiceRuntimeError::RenterProviderProcess,
        PlatformError::RenterTokenQueryFailed => ServiceRuntimeError::RenterTokenQuery,
        PlatformError::RenterTokenNotPrimary => ServiceRuntimeError::RenterTokenNotPrimary,
        PlatformError::RenterTokenSessionMismatch => {
            ServiceRuntimeError::RenterTokenSessionMismatch
        }
        PlatformError::RenterTokenUserMismatch => ServiceRuntimeError::RenterTokenUserMismatch,
        PlatformError::InvalidWindowsSessionId
        | PlatformError::InvalidRenterUserSid
        | PlatformError::RenterSystemIdentityForbidden
        | PlatformError::RenterProviderIdentityForbidden => {
            ServiceRuntimeError::RenterIdentityPolicy
        }
        _ => ServiceRuntimeError::RenterSession,
    }
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
    // Drop order is deliberate. The ephemeral browser capability is wiped first,
    // then losing the pipe wakes/fails the worker, the Job Object kills any
    // remaining worker tree, and the IddCx lease is removed.
    media_capability: Option<MediaCapabilityToken>,
    pipe: WorkerPipe,
    media_pipe: WorkerMediaPipe,
    worker: Option<RenterWorkerProcess>,
    display: Option<VirtualDisplayLease>,
    generation: u64,
    stream_epoch: u64,
    windows_session_id: u32,
    provider_user_sid: String,
    renter_isolation: RenterSessionIsolationProof,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: String,
    next_sequence: u64,
    last_frame_sequence: u64,
    pending_media_frame: Option<BoundMediaFrame>,
    media_state: RuntimeMediaState,
    last_failure: Option<ServiceRuntimeError>,
}

impl QualifiedGraphicsRuntime {
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    /// Browser-visible reconnect fence. This is independent from the secret
    /// media capability and rotates after every successful suspend/resume proof.
    pub const fn stream_epoch(&self) -> u64 {
        self.stream_epoch
    }

    pub const fn windows_session_id(&self) -> u32 {
        self.windows_session_id
    }

    pub const fn renter_isolation_proof(&self) -> RenterSessionIsolationProof {
        self.renter_isolation
    }

    pub const fn display_spec(&self) -> WorkerDisplaySpec {
        self.display_spec
    }

    pub const fn media_ready(&self) -> bool {
        matches!(self.media_state, RuntimeMediaState::Ready)
    }

    pub const fn suspended(&self) -> bool {
        matches!(self.media_state, RuntimeMediaState::Suspended)
    }

    pub const fn failed(&self) -> bool {
        matches!(self.media_state, RuntimeMediaState::Failed)
    }

    pub const fn failure_code(&self) -> Option<&'static str> {
        match self.last_failure {
            Some(error) => Some(error.diagnostic_code()),
            None => None,
        }
    }

    /// Return the current ephemeral media capability only while media is ready.
    ///
    /// The caller must never persist or log this value. Suspend/failure/stop drop
    /// and volatile-wipe the owned CNG capability before media can be resumed.
    pub fn media_token(&self) -> Option<&str> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return None;
        }
        self.media_capability
            .as_ref()
            .map(MediaCapabilityToken::as_str)
    }

    fn fail(&mut self, error: ServiceRuntimeError) -> ServiceRuntimeError {
        self.media_capability.take();
        self.pending_media_frame = None;
        self.media_state = RuntimeMediaState::Failed;
        self.last_failure = Some(error);
        error
    }

    fn ensure_provider_boundary(&mut self) -> Result<(), ServiceRuntimeError> {
        if let Err(error) =
            ensure_provider_process_absent(self.windows_session_id, &self.provider_user_sid)
        {
            return Err(self.fail(map_renter_session_error(error)));
        }
        Ok(())
    }

    pub fn take_fresh_media_frame(&mut self) -> Option<BoundMediaFrame> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return None;
        }
        if self.ensure_provider_boundary().is_err() {
            return None;
        }
        self.pending_media_frame.take()
    }

    pub fn read_media_frame(&mut self) -> Result<Option<BoundMediaFrame>, ServiceRuntimeError> {
        if !matches!(self.media_state, RuntimeMediaState::Ready) {
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        self.ensure_provider_boundary()?;
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
            MediaFrameBinding {
                generation: self.generation,
                command_sequence: sequence,
                windows_session_id: self.windows_session_id,
                provider_user_sid: &self.provider_user_sid,
                display_spec: self.display_spec,
                gpu_uuid: &self.gpu_uuid,
            },
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
        self.ensure_provider_boundary()?;
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
            return Err(self.fail(ServiceRuntimeError::WorkerProtocol));
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
        // Revocation precedes the suspended state. Dropping the token performs
        // the platform crate's volatile wipe, so reconnect can never reuse it.
        self.media_capability.take();
        self.pending_media_frame = None;
        self.last_frame_sequence = 0;
        self.media_state = RuntimeMediaState::Suspended;
        Ok(())
    }

    pub fn resume_after_fresh_proof(&mut self) -> Result<(), ServiceRuntimeError> {
        if !matches!(self.media_state, RuntimeMediaState::Suspended) {
            return Err(ServiceRuntimeError::WorkerProtocol);
        }
        self.ensure_provider_boundary()?;
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
            MediaFrameBinding {
                generation: self.generation,
                command_sequence: sequence,
                windows_session_id: self.windows_session_id,
                provider_user_sid: &self.provider_user_sid,
                display_spec: self.display_spec,
                gpu_uuid: &self.gpu_uuid,
            },
        ) {
            Ok(frame) => frame,
            Err(error) => return Err(self.fail(error)),
        };
        if !frame.is_keyframe() {
            return Err(self.fail(ServiceRuntimeError::MediaTransport));
        }
        let media_capability = match MediaCapabilityToken::generate() {
            Ok(token) => token,
            Err(_) => return Err(self.fail(ServiceRuntimeError::MediaCapability)),
        };
        // Rotate the browser-visible epoch independently from the secret token.
        // A connection authenticated before SUSPEND must not become usable again
        // merely because the media thread missed the short Suspended state.
        let stream_epoch = match next_stream_epoch(self.stream_epoch) {
            Ok(value) => value,
            Err(error) => return Err(self.fail(error)),
        };
        self.last_frame_sequence = frame.header.frame_sequence;
        self.pending_media_frame = Some(frame);
        self.media_capability = Some(media_capability);
        self.stream_epoch = stream_epoch;
        self.media_state = RuntimeMediaState::Ready;
        Ok(())
    }

    pub fn stop(mut self) -> Result<(), ServiceRuntimeError> {
        // Revoke browser authority before waiting for the worker or display
        // cleanup. A stalled stop must not leave an old media token usable.
        self.media_capability.take();
        self.pending_media_frame = None;
        self.media_state = RuntimeMediaState::Failed;

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

#[derive(Clone, Copy)]
struct MediaFrameBinding<'a> {
    generation: u64,
    command_sequence: u64,
    windows_session_id: u32,
    provider_user_sid: &'a str,
    display_spec: WorkerDisplaySpec,
    gpu_uuid: &'a str,
}

fn receive_bound_media_frame(
    pipe: &WorkerPipe,
    media_pipe: &WorkerMediaPipe,
    binding: MediaFrameBinding<'_>,
) -> Result<BoundMediaFrame, ServiceRuntimeError> {
    let proof_frame = pipe
        .read_frame(MEDIA_PROOF_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaProof)?;
    receive_bound_media_frame_after_proof(&proof_frame, media_pipe, binding)
}

fn receive_polled_media_frame(
    pipe: &WorkerPipe,
    media_pipe: &WorkerMediaPipe,
    binding: MediaFrameBinding<'_>,
) -> Result<Option<BoundMediaFrame>, ServiceRuntimeError> {
    let control_frame = pipe
        .read_frame(PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaProof)?;

    if control_frame.len() == WORKER_MEDIA_POLL_FRAME_SIZE {
        let poll = decode_worker_media_poll(&control_frame)
            .map_err(|_| ServiceRuntimeError::MediaProof)?;
        let status = validate_worker_media_poll(
            binding.generation,
            binding.command_sequence,
            binding.windows_session_id,
            poll,
        )
        .map_err(|_| ServiceRuntimeError::MediaProof)?;

        // A no-frame timeout is benign only while the exact leased GPU still maps
        // to the render adapter. Structural capture/device failures never use this
        // status and remain terminal in the worker.
        let identity = resolve_nvidia_uuid_to_luid(binding.gpu_uuid)
            .map_err(|_| ServiceRuntimeError::ExactGpu)?;
        if identity.luid != binding.display_spec.adapter_luid {
            return Err(ServiceRuntimeError::ExactGpu);
        }

        return match status {
            WorkerMediaPollStatus::NoFrame => Ok(None),
        };
    }

    receive_bound_media_frame_after_proof(&control_frame, media_pipe, binding).map(Some)
}

fn receive_bound_media_frame_after_proof(
    proof_frame: &[u8],
    media_pipe: &WorkerMediaPipe,
    binding: MediaFrameBinding<'_>,
) -> Result<BoundMediaFrame, ServiceRuntimeError> {
    if proof_frame.len() == WORKER_MEDIA_DIAGNOSTIC_FRAME_SIZE {
        let diagnostic = decode_worker_media_diagnostic(proof_frame)
            .map_err(|_| ServiceRuntimeError::MediaProof)?;
        let diagnostic = validate_worker_media_diagnostic(
            binding.generation,
            binding.command_sequence,
            binding.windows_session_id,
            binding.display_spec.adapter_luid,
            diagnostic,
        )
        .map_err(|_| ServiceRuntimeError::MediaProof)?;
        return Err(ServiceRuntimeError::MediaDiagnostic {
            failed_stage: diagnostic.failed_stage,
            hresult: diagnostic.hresult,
            nvenc_status: diagnostic.nvenc_status,
            proof_flags: diagnostic.proof_flags,
            adapter_luid: diagnostic.adapter_luid,
        });
    }

    let proof: WorkerMediaProof =
        decode_worker_media_proof(proof_frame).map_err(|_| ServiceRuntimeError::MediaProof)?;
    validate_worker_media_proof(
        binding.generation,
        binding.command_sequence,
        binding.windows_session_id,
        binding.display_spec,
        proof,
    )
    .map_err(|_| ServiceRuntimeError::MediaProof)?;

    let header_bytes = media_pipe
        .read_message_exact(MEDIA_FRAME_HEADER_SIZE, PIPE_TIMEOUT_MS)
        .map_err(|_| ServiceRuntimeError::MediaTransport)?;
    let header = decode_worker_media_frame_header(&header_bytes)
        .map_err(|_| ServiceRuntimeError::MediaTransport)?;
    validate_worker_media_frame_header(
        binding.generation,
        binding.command_sequence,
        binding.windows_session_id,
        binding.display_spec,
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
        resolve_nvidia_uuid_to_luid(binding.gpu_uuid).map_err(|_| ServiceRuntimeError::ExactGpu)?;
    if identity.luid != binding.display_spec.adapter_luid {
        return Err(ServiceRuntimeError::ExactGpu);
    }

    let provider_desktop_excluded =
        ensure_provider_process_absent(binding.windows_session_id, binding.provider_user_sid)
            .map(|_| true)
            .map_err(map_renter_session_error)?;

    validate_graphics_proof_chain(
        binding.generation,
        binding.windows_session_id,
        binding.gpu_uuid,
        VirtualDisplayProof {
            generation: binding.generation,
            windows_session_id: binding.windows_session_id,
            display_nonce: binding.display_spec.display_nonce,
            adapter_luid: binding.display_spec.adapter_luid,
            width: binding.display_spec.width,
            height: binding.display_spec.height,
            refresh_hz: binding.display_spec.refresh_hz,
            provider_desktop_excluded,
        },
        CaptureFrameProof {
            generation: binding.generation,
            windows_session_id: binding.windows_session_id,
            display_nonce: binding.display_spec.display_nonce,
            adapter_luid: binding.display_spec.adapter_luid,
            frame_sequence: proof.frame_sequence,
            width: proof.width,
            height: proof.height,
            format: PixelFormat::Bgra8Unorm,
        },
        &NvencProof {
            generation: binding.generation,
            adapter_luid: binding.display_spec.adapter_luid,
            gpu_uuid: binding.gpu_uuid.to_owned(),
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

fn next_stream_epoch(current: u64) -> Result<u64, ServiceRuntimeError> {
    match current.checked_add(1) {
        Some(value) if value != 0 => Ok(value),
        _ => Err(ServiceRuntimeError::MediaCapability),
    }
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
    .map_err(map_renter_session_error)?;
    let renter_isolation = renter.isolation_proof();

    let service_sid =
        current_process_user_sid().map_err(|_| ServiceRuntimeError::ServiceIdentity)?;
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
    .map_err(map_virtual_display_error)?;

    let startup = (|| -> Result<(BoundMediaFrame, MediaCapabilityToken), ServiceRuntimeError> {
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
            MediaFrameBinding {
                generation: config.generation,
                command_sequence: 2,
                windows_session_id: config.windows_session_id,
                provider_user_sid: config.provider_user_sid,
                display_spec,
                gpu_uuid: config.gpu_uuid,
            },
        )?;
        if !initial_media_frame.is_keyframe() {
            return Err(ServiceRuntimeError::MediaTransport);
        }
        let media_capability =
            MediaCapabilityToken::generate().map_err(|_| ServiceRuntimeError::MediaCapability)?;
        Ok((initial_media_frame, media_capability))
    })();

    let (initial_media_frame, media_capability) = match startup {
        Ok(value) => value,
        Err(error) => {
            // Match the established runtime teardown order even before the
            // QualifiedGraphicsRuntime value exists: revoke IPC first, kill the
            // job-owned worker tree, then remove the virtual display.
            drop(pipe);
            drop(media_pipe);
            drop(worker);
            drop(display);
            return Err(error);
        }
    };

    Ok(QualifiedGraphicsRuntime {
        media_capability: Some(media_capability),
        pipe,
        media_pipe,
        worker: Some(worker),
        display: Some(display),
        generation: config.generation,
        stream_epoch: config.generation,
        windows_session_id: config.windows_session_id,
        provider_user_sid: config.provider_user_sid.to_owned(),
        renter_isolation,
        display_spec,
        gpu_uuid: config.gpu_uuid.to_owned(),
        next_sequence: 3,
        last_frame_sequence: initial_media_frame.header.frame_sequence,
        pending_media_frame: Some(initial_media_frame),
        media_state: RuntimeMediaState::Ready,
        last_failure: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_stream_epoch_rotates_and_never_wraps_to_zero() {
        assert_eq!(next_stream_epoch(7), Ok(8));
        assert_eq!(
            next_stream_epoch(u64::MAX),
            Err(ServiceRuntimeError::MediaCapability)
        );
    }

    #[test]
    fn runtime_media_state_is_fail_closed() {
        assert!(matches!(RuntimeMediaState::Ready, RuntimeMediaState::Ready));
        assert_ne!(RuntimeMediaState::Ready, RuntimeMediaState::Suspended);
        assert_ne!(RuntimeMediaState::Suspended, RuntimeMediaState::Failed);
    }

    #[test]
    fn runtime_error_diagnostics_are_bounded_classes() {
        assert_eq!(
            ServiceRuntimeError::RenterSession.diagnostic_code(),
            "renter_session"
        );
        assert_eq!(
            ServiceRuntimeError::RenterTokenQuery.diagnostic_code(),
            "renter_token_query"
        );
        assert_eq!(
            ServiceRuntimeError::RenterTokenUserMismatch.diagnostic_code(),
            "renter_token_user_mismatch"
        );
        assert_eq!(
            ServiceRuntimeError::ServiceIdentity.diagnostic_code(),
            "service_identity"
        );
        assert_eq!(
            ServiceRuntimeError::MediaTransport.diagnostic_code(),
            "media_transport"
        );
        assert_eq!(
            ServiceRuntimeError::MediaDiagnostic {
                failed_stage: 7,
                hresult: -1,
                nvenc_status: 5,
                proof_flags: 0,
                adapter_luid: 42,
            }
            .diagnostic_code(),
            "media_diagnostic"
        );
        assert_eq!(
            ServiceRuntimeError::DisplayCleanup.diagnostic_code(),
            "display_cleanup"
        );
    }

    #[test]
    fn virtual_display_platform_errors_map_to_bounded_classes() {
        assert_eq!(
            map_virtual_display_error(PlatformError::IddInterfaceQueryFailed),
            ServiceRuntimeError::VirtualDisplayInterfaceQuery
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::IddInterfaceMissing),
            ServiceRuntimeError::VirtualDisplayInterfaceMissing
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::IddInterfaceAmbiguous),
            ServiceRuntimeError::VirtualDisplayInterfaceAmbiguous
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::IddControlOpenFailed),
            ServiceRuntimeError::VirtualDisplayControlOpen
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::IddControlFailed),
            ServiceRuntimeError::VirtualDisplayControl
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::IddUnsafeOperation),
            ServiceRuntimeError::VirtualDisplayGate
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::GpuGraphicsIdentityMismatch),
            ServiceRuntimeError::ExactGpu
        );
        assert_eq!(
            map_virtual_display_error(PlatformError::PipeCreateFailed),
            ServiceRuntimeError::VirtualDisplay
        );
    }

    #[test]
    fn renter_platform_errors_map_to_bounded_classes() {
        assert_eq!(
            map_renter_session_error(PlatformError::RenterSessionNotActive),
            ServiceRuntimeError::RenterSessionNotActive
        );
        assert_eq!(
            map_renter_session_error(PlatformError::RenterSessionNotConsole),
            ServiceRuntimeError::RenterSessionNotConsole
        );
        assert_eq!(
            map_renter_session_error(PlatformError::AnotherInteractiveSessionActive),
            ServiceRuntimeError::RenterAnotherInteractiveSession
        );
        assert_eq!(
            map_renter_session_error(PlatformError::ProviderProcessInRenterSession),
            ServiceRuntimeError::RenterProviderProcess
        );
        assert_eq!(
            map_renter_session_error(PlatformError::RenterTokenQueryFailed),
            ServiceRuntimeError::RenterTokenQuery
        );
        assert_eq!(
            map_renter_session_error(PlatformError::RenterTokenNotPrimary),
            ServiceRuntimeError::RenterTokenNotPrimary
        );
        assert_eq!(
            map_renter_session_error(PlatformError::RenterTokenSessionMismatch),
            ServiceRuntimeError::RenterTokenSessionMismatch
        );
        assert_eq!(
            map_renter_session_error(PlatformError::RenterTokenUserMismatch),
            ServiceRuntimeError::RenterTokenUserMismatch
        );
        assert_eq!(
            map_renter_session_error(PlatformError::InvalidRenterUserSid),
            ServiceRuntimeError::RenterIdentityPolicy
        );
        assert_eq!(
            map_renter_session_error(PlatformError::PipeCreateFailed),
            ServiceRuntimeError::RenterSession
        );
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
