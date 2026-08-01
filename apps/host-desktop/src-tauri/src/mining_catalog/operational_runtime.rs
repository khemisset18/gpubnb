use super::process_manager::{MinerProcessSupervisor, ProcessBackend, RunningMiner};
use super::secure_launcher::VerifiedMinerBinary;
use crate::mining_runtime_controller::{MiningRuntimeController, RuntimeDecision, RuntimeOrder};
use crate::rental_mining_coordinator::{MiningConsent, StopProof};
use std::time::Duration;

const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct MinerLaunchSpec {
    pub resource_id: String,
    pub profile_id: String,
    pub binary: VerifiedMinerBinary,
    pub arguments: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceReleaseProof {
    pub gpu_handles_released: bool,
    pub temporary_files_removed: bool,
    pub miner_container_removed: bool,
    pub utilization_below_threshold: bool,
    pub temperature_below_threshold: bool,
}

pub trait ResourceReleaseVerifier {
    fn verify_release(&self, resource_id: &str) -> Result<ResourceReleaseProof, &'static str>;
}

pub struct OperationalMiningRuntime<B: ProcessBackend, V: ResourceReleaseVerifier> {
    supervisor: MinerProcessSupervisor<B>,
    release_verifier: V,
}

impl<B: ProcessBackend, V: ResourceReleaseVerifier> OperationalMiningRuntime<B, V> {
    pub fn new(backend: B, release_verifier: V) -> Self {
        Self {
            supervisor: MinerProcessSupervisor::new(backend),
            release_verifier,
        }
    }

    pub fn running(&mut self, resource_id: &str) -> Option<RunningMiner> {
        self.supervisor.running(resource_id)
    }

    pub fn apply(
        &mut self,
        controller: &mut MiningRuntimeController,
        decision: RuntimeDecision,
        launch: Option<&MinerLaunchSpec>,
    ) -> Result<Option<RuntimeDecision>, &'static str> {
        match decision.order {
            RuntimeOrder::StartApprovedMiner => {
                if decision.consent != MiningConsent::OwnerPool {
                    return Err("operational_runtime_owner_pool_only");
                }
                let launch = launch.ok_or("miner_launch_spec_required")?;
                self.supervisor.start(
                    &launch.resource_id,
                    &launch.profile_id,
                    &launch.binary,
                    &launch.arguments,
                )?;
                match controller.mining_started() {
                    Ok(next) => Ok(Some(next)),
                    Err(_) => {
                        let _ = self.supervisor.stop_and_verify(
                            &launch.resource_id,
                            GRACEFUL_STOP_TIMEOUT,
                            FORCE_STOP_TIMEOUT,
                        );
                        Err("mining_runtime_start_confirmation_failed")
                    }
                }
            }
            RuntimeOrder::StopMinerForRental => {
                let launch = launch.ok_or("miner_launch_spec_required")?;
                if self
                    .supervisor
                    .stop_and_verify(
                        &launch.resource_id,
                        GRACEFUL_STOP_TIMEOUT,
                        FORCE_STOP_TIMEOUT,
                    )
                    .is_err()
                {
                    let _ = controller.mining_stopped(StopProof::default());
                    return Err("miner_process_stop_unverified");
                }

                let release = match self.release_verifier.verify_release(&launch.resource_id) {
                    Ok(proof) => proof,
                    Err(error) => {
                        let _ = controller.mining_stopped(StopProof::default());
                        return Err(error);
                    }
                };
                let proof = StopProof {
                    process_tree_exited: true,
                    gpu_handles_released: release.gpu_handles_released,
                    temporary_files_removed: release.temporary_files_removed,
                    miner_container_removed: release.miner_container_removed,
                    utilization_below_threshold: release.utilization_below_threshold,
                    temperature_below_threshold: release.temperature_below_threshold,
                };
                controller.mining_stopped(proof).map(Some)
            }
            RuntimeOrder::Noop
            | RuntimeOrder::PrepareRentalWorkspace
            | RuntimeOrder::StartRentalWorkspace
            | RuntimeOrder::DestroyRentalWorkspace => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rental_mining_coordinator::{CoordinatedGpuState, RentalCleanupProof};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeProcessState {
        next_pid: u32,
        running: HashMap<u32, bool>,
    }

    struct FakeProcess {
        pid: u32,
        state: Arc<Mutex<FakeProcessState>>,
    }

    impl super::super::process_manager::ManagedProcess for FakeProcess {
        fn id(&self) -> u32 {
            self.pid
        }

        fn try_wait(&mut self) -> Result<Option<i32>, &'static str> {
            let state = self.state.lock().expect("fake process state");
            Ok((!state.running.get(&self.pid).copied().unwrap_or(false)).then_some(0))
        }

        fn request_stop(&mut self) -> Result<(), &'static str> {
            self.state
                .lock()
                .expect("fake process state")
                .running
                .insert(self.pid, false);
            Ok(())
        }

        fn force_stop(&mut self) -> Result<(), &'static str> {
            self.request_stop()
        }
    }

    struct FakeBackend {
        state: Arc<Mutex<FakeProcessState>>,
    }

    impl ProcessBackend for FakeBackend {
        fn spawn(
            &self,
            _binary: &VerifiedMinerBinary,
            _arguments: &[String],
        ) -> Result<Box<dyn super::super::process_manager::ManagedProcess>, &'static str> {
            let mut state = self.state.lock().expect("fake process state");
            state.next_pid += 1;
            let pid = state.next_pid;
            state.running.insert(pid, true);
            drop(state);
            Ok(Box::new(FakeProcess {
                pid,
                state: Arc::clone(&self.state),
            }))
        }
    }

    #[derive(Clone, Copy)]
    struct FakeReleaseVerifier {
        verified: bool,
    }

    impl ResourceReleaseVerifier for FakeReleaseVerifier {
        fn verify_release(&self, _resource_id: &str) -> Result<ResourceReleaseProof, &'static str> {
            Ok(ResourceReleaseProof {
                gpu_handles_released: self.verified,
                temporary_files_removed: self.verified,
                miner_container_removed: self.verified,
                utilization_below_threshold: self.verified,
                temperature_below_threshold: self.verified,
            })
        }
    }

    fn launch_spec() -> MinerLaunchSpec {
        MinerLaunchSpec {
            resource_id: "gpu-0".into(),
            profile_id: "trex_rvn_kawpow".into(),
            binary: VerifiedMinerBinary {
                canonical_path: PathBuf::from("fake-miner"),
                sha256: "00".repeat(32),
            },
            arguments: vec!["--algorithm".into(), "kawpow".into()],
        }
    }

    fn cleanup_proof() -> RentalCleanupProof {
        RentalCleanupProof {
            workspace_destroyed: true,
            credentials_revoked: true,
            storage_clean: true,
            network_clean: true,
            gpu_healthy: true,
            renter_processes_absent: true,
        }
    }

    #[test]
    fn owner_pool_mining_is_preempted_and_resumes_after_rental() {
        let state = Arc::new(Mutex::new(FakeProcessState::default()));
        let mut runtime = OperationalMiningRuntime::new(
            FakeBackend {
                state: Arc::clone(&state),
            },
            FakeReleaseVerifier { verified: true },
        );
        let launch = launch_spec();
        let mut controller = MiningRuntimeController::default();
        controller
            .set_owner_consent(MiningConsent::OwnerPool)
            .expect("owner pool consent");
        controller
            .set_auto_resume_after_rental(true)
            .expect("auto resume");

        let start = controller
            .request_idle_mining_start()
            .expect("request mining start");
        runtime
            .apply(&mut controller, start, Some(&launch))
            .expect("start supervised miner");
        assert_eq!(controller.snapshot().state, CoordinatedGpuState::Mining);
        assert!(runtime.running("gpu-0").is_some());

        let stop = controller
            .reservation_confirmed("rental-1".into())
            .expect("confirm paid rental");
        let next = runtime
            .apply(&mut controller, stop, Some(&launch))
            .expect("stop and verify miner")
            .expect("runtime transition");
        assert_eq!(next.order, RuntimeOrder::PrepareRentalWorkspace);
        assert!(runtime.running("gpu-0").is_none());

        controller
            .rental_ready(true, true, true)
            .expect("rental ready");
        controller.rental_started().expect("rental started");
        controller.rental_finished().expect("rental finished");
        let resume = controller
            .rental_cleanup_verified(cleanup_proof())
            .expect("cleanup verified");
        assert_eq!(resume.order, RuntimeOrder::StartApprovedMiner);
        runtime
            .apply(&mut controller, resume, Some(&launch))
            .expect("resume supervised miner");
        assert_eq!(controller.snapshot().state, CoordinatedGpuState::Mining);
        assert!(runtime.running("gpu-0").is_some());
    }

    #[test]
    fn failed_release_verification_quarantines_resource_and_blocks_rental() {
        let state = Arc::new(Mutex::new(FakeProcessState::default()));
        let mut runtime = OperationalMiningRuntime::new(
            FakeBackend { state },
            FakeReleaseVerifier { verified: false },
        );
        let launch = launch_spec();
        let mut controller = MiningRuntimeController::default();
        controller
            .set_owner_consent(MiningConsent::OwnerPool)
            .expect("owner pool consent");
        let start = controller
            .request_idle_mining_start()
            .expect("request mining start");
        runtime
            .apply(&mut controller, start, Some(&launch))
            .expect("start supervised miner");

        let stop = controller
            .reservation_confirmed("rental-2".into())
            .expect("confirm paid rental");
        assert_eq!(
            runtime.apply(&mut controller, stop, Some(&launch)),
            Err("mining_stop_proof_failed")
        );
        assert_eq!(
            controller.snapshot().state,
            CoordinatedGpuState::Quarantined
        );
        assert!(!controller.snapshot().rental_may_start);
    }

    #[test]
    fn managed_pool_mode_is_not_operational() {
        let state = Arc::new(Mutex::new(FakeProcessState::default()));
        let mut runtime = OperationalMiningRuntime::new(
            FakeBackend { state },
            FakeReleaseVerifier { verified: true },
        );
        let launch = launch_spec();
        let mut controller = MiningRuntimeController::default();
        controller
            .set_owner_consent(MiningConsent::ManagedPool)
            .expect("managed pool consent remains configurable but disabled operationally");
        let start = controller
            .request_idle_mining_start()
            .expect("request mining start");
        assert_eq!(
            runtime.apply(&mut controller, start, Some(&launch)),
            Err("operational_runtime_owner_pool_only")
        );
        assert!(runtime.running("gpu-0").is_none());
    }
}
