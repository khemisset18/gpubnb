//! Maps platform capture outcomes to fail-closed lifecycle transitions.

use crate::lifecycle::{NativeSessionState, SessionEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureOutcome {
    FrameAcquired,
    WaitTimeout,
    AccessLost,
    DeviceRemoved,
    WorkerDisconnected,
}

pub fn apply_capture_outcome(state: &mut NativeSessionState, outcome: CaptureOutcome) {
    match outcome {
        CaptureOutcome::FrameAcquired | CaptureOutcome::WaitTimeout => {}
        CaptureOutcome::AccessLost => state.apply(SessionEvent::DxgiAccessLost),
        CaptureOutcome::DeviceRemoved => state.apply(SessionEvent::ExactGpuLost),
        CaptureOutcome::WorkerDisconnected => state.apply(SessionEvent::IsolationLost),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{ReadinessProof, SessionPhase, WorkspaceKind};

    fn ready_state() -> NativeSessionState {
        let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
        state.apply(SessionEvent::ProofsUpdated(ReadinessProof {
            isolated_session: true,
            virtual_display: true,
            provider_desktop_excluded: true,
            exact_gpu_bound: true,
            capture_ready: true,
            nvenc_ready: true,
            media_ready: true,
            input_isolated: true,
            audio_ready: false,
            controller_ready: false,
        }));
        state
    }

    #[test]
    fn wait_timeout_does_not_revoke_a_healthy_session() {
        let mut state = ready_state();
        apply_capture_outcome(&mut state, CaptureOutcome::WaitTimeout);
        assert_eq!(state.phase(), SessionPhase::Ready);
        assert!(state.billable());
    }

    #[test]
    fn access_lost_revokes_ready_until_full_reproof() {
        let mut state = ready_state();
        apply_capture_outcome(&mut state, CaptureOutcome::AccessLost);
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.billable());

        apply_capture_outcome(&mut state, CaptureOutcome::FrameAcquired);
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.billable());
    }

    #[test]
    fn device_removal_revokes_exact_gpu_and_media() {
        let mut state = ready_state();
        apply_capture_outcome(&mut state, CaptureOutcome::DeviceRemoved);
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.proof().exact_gpu_bound);
        assert!(!state.proof().media_ready);
        assert!(!state.billable());
    }

    #[test]
    fn worker_disconnect_revokes_isolation_and_media() {
        let mut state = ready_state();
        apply_capture_outcome(&mut state, CaptureOutcome::WorkerDisconnected);
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.proof().isolated_session);
        assert!(!state.proof().provider_desktop_excluded);
        assert!(!state.proof().input_isolated);
        assert!(!state.billable());
    }
}
