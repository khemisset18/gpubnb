//! Fail-closed lifecycle state machine for one Windows-native renter session.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Starting,
    Ready,
    Degraded,
    Stopping,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceKind {
    CloudDesktop,
    Creator,
    Cad,
    Gaming,
}

impl WorkspaceKind {
    const fn requires_audio(self) -> bool {
        matches!(self, Self::Gaming)
    }

    const fn requires_controller(self) -> bool {
        matches!(self, Self::Gaming)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReadinessProof {
    pub isolated_session: bool,
    pub virtual_display: bool,
    pub provider_desktop_excluded: bool,
    pub exact_gpu_bound: bool,
    pub capture_ready: bool,
    pub nvenc_ready: bool,
    pub media_ready: bool,
    pub input_isolated: bool,
    pub audio_ready: bool,
    pub controller_ready: bool,
}

impl ReadinessProof {
    pub const fn qualifies(self, workspace: WorkspaceKind) -> bool {
        self.isolated_session
            && self.virtual_display
            && self.provider_desktop_excluded
            && self.exact_gpu_bound
            && self.capture_ready
            && self.nvenc_ready
            && self.media_ready
            && self.input_isolated
            && (!workspace.requires_audio() || self.audio_ready)
            && (!workspace.requires_controller() || self.controller_ready)
    }

    pub const fn invalidate_capture_chain(&mut self) {
        self.capture_ready = false;
        self.nvenc_ready = false;
        self.media_ready = false;
    }

    pub const fn invalidate_virtual_display(&mut self) {
        self.virtual_display = false;
        self.invalidate_capture_chain();
    }

    pub const fn invalidate_gpu_binding(&mut self) {
        self.exact_gpu_bound = false;
        self.invalidate_capture_chain();
    }

    pub const fn invalidate_isolation(&mut self) {
        self.isolated_session = false;
        self.provider_desktop_excluded = false;
        self.input_isolated = false;
        self.invalidate_capture_chain();
    }

    pub const fn invalidate_worker(&mut self) {
        self.input_isolated = false;
        self.invalidate_capture_chain();
    }

    pub const fn invalidate_media_client(&mut self) {
        // A disconnected browser must never leave READY/billing armed. Require a
        // fresh capture+encode proof before reconnect can promote the session again.
        self.invalidate_capture_chain();
    }

    pub const fn can_restore_media(self, workspace: WorkspaceKind) -> bool {
        self.isolated_session
            && self.virtual_display
            && self.provider_desktop_excluded
            && self.exact_gpu_bound
            && self.input_isolated
            && (!workspace.requires_audio() || self.audio_ready)
            && (!workspace.requires_controller() || self.controller_ready)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    ProofsUpdated(ReadinessProof),
    DxgiAccessLost,
    VirtualDisplayLost,
    ExactGpuLost,
    IsolationLost,
    WorkerLost,
    NvencDeviceLost,
    BrowserDisconnected,
    MediaReproved {
        capture_ready: bool,
        nvenc_ready: bool,
        media_ready: bool,
    },
    StopRequested,
    CleanupVerified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeSessionState {
    workspace: WorkspaceKind,
    phase: SessionPhase,
    proof: ReadinessProof,
}

impl NativeSessionState {
    pub const fn new(workspace: WorkspaceKind) -> Self {
        Self {
            workspace,
            phase: SessionPhase::Starting,
            proof: ReadinessProof {
                isolated_session: false,
                virtual_display: false,
                provider_desktop_excluded: false,
                exact_gpu_bound: false,
                capture_ready: false,
                nvenc_ready: false,
                media_ready: false,
                input_isolated: false,
                audio_ready: false,
                controller_ready: false,
            },
        }
    }

    pub const fn phase(self) -> SessionPhase {
        self.phase
    }

    pub const fn proof(self) -> ReadinessProof {
        self.proof
    }

    pub const fn billable(self) -> bool {
        matches!(self.phase, SessionPhase::Ready) && self.proof.qualifies(self.workspace)
    }

    pub fn apply(&mut self, event: SessionEvent) {
        if matches!(self.phase, SessionPhase::Stopped) {
            return;
        }

        match event {
            SessionEvent::ProofsUpdated(proof) => {
                if matches!(self.phase, SessionPhase::Stopping) {
                    return;
                }

                // Once a runtime is degraded, a generic full-proof replacement is
                // not allowed to jump straight back to READY. Recovery must retain
                // the still-valid non-media invariants and supply a fresh
                // capture+NVENC+media proof through MediaReproved.
                if matches!(self.phase, SessionPhase::Degraded) {
                    return;
                }

                self.proof = proof;
                self.phase = if self.proof.qualifies(self.workspace) {
                    SessionPhase::Ready
                } else {
                    SessionPhase::Starting
                };
            }
            SessionEvent::MediaReproved {
                capture_ready,
                nvenc_ready,
                media_ready,
            } => {
                if !matches!(self.phase, SessionPhase::Degraded)
                    || !self.proof.can_restore_media(self.workspace)
                {
                    return;
                }
                self.proof.capture_ready = capture_ready;
                self.proof.nvenc_ready = nvenc_ready;
                self.proof.media_ready = media_ready;
                self.phase = if self.proof.qualifies(self.workspace) {
                    SessionPhase::Ready
                } else {
                    SessionPhase::Degraded
                };
            }
            SessionEvent::DxgiAccessLost => {
                if !matches!(self.phase, SessionPhase::Stopping) {
                    self.proof.invalidate_capture_chain();
                    self.phase = SessionPhase::Degraded;
                }
            }
            SessionEvent::VirtualDisplayLost => {
                if !matches!(self.phase, SessionPhase::Stopping) {
                    self.proof.invalidate_virtual_display();
                    self.phase = SessionPhase::Degraded;
                }
            }
            SessionEvent::ExactGpuLost => {
                if !matches!(self.phase, SessionPhase::Stopping) {
                    self.proof.invalidate_gpu_binding();
                    self.phase = SessionPhase::Degraded;
                }
            }
            SessionEvent::IsolationLost => {
                if !matches!(self.phase, SessionPhase::Stopping) {
                    self.proof.invalidate_isolation();
                    self.phase = SessionPhase::Degraded;
                }
            }
            SessionEvent::WorkerLost => {
                if !matches!(self.phase, SessionPhase::Stopping) {
                    self.proof.invalidate_worker();
                    self.phase = SessionPhase::Degraded;
                }
            }
            SessionEvent::NvencDeviceLost | SessionEvent::BrowserDisconnected => {
                if !matches!(self.phase, SessionPhase::Stopping) {
                    self.proof.invalidate_media_client();
                    self.phase = SessionPhase::Degraded;
                }
            }
            SessionEvent::StopRequested => {
                self.phase = SessionPhase::Stopping;
                self.proof.media_ready = false;
            }
            SessionEvent::CleanupVerified => {
                if matches!(self.phase, SessionPhase::Stopping) {
                    self.phase = SessionPhase::Stopped;
                    self.proof = ReadinessProof::default();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_ready() -> ReadinessProof {
        ReadinessProof {
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
        }
    }

    #[test]
    fn cloud_desktop_becomes_ready_only_with_every_shared_proof() {
        let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
        let ready = shared_ready();
        state.apply(SessionEvent::ProofsUpdated(ready));
        assert_eq!(state.phase(), SessionPhase::Ready);
        assert!(state.billable());

        let mutations: [fn(&mut ReadinessProof); 8] = [
            |proof| proof.isolated_session = false,
            |proof| proof.virtual_display = false,
            |proof| proof.provider_desktop_excluded = false,
            |proof| proof.exact_gpu_bound = false,
            |proof| proof.capture_ready = false,
            |proof| proof.nvenc_ready = false,
            |proof| proof.media_ready = false,
            |proof| proof.input_isolated = false,
        ];
        for mutate in mutations {
            let mut proof = ready;
            mutate(&mut proof);
            let mut candidate = NativeSessionState::new(WorkspaceKind::CloudDesktop);
            candidate.apply(SessionEvent::ProofsUpdated(proof));
            assert!(!candidate.billable());
            assert_ne!(candidate.phase(), SessionPhase::Ready);
        }
    }

    #[test]
    fn gaming_requires_audio_and_controller_in_addition_to_shared_proofs() {
        let mut state = NativeSessionState::new(WorkspaceKind::Gaming);
        let mut proof = shared_ready();
        state.apply(SessionEvent::ProofsUpdated(proof));
        assert!(!state.billable());

        proof.audio_ready = true;
        state.apply(SessionEvent::ProofsUpdated(proof));
        assert!(!state.billable());

        proof.controller_ready = true;
        state.apply(SessionEvent::ProofsUpdated(proof));
        assert_eq!(state.phase(), SessionPhase::Ready);
        assert!(state.billable());
    }

    #[test]
    fn dxgi_access_loss_immediately_revokes_ready_and_billing() {
        let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
        state.apply(SessionEvent::ProofsUpdated(shared_ready()));
        assert!(state.billable());

        state.apply(SessionEvent::DxgiAccessLost);
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.billable());
        assert!(!state.proof().capture_ready);
        assert!(!state.proof().nvenc_ready);
        assert!(!state.proof().media_ready);

        // A generic proof update cannot re-arm a degraded session.
        state.apply(SessionEvent::ProofsUpdated(shared_ready()));
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.billable());

        state.apply(SessionEvent::MediaReproved {
            capture_ready: true,
            nvenc_ready: true,
            media_ready: true,
        });
        assert_eq!(state.phase(), SessionPhase::Ready);
        assert!(state.billable());
    }

    #[test]
    fn virtual_display_gpu_or_isolation_loss_cannot_leave_session_ready() {
        for event in [
            SessionEvent::VirtualDisplayLost,
            SessionEvent::ExactGpuLost,
            SessionEvent::IsolationLost,
        ] {
            let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
            state.apply(SessionEvent::ProofsUpdated(shared_ready()));
            state.apply(event);
            assert_eq!(state.phase(), SessionPhase::Degraded);
            assert!(!state.billable());
            assert!(!state.proof().media_ready);
        }
    }

    #[test]
    fn worker_nvenc_or_browser_loss_immediately_revokes_ready_and_billing() {
        for event in [
            SessionEvent::WorkerLost,
            SessionEvent::NvencDeviceLost,
            SessionEvent::BrowserDisconnected,
        ] {
            let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
            state.apply(SessionEvent::ProofsUpdated(shared_ready()));
            assert!(state.billable());

            state.apply(event);
            assert_eq!(state.phase(), SessionPhase::Degraded);
            assert!(!state.billable());
            assert!(!state.proof().capture_ready);
            assert!(!state.proof().nvenc_ready);
            assert!(!state.proof().media_ready);
            if matches!(event, SessionEvent::WorkerLost) {
                assert!(!state.proof().input_isolated);
            }
        }
    }

    #[test]
    fn stop_requires_verified_cleanup_and_cannot_be_rearmed() {
        let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
        state.apply(SessionEvent::ProofsUpdated(shared_ready()));
        state.apply(SessionEvent::StopRequested);
        assert_eq!(state.phase(), SessionPhase::Stopping);
        assert!(!state.billable());

        state.apply(SessionEvent::ProofsUpdated(shared_ready()));
        assert_eq!(state.phase(), SessionPhase::Stopping);
        assert!(!state.billable());

        state.apply(SessionEvent::CleanupVerified);
        assert_eq!(state.phase(), SessionPhase::Stopped);
        assert!(!state.billable());
        assert_eq!(state.proof(), ReadinessProof::default());

        state.apply(SessionEvent::ProofsUpdated(shared_ready()));
        assert_eq!(state.phase(), SessionPhase::Stopped);
        assert!(!state.billable());
    }

    #[test]
    fn cleanup_verified_before_stop_does_not_fake_a_stopped_session() {
        let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
        state.apply(SessionEvent::CleanupVerified);
        assert_eq!(state.phase(), SessionPhase::Starting);
        assert!(!state.billable());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn ready() -> ReadinessProof {
        ReadinessProof {
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
        }
    }

    #[test]
    fn browser_reconnect_requires_explicit_fresh_media_proof() {
        let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
        state.apply(SessionEvent::ProofsUpdated(ready()));
        state.apply(SessionEvent::BrowserDisconnected);
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.billable());

        state.apply(SessionEvent::ProofsUpdated(ready()));
        assert_eq!(state.phase(), SessionPhase::Degraded);
        assert!(!state.billable());

        state.apply(SessionEvent::MediaReproved {
            capture_ready: true,
            nvenc_ready: true,
            media_ready: true,
        });
        assert_eq!(state.phase(), SessionPhase::Ready);
        assert!(state.billable());
    }

    #[test]
    fn media_reproof_cannot_hide_lost_gpu_display_or_worker() {
        for loss in [
            SessionEvent::ExactGpuLost,
            SessionEvent::VirtualDisplayLost,
            SessionEvent::WorkerLost,
        ] {
            let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
            state.apply(SessionEvent::ProofsUpdated(ready()));
            state.apply(loss);
            state.apply(SessionEvent::MediaReproved {
                capture_ready: true,
                nvenc_ready: true,
                media_ready: true,
            });
            assert_eq!(state.phase(), SessionPhase::Degraded);
            assert!(!state.billable());
        }
    }

    #[test]
    fn partial_media_reproof_never_restores_ready() {
        for (capture_ready, nvenc_ready, media_ready) in [
            (false, true, true),
            (true, false, true),
            (true, true, false),
        ] {
            let mut state = NativeSessionState::new(WorkspaceKind::CloudDesktop);
            state.apply(SessionEvent::ProofsUpdated(ready()));
            state.apply(SessionEvent::BrowserDisconnected);
            state.apply(SessionEvent::MediaReproved {
                capture_ready,
                nvenc_ready,
                media_ready,
            });
            assert_eq!(state.phase(), SessionPhase::Degraded);
            assert!(!state.billable());
        }
    }
}
