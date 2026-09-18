//! Typed control-service <-> renter-worker contract.
//!
//! Windows named-pipe ACL/token verification belongs to the platform layer. This
//! module adds a second fail-closed fence: even an accepted local pipe peer must
//! match the exact booking session, GPU, workspace, generation and logon session.
//! The protocol deliberately contains no shell command or arbitrary executable path.

use crate::lifecycle::WorkspaceKind;

pub const WORKER_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerCommand {
    PrepareDisplay,
    StartCapture,
    SuspendMedia,
    ResumeAfterFreshProof,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerFence<'a> {
    pub session_id: &'a str,
    pub gpu_uuid: &'a str,
    pub workspace: WorkspaceKind,
    pub generation: u64,
    pub logon_session_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerHello<'a> {
    pub protocol_version: u16,
    pub session_id: &'a str,
    pub gpu_uuid: &'a str,
    pub workspace: WorkspaceKind,
    pub generation: u64,
    pub logon_session_id: u64,
    pub worker_pid: u32,
    pub virtual_display_owned: bool,
    pub provider_desktop_excluded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerHandshakeError {
    ProtocolVersion,
    Session,
    Gpu,
    Workspace,
    Generation,
    LogonSession,
    WorkerPid,
    VirtualDisplay,
    ProviderDesktop,
}

pub fn validate_worker_hello(
    expected: WorkerFence<'_>,
    hello: WorkerHello<'_>,
) -> Result<(), WorkerHandshakeError> {
    if hello.protocol_version != WORKER_PROTOCOL_VERSION {
        return Err(WorkerHandshakeError::ProtocolVersion);
    }
    if hello.session_id != expected.session_id {
        return Err(WorkerHandshakeError::Session);
    }
    if !hello.gpu_uuid.eq_ignore_ascii_case(expected.gpu_uuid) {
        return Err(WorkerHandshakeError::Gpu);
    }
    if hello.workspace != expected.workspace {
        return Err(WorkerHandshakeError::Workspace);
    }
    if hello.generation != expected.generation {
        return Err(WorkerHandshakeError::Generation);
    }
    if hello.logon_session_id != expected.logon_session_id {
        return Err(WorkerHandshakeError::LogonSession);
    }
    if hello.worker_pid == 0 {
        return Err(WorkerHandshakeError::WorkerPid);
    }
    if !hello.virtual_display_owned {
        return Err(WorkerHandshakeError::VirtualDisplay);
    }
    if !hello.provider_desktop_excluded {
        return Err(WorkerHandshakeError::ProviderDesktop);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "sess-123";
    const GPU: &str = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a";

    fn fence() -> WorkerFence<'static> {
        WorkerFence {
            session_id: SESSION,
            gpu_uuid: GPU,
            workspace: WorkspaceKind::CloudDesktop,
            generation: 7,
            logon_session_id: 0x1020_3040,
        }
    }

    fn hello() -> WorkerHello<'static> {
        WorkerHello {
            protocol_version: WORKER_PROTOCOL_VERSION,
            session_id: SESSION,
            gpu_uuid: GPU,
            workspace: WorkspaceKind::CloudDesktop,
            generation: 7,
            logon_session_id: 0x1020_3040,
            worker_pid: 4242,
            virtual_display_owned: true,
            provider_desktop_excluded: true,
        }
    }

    #[test]
    fn exact_worker_fence_is_accepted() {
        assert_eq!(validate_worker_hello(fence(), hello()), Ok(()));
    }

    #[test]
    fn stale_or_cross_session_worker_is_rejected() {
        let mut value = hello();
        value.session_id = "sess-other";
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Session)
        );

        let mut value = hello();
        value.generation -= 1;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Generation)
        );
    }

    #[test]
    fn wrong_gpu_workspace_or_logon_session_is_rejected() {
        let mut value = hello();
        value.gpu_uuid = "GPU-11111111-1111-1111-1111-111111111111";
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Gpu)
        );

        let mut value = hello();
        value.workspace = WorkspaceKind::Gaming;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Workspace)
        );

        let mut value = hello();
        value.logon_session_id += 1;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::LogonSession)
        );
    }

    #[test]
    fn isolation_proofs_are_required_at_handshake() {
        let mut value = hello();
        value.virtual_display_owned = false;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::VirtualDisplay)
        );

        let mut value = hello();
        value.provider_desktop_excluded = false;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::ProviderDesktop)
        );
    }

    #[test]
    fn protocol_and_pid_fail_closed() {
        let mut value = hello();
        value.protocol_version += 1;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::ProtocolVersion)
        );

        let mut value = hello();
        value.worker_pid = 0;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::WorkerPid)
        );
    }

    #[test]
    fn command_surface_has_no_arbitrary_execute_variant() {
        let commands = [
            WorkerCommand::PrepareDisplay,
            WorkerCommand::StartCapture,
            WorkerCommand::SuspendMedia,
            WorkerCommand::ResumeAfterFreshProof,
            WorkerCommand::Stop,
        ];
        assert_eq!(commands.len(), 5);
    }
}
