use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatedGpuState {
    #[default]
    Idle,
    MiningStarting,
    Mining,
    PreemptingMining,
    VerifyingRentalReadiness,
    RentalReady,
    RentalActive,
    CleaningRental,
    Quarantined,
    EmergencyStopped,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiningConsent {
    #[default]
    Disabled,
    ManagedPool,
    OwnerPool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StopProof {
    pub process_tree_exited: bool,
    pub gpu_handles_released: bool,
    pub temporary_files_removed: bool,
    pub miner_container_removed: bool,
    pub utilization_below_threshold: bool,
    pub temperature_below_threshold: bool,
}

impl StopProof {
    pub fn verified(self) -> bool {
        self.process_tree_exited
            && self.gpu_handles_released
            && self.temporary_files_removed
            && self.miner_container_removed
            && self.utilization_below_threshold
            && self.temperature_below_threshold
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RentalCleanupProof {
    pub workspace_destroyed: bool,
    pub credentials_revoked: bool,
    pub storage_clean: bool,
    pub network_clean: bool,
    pub gpu_healthy: bool,
    pub renter_processes_absent: bool,
}

impl RentalCleanupProof {
    pub fn verified(self) -> bool {
        self.workspace_destroyed
            && self.credentials_revoked
            && self.storage_clean
            && self.network_clean
            && self.gpu_healthy
            && self.renter_processes_absent
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorSnapshot {
    pub state: CoordinatedGpuState,
    pub consent: MiningConsent,
    pub auto_resume_after_rental: bool,
    pub reservation_id: Option<String>,
    pub should_start_mining: bool,
    pub should_stop_mining: bool,
    pub rental_may_start: bool,
    pub last_error: Option<&'static str>,
}

#[derive(Clone, Debug, Default)]
pub struct RentalMiningCoordinator {
    state: CoordinatedGpuState,
    consent: MiningConsent,
    auto_resume_after_rental: bool,
    was_mining_before_reservation: bool,
    resume_requested: bool,
    reservation_id: Option<String>,
    last_error: Option<&'static str>,
}

impl RentalMiningCoordinator {
    pub fn set_owner_consent(&mut self, consent: MiningConsent) -> Result<(), &'static str> {
        if matches!(
            self.state,
            CoordinatedGpuState::RentalActive | CoordinatedGpuState::CleaningRental
        ) {
            return Err("mining_consent_locked_during_rental");
        }
        self.consent = consent;
        if consent == MiningConsent::Disabled {
            self.resume_requested = false;
            if matches!(
                self.state,
                CoordinatedGpuState::Mining | CoordinatedGpuState::MiningStarting
            ) {
                self.state = CoordinatedGpuState::PreemptingMining;
            }
        }
        Ok(())
    }

    pub fn set_auto_resume_after_rental(&mut self, enabled: bool) -> Result<(), &'static str> {
        if matches!(
            self.state,
            CoordinatedGpuState::RentalActive | CoordinatedGpuState::CleaningRental
        ) {
            return Err("auto_resume_locked_during_rental");
        }
        self.auto_resume_after_rental = enabled;
        if !enabled {
            self.resume_requested = false;
        }
        Ok(())
    }

    pub fn request_idle_mining_start(&mut self) -> Result<(), &'static str> {
        if self.consent == MiningConsent::Disabled {
            return Err("mining_not_authorized_by_owner");
        }
        if self.reservation_id.is_some() {
            return Err("reservation_has_priority");
        }
        if self.state != CoordinatedGpuState::Idle {
            return Err("gpu_not_idle");
        }
        self.resume_requested = false;
        self.state = CoordinatedGpuState::MiningStarting;
        Ok(())
    }

    pub fn confirm_mining_started(&mut self) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::MiningStarting {
            return Err("mining_start_not_expected");
        }
        if self.reservation_id.is_some() {
            self.state = CoordinatedGpuState::PreemptingMining;
            return Err("reservation_preempted_mining_start");
        }
        self.resume_requested = false;
        self.state = CoordinatedGpuState::Mining;
        Ok(())
    }

    /// A funded reservation immediately owns scheduling priority. No new mining
    /// work may be accepted after this transition.
    pub fn reservation_requested(&mut self, reservation_id: String) -> Result<(), &'static str> {
        if reservation_id.is_empty() || reservation_id.len() > 96 {
            return Err("invalid_reservation_id");
        }
        if self.reservation_id.is_some() {
            return Err("reservation_already_pending");
        }
        if matches!(
            self.state,
            CoordinatedGpuState::Quarantined | CoordinatedGpuState::EmergencyStopped
        ) {
            return Err("gpu_unavailable");
        }

        self.was_mining_before_reservation = matches!(
            self.state,
            CoordinatedGpuState::Mining | CoordinatedGpuState::MiningStarting
        );
        self.resume_requested = false;
        self.reservation_id = Some(reservation_id);
        self.state = match self.state {
            CoordinatedGpuState::Mining | CoordinatedGpuState::MiningStarting => {
                CoordinatedGpuState::PreemptingMining
            }
            CoordinatedGpuState::Idle => CoordinatedGpuState::VerifyingRentalReadiness,
            _ => return self.quarantine("reservation_invalid_state"),
        };
        Ok(())
    }

    pub fn confirm_mining_stopped(&mut self, proof: StopProof) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::PreemptingMining {
            return Err("mining_stop_not_expected");
        }
        if !proof.verified() {
            return self.quarantine("mining_stop_proof_failed");
        }
        self.state = if self.reservation_id.is_some() {
            CoordinatedGpuState::VerifyingRentalReadiness
        } else {
            CoordinatedGpuState::Idle
        };
        Ok(())
    }

    pub fn confirm_owner_mining_stopped(
        &mut self,
        process_exited: bool,
    ) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::PreemptingMining
            || self.consent != MiningConsent::Disabled
            || self.reservation_id.is_some()
        {
            return Err("owner_mining_stop_not_expected");
        }
        if !process_exited {
            self.state = CoordinatedGpuState::Quarantined;
            self.last_error = Some("owner_mining_process_still_running");
            return Err("owner_mining_process_still_running");
        }
        self.state = CoordinatedGpuState::Idle;
        self.last_error = None;
        Ok(())
    }

    pub fn record_unexpected_miner_exit(&mut self) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::Mining {
            return Err("unexpected_miner_exit_not_applicable");
        }
        self.state = CoordinatedGpuState::Quarantined;
        self.resume_requested = false;
        self.last_error = Some("miner_process_exited_unexpectedly");
        Ok(())
    }

    pub fn confirm_rental_ready(
        &mut self,
        exclusive_gpu_access: bool,
        isolation_verified: bool,
        temporary_credentials_issued: bool,
    ) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::VerifyingRentalReadiness {
            return Err("rental_readiness_not_expected");
        }
        if !(exclusive_gpu_access && isolation_verified && temporary_credentials_issued) {
            return self.quarantine("rental_readiness_proof_failed");
        }
        self.state = CoordinatedGpuState::RentalReady;
        Ok(())
    }

    pub fn start_rental(&mut self) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::RentalReady || self.reservation_id.is_none() {
            return Err("rental_not_ready");
        }
        self.state = CoordinatedGpuState::RentalActive;
        Ok(())
    }

    pub fn finish_rental(&mut self) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::RentalActive {
            return Err("rental_not_active");
        }
        self.state = CoordinatedGpuState::CleaningRental;
        Ok(())
    }

    pub fn confirm_rental_cleanup(
        &mut self,
        proof: RentalCleanupProof,
    ) -> Result<(), &'static str> {
        if self.state != CoordinatedGpuState::CleaningRental {
            return Err("rental_cleanup_not_expected");
        }
        if !proof.verified() {
            return self.quarantine("rental_cleanup_proof_failed");
        }
        self.reservation_id = None;
        self.last_error = None;
        self.state = CoordinatedGpuState::Idle;
        self.resume_requested = self.was_mining_before_reservation
            && self.auto_resume_after_rental
            && self.consent != MiningConsent::Disabled;
        self.was_mining_before_reservation = false;
        Ok(())
    }

    pub fn emergency_stop(&mut self, all_workloads_stopped: bool) -> Result<(), &'static str> {
        self.reservation_id = None;
        self.was_mining_before_reservation = false;
        self.resume_requested = false;
        if all_workloads_stopped {
            self.state = CoordinatedGpuState::EmergencyStopped;
            self.last_error = None;
            Ok(())
        } else {
            self.quarantine("emergency_stop_failed")
        }
    }

    pub fn snapshot(&self) -> CoordinatorSnapshot {
        CoordinatorSnapshot {
            state: self.state,
            consent: self.consent,
            auto_resume_after_rental: self.auto_resume_after_rental,
            reservation_id: self.reservation_id.clone(),
            should_start_mining: (self.state == CoordinatedGpuState::MiningStarting
                || (self.state == CoordinatedGpuState::Idle && self.resume_requested))
                && self.consent != MiningConsent::Disabled
                && self.reservation_id.is_none(),
            should_stop_mining: self.state == CoordinatedGpuState::PreemptingMining,
            rental_may_start: self.state == CoordinatedGpuState::RentalReady,
            last_error: self.last_error,
        }
    }

    fn quarantine<T>(&mut self, error: &'static str) -> Result<T, &'static str> {
        self.state = CoordinatedGpuState::Quarantined;
        self.was_mining_before_reservation = false;
        self.resume_requested = false;
        self.last_error = Some(error);
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stop_proof() -> StopProof {
        StopProof {
            process_tree_exited: true,
            gpu_handles_released: true,
            temporary_files_removed: true,
            miner_container_removed: true,
            utilization_below_threshold: true,
            temperature_below_threshold: true,
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

    fn complete_rental(coordinator: &mut RentalMiningCoordinator, reservation_id: &str) {
        coordinator
            .reservation_requested(reservation_id.into())
            .unwrap();
        if coordinator.snapshot().should_stop_mining {
            coordinator.confirm_mining_stopped(stop_proof()).unwrap();
        }
        coordinator.confirm_rental_ready(true, true, true).unwrap();
        coordinator.start_rental().unwrap();
        coordinator.finish_rental().unwrap();
        coordinator.confirm_rental_cleanup(cleanup_proof()).unwrap();
    }

    #[test]
    fn auto_resume_is_disabled_by_default() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator
            .set_owner_consent(MiningConsent::ManagedPool)
            .unwrap();
        coordinator.request_idle_mining_start().unwrap();
        coordinator.confirm_mining_started().unwrap();

        complete_rental(&mut coordinator, "reservation_1");

        let snapshot = coordinator.snapshot();
        assert_eq!(snapshot.state, CoordinatedGpuState::Idle);
        assert!(!snapshot.auto_resume_after_rental);
        assert!(!snapshot.should_start_mining);
    }

    #[test]
    fn enabled_auto_resume_only_restarts_preempted_mining() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator
            .set_owner_consent(MiningConsent::ManagedPool)
            .unwrap();
        coordinator.set_auto_resume_after_rental(true).unwrap();
        coordinator.request_idle_mining_start().unwrap();
        coordinator.confirm_mining_started().unwrap();

        complete_rental(&mut coordinator, "reservation_2");

        assert!(coordinator.snapshot().should_start_mining);
    }

    #[test]
    fn enabled_auto_resume_does_not_start_a_previously_idle_gpu() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator
            .set_owner_consent(MiningConsent::ManagedPool)
            .unwrap();
        coordinator.set_auto_resume_after_rental(true).unwrap();

        complete_rental(&mut coordinator, "reservation_3");

        assert!(!coordinator.snapshot().should_start_mining);
    }

    #[test]
    fn owner_stop_returns_to_idle_only_after_process_exit() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator.set_owner_consent(MiningConsent::OwnerPool).unwrap();
        coordinator.request_idle_mining_start().unwrap();
        coordinator.confirm_mining_started().unwrap();
        coordinator.set_owner_consent(MiningConsent::Disabled).unwrap();

        coordinator.confirm_owner_mining_stopped(true).unwrap();

        assert_eq!(coordinator.snapshot().state, CoordinatedGpuState::Idle);
    }

    #[test]
    fn unexpected_process_exit_quarantines_active_mining() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator.set_owner_consent(MiningConsent::OwnerPool).unwrap();
        coordinator.request_idle_mining_start().unwrap();
        coordinator.confirm_mining_started().unwrap();

        coordinator.record_unexpected_miner_exit().unwrap();

        let snapshot = coordinator.snapshot();
        assert_eq!(snapshot.state, CoordinatedGpuState::Quarantined);
        assert_eq!(snapshot.last_error, Some("miner_process_exited_unexpectedly"));
    }

    #[test]
    fn failed_miner_stop_blocks_rental_and_quarantines_gpu() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator
            .set_owner_consent(MiningConsent::OwnerPool)
            .unwrap();
        coordinator.set_auto_resume_after_rental(true).unwrap();
        coordinator.request_idle_mining_start().unwrap();
        coordinator.confirm_mining_started().unwrap();
        coordinator
            .reservation_requested("reservation_4".into())
            .unwrap();

        let mut proof = stop_proof();
        proof.gpu_handles_released = false;
        assert_eq!(
            coordinator.confirm_mining_stopped(proof),
            Err("mining_stop_proof_failed")
        );
        assert_eq!(
            coordinator.snapshot().state,
            CoordinatedGpuState::Quarantined
        );
        assert!(!coordinator.snapshot().rental_may_start);
        assert!(!coordinator.snapshot().should_start_mining);
    }

    #[test]
    fn mining_cannot_start_while_reservation_is_pending() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator
            .set_owner_consent(MiningConsent::ManagedPool)
            .unwrap();
        coordinator
            .reservation_requested("reservation_5".into())
            .unwrap();
        assert_eq!(
            coordinator.request_idle_mining_start(),
            Err("reservation_has_priority")
        );
    }

    #[test]
    fn cleanup_failure_prevents_automatic_mining_resume() {
        let mut coordinator = RentalMiningCoordinator::default();
        coordinator
            .set_owner_consent(MiningConsent::ManagedPool)
            .unwrap();
        coordinator.set_auto_resume_after_rental(true).unwrap();
        coordinator.request_idle_mining_start().unwrap();
        coordinator.confirm_mining_started().unwrap();
        coordinator
            .reservation_requested("reservation_6".into())
            .unwrap();
        coordinator.confirm_mining_stopped(stop_proof()).unwrap();
        coordinator.confirm_rental_ready(true, true, true).unwrap();
        coordinator.start_rental().unwrap();
        coordinator.finish_rental().unwrap();

        let mut proof = cleanup_proof();
        proof.renter_processes_absent = false;
        assert_eq!(
            coordinator.confirm_rental_cleanup(proof),
            Err("rental_cleanup_proof_failed")
        );
        assert!(!coordinator.snapshot().should_start_mining);
    }
}
