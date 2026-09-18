//! Ordered, rollback-safe orchestration for the future Windows platform adapter.
//!
//! Platform-specific Win32/WDK/NVENC code implements NativePlatform. This module
//! owns the security order and never reports readiness unless every required
//! proof has been produced independently.

use crate::lifecycle::{ReadinessProof, WorkspaceKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeBackendError {
    IsolatedSession,
    VirtualDisplay,
    ProviderDesktop,
    ExactGpu,
    Capture,
    Nvenc,
    Media,
    Input,
    Audio,
    Controller,
    IncompleteProof,
    Cleanup,
}

pub trait NativePlatform {
    fn create_isolated_session(&mut self) -> Result<(), NativeBackendError>;
    fn create_virtual_display(&mut self) -> Result<(), NativeBackendError>;
    fn prove_provider_desktop_excluded(&mut self) -> Result<(), NativeBackendError>;
    fn bind_exact_gpu(&mut self, gpu_uuid: &str) -> Result<(), NativeBackendError>;
    fn capture_real_frame(&mut self) -> Result<(), NativeBackendError>;
    fn encode_real_frame_nvenc(&mut self, gpu_uuid: &str) -> Result<(), NativeBackendError>;
    fn open_loopback_media(&mut self) -> Result<(), NativeBackendError>;
    fn enable_isolated_input(&mut self) -> Result<(), NativeBackendError>;
    fn prove_audio(&mut self) -> Result<(), NativeBackendError>;
    fn prove_controller(&mut self) -> Result<(), NativeBackendError>;
    fn cleanup(&mut self) -> Result<(), NativeBackendError>;
}

fn fail_with_cleanup<P: NativePlatform>(
    platform: &mut P,
    failure: NativeBackendError,
) -> NativeBackendError {
    match platform.cleanup() {
        Ok(()) => failure,
        Err(_) => NativeBackendError::Cleanup,
    }
}

pub fn prove_runtime_ready<P: NativePlatform>(
    platform: &mut P,
    workspace: WorkspaceKind,
    gpu_uuid: &str,
) -> Result<ReadinessProof, NativeBackendError> {
    let mut proof = ReadinessProof::default();

    if let Err(error) = platform.create_isolated_session() {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.isolated_session = true;

    if let Err(error) = platform.create_virtual_display() {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.virtual_display = true;

    if let Err(error) = platform.prove_provider_desktop_excluded() {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.provider_desktop_excluded = true;

    if let Err(error) = platform.bind_exact_gpu(gpu_uuid) {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.exact_gpu_bound = true;

    if let Err(error) = platform.capture_real_frame() {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.capture_ready = true;

    if let Err(error) = platform.encode_real_frame_nvenc(gpu_uuid) {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.nvenc_ready = true;

    if let Err(error) = platform.open_loopback_media() {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.media_ready = true;

    if let Err(error) = platform.enable_isolated_input() {
        return Err(fail_with_cleanup(platform, error));
    }
    proof.input_isolated = true;

    if matches!(workspace, WorkspaceKind::Gaming) {
        if let Err(error) = platform.prove_audio() {
            return Err(fail_with_cleanup(platform, error));
        }
        proof.audio_ready = true;

        if let Err(error) = platform.prove_controller() {
            return Err(fail_with_cleanup(platform, error));
        }
        proof.controller_ready = true;
    }

    if proof.qualifies(workspace) {
        Ok(proof)
    } else {
        Err(fail_with_cleanup(
            platform,
            NativeBackendError::IncompleteProof,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakePlatform {
        calls: Vec<&'static str>,
        fail_at: Option<&'static str>,
        cleanup_fails: bool,
    }

    impl FakePlatform {
        fn step(&mut self, name: &'static str, error: NativeBackendError) -> Result<(), NativeBackendError> {
            self.calls.push(name);
            if self.fail_at == Some(name) {
                Err(error)
            } else {
                Ok(())
            }
        }
    }

    impl NativePlatform for FakePlatform {
        fn create_isolated_session(&mut self) -> Result<(), NativeBackendError> {
            self.step("session", NativeBackendError::IsolatedSession)
        }
        fn create_virtual_display(&mut self) -> Result<(), NativeBackendError> {
            self.step("display", NativeBackendError::VirtualDisplay)
        }
        fn prove_provider_desktop_excluded(&mut self) -> Result<(), NativeBackendError> {
            self.step("provider", NativeBackendError::ProviderDesktop)
        }
        fn bind_exact_gpu(&mut self, _: &str) -> Result<(), NativeBackendError> {
            self.step("gpu", NativeBackendError::ExactGpu)
        }
        fn capture_real_frame(&mut self) -> Result<(), NativeBackendError> {
            self.step("capture", NativeBackendError::Capture)
        }
        fn encode_real_frame_nvenc(&mut self, _: &str) -> Result<(), NativeBackendError> {
            self.step("nvenc", NativeBackendError::Nvenc)
        }
        fn open_loopback_media(&mut self) -> Result<(), NativeBackendError> {
            self.step("media", NativeBackendError::Media)
        }
        fn enable_isolated_input(&mut self) -> Result<(), NativeBackendError> {
            self.step("input", NativeBackendError::Input)
        }
        fn prove_audio(&mut self) -> Result<(), NativeBackendError> {
            self.step("audio", NativeBackendError::Audio)
        }
        fn prove_controller(&mut self) -> Result<(), NativeBackendError> {
            self.step("controller", NativeBackendError::Controller)
        }
        fn cleanup(&mut self) -> Result<(), NativeBackendError> {
            self.calls.push("cleanup");
            if self.cleanup_fails {
                Err(NativeBackendError::Cleanup)
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn cloud_desktop_proof_order_is_strict_and_complete() {
        let mut platform = FakePlatform::default();
        let proof = prove_runtime_ready(
            &mut platform,
            WorkspaceKind::CloudDesktop,
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
        )
        .expect("qualified proof");

        assert!(proof.qualifies(WorkspaceKind::CloudDesktop));
        assert_eq!(
            platform.calls,
            [
                "session", "display", "provider", "gpu", "capture", "nvenc", "media", "input",
            ]
        );
    }

    #[test]
    fn every_shared_failure_rolls_back_and_never_returns_ready() {
        for (step, expected) in [
            ("session", NativeBackendError::IsolatedSession),
            ("display", NativeBackendError::VirtualDisplay),
            ("provider", NativeBackendError::ProviderDesktop),
            ("gpu", NativeBackendError::ExactGpu),
            ("capture", NativeBackendError::Capture),
            ("nvenc", NativeBackendError::Nvenc),
            ("media", NativeBackendError::Media),
            ("input", NativeBackendError::Input),
        ] {
            let mut platform = FakePlatform {
                fail_at: Some(step),
                ..FakePlatform::default()
            };
            assert_eq!(
                prove_runtime_ready(
                    &mut platform,
                    WorkspaceKind::CloudDesktop,
                    "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
                ),
                Err(expected)
            );
            assert_eq!(platform.calls.last(), Some(&"cleanup"));
        }
    }

    #[test]
    fn cleanup_failure_overrides_original_failure() {
        let mut platform = FakePlatform {
            fail_at: Some("capture"),
            cleanup_fails: true,
            ..FakePlatform::default()
        };
        assert_eq!(
            prove_runtime_ready(
                &mut platform,
                WorkspaceKind::CloudDesktop,
                "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            ),
            Err(NativeBackendError::Cleanup)
        );
    }

    #[test]
    fn gaming_requires_audio_and_controller_after_shared_pipeline() {
        let mut platform = FakePlatform::default();
        let proof = prove_runtime_ready(
            &mut platform,
            WorkspaceKind::Gaming,
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
        )
        .expect("gaming proof");
        assert!(proof.qualifies(WorkspaceKind::Gaming));
        assert_eq!(platform.calls.last(), Some(&"controller"));
        assert!(platform.calls.contains(&"audio"));
    }

    #[test]
    fn gaming_audio_or_controller_failure_rolls_back() {
        for step in ["audio", "controller"] {
            let mut platform = FakePlatform {
                fail_at: Some(step),
                ..FakePlatform::default()
            };
            assert!(
                prove_runtime_ready(
                    &mut platform,
                    WorkspaceKind::Gaming,
                    "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
                )
                .is_err()
            );
            assert_eq!(platform.calls.last(), Some(&"cleanup"));
        }
    }
}
