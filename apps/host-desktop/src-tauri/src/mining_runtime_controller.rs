use serde::{Deserialize, Serialize};

use crate::rental_mining_coordinator::{
    CoordinatorSnapshot, MiningConsent, RentalCleanupProof, RentalMiningCoordinator, StopProof,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOrder {
    StartApprovedMiner,
    StopMinerForRental,
    PrepareRentalWorkspace,
    StartRentalWorkspace,
    DestroyRentalWorkspace,
    Noop,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDecision {
    pub sequence: u64,
    pub order: RuntimeOrder,
    pub reservation_id: Option<String>,
    pub consent: MiningConsent,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Default)]
pub struct MiningRuntimeController {
    coordinator: RentalMiningCoordinator,
    sequence: u64,
    last_emitted: Option<RuntimeOrder>,
}

impl MiningRuntimeController {
    pub fn set_owner_consent(
        &mut self,
        consent: MiningConsent,
    ) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.set_owner_consent(consent)?;
        Ok(self.reconcile("owner_consent_changed"))
    }

    pub fn set_auto_resume_after_rental(
        &mut self,
        enabled: bool,
    ) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.set_auto_resume_after_rental(enabled)?;
        Ok(self.reconcile("auto_resume_policy_changed"))
    }

    pub fn request_idle_mining_start(&mut self) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.request_idle_mining_start()?;
        Ok(self.reconcile("manual_mining_start_requested"))
    }

    pub fn reservation_confirmed(
        &mut self,
        reservation_id: String,
    ) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.reservation_requested(reservation_id)?;
        Ok(self.reconcile("reservation_confirmed"))
    }

    pub fn mining_started(&mut self) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.confirm_mining_started()?;
        Ok(self.reconcile("mining_started"))
    }

    pub fn mining_stopped(&mut self, proof: StopProof) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.confirm_mining_stopped(proof)?;
        Ok(self.reconcile("mining_stopped_and_verified"))
    }

    pub fn rental_ready(
        &mut self,
        exclusive_gpu_access: bool,
        isolation_verified: bool,
        temporary_credentials_issued: bool,
    ) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.confirm_rental_ready(
            exclusive_gpu_access,
            isolation_verified,
            temporary_credentials_issued,
        )?;
        Ok(self.reconcile("rental_ready_verified"))
    }

    pub fn rental_started(&mut self) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.start_rental()?;
        Ok(self.reconcile("rental_started"))
    }

    pub fn rental_finished(&mut self) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.finish_rental()?;
        Ok(self.reconcile("rental_finished"))
    }

    pub fn rental_cleanup_verified(
        &mut self,
        proof: RentalCleanupProof,
    ) -> Result<RuntimeDecision, &'static str> {
        self.coordinator.confirm_rental_cleanup(proof)?;
        Ok(self.reconcile("rental_cleanup_verified"))
    }

    pub fn snapshot(&self) -> CoordinatorSnapshot {
        self.coordinator.snapshot()
    }

    pub fn reconcile(&mut self, reason: &'static str) -> RuntimeDecision {
        let snapshot = self.coordinator.snapshot();
        let order = if snapshot.should_stop_mining {
            RuntimeOrder::StopMinerForRental
        } else if snapshot.rental_may_start {
            RuntimeOrder::StartRentalWorkspace
        } else if snapshot.should_start_mining {
            RuntimeOrder::StartApprovedMiner
        } else {
            match snapshot.state {
                crate::rental_mining_coordinator::CoordinatedGpuState::VerifyingRentalReadiness => {
                    RuntimeOrder::PrepareRentalWorkspace
                }
                crate::rental_mining_coordinator::CoordinatedGpuState::CleaningRental => {
                    RuntimeOrder::DestroyRentalWorkspace
                }
                _ => RuntimeOrder::Noop,
            }
        };

        // Only real side-effecting orders participate in duplicate suppression.
        // A Noop is an observation, not an emitted process command, and must not
        // overwrite the last command or suppress a later legitimate transition.
        let order = if order != RuntimeOrder::Noop && self.last_emitted.as_ref() != Some(&order) {
            self.last_emitted = Some(order.clone());
            order
        } else {
            RuntimeOrder::Noop
        };

        self.sequence = self.sequence.saturating_add(1);
        RuntimeDecision {
            sequence: self.sequence,
            order,
            reservation_id: snapshot.reservation_id,
            consent: snapshot.consent,
            reason,
        }
    }
}
