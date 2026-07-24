use serde::{Deserialize, Serialize};

const MAX_IDENTIFIER_LEN: usize = 96;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostWorkloadState {
    #[default]
    Offline,
    Available,
    Mining,
    StoppingMining,
    PreparingRental,
    RentalActive,
    CleaningRental,
    Quarantined,
    EmergencyStopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifiedReservation {
    pub reservation_id: String,
    pub machine_id: String,
    pub renter_id: String,
    pub gpu_id: String,
    pub funded: bool,
    pub starts_at_unix_seconds: u64,
    pub ends_at_unix_seconds: u64,
}

impl VerifiedReservation {
    pub fn validate(&self, expected_machine_id: &str, now: u64) -> Result<(), &'static str> {
        validate_identifier(&self.reservation_id)?;
        validate_identifier(&self.machine_id)?;
        validate_identifier(&self.renter_id)?;
        validate_identifier(&self.gpu_id)?;
        validate_identifier(expected_machine_id)?;

        if self.machine_id != expected_machine_id {
            return Err("reservation_machine_mismatch");
        }
        if !self.funded {
            return Err("reservation_not_funded");
        }
        if self.ends_at_unix_seconds <= self.starts_at_unix_seconds {
            return Err("reservation_invalid_window");
        }
        if now >= self.ends_at_unix_seconds {
            return Err("reservation_expired");
        }
        Ok(())
    }
}

fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid_identifier");
    }
    Ok(())
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationSnapshot {
    pub state: HostWorkloadState,
    pub mining_enabled: bool,
    pub active_reservation_id: Option<String>,
    pub active_gpu_id: Option<String>,
    pub last_error: Option<&'static str>,
}

#[derive(Clone, Debug, Default)]
pub struct RentalOrchestrator {
    machine_id: String,
    state: HostWorkloadState,
    mining_enabled: bool,
    active_reservation: Option<VerifiedReservation>,
    last_error: Option<&'static str>,
}

impl RentalOrchestrator {
    pub fn new(machine_id: String) -> Result<Self, &'static str> {
        validate_identifier(&machine_id)?;
        Ok(Self {
            machine_id,
            ..Self::default()
        })
    }

    pub fn certify_host(&mut self) -> Result<(), &'static str> {
        self.require_state(HostWorkloadState::Offline)?;
        self.state = HostWorkloadState::Available;
        self.last_error = None;
        Ok(())
    }

    pub fn set_mining_enabled(&mut self, enabled: bool) -> Result<(), &'static str> {
        match (self.state, enabled) {
            (HostWorkloadState::Available, true) => {
                self.mining_enabled = true;
                self.state = HostWorkloadState::Mining;
                Ok(())
            }
            (HostWorkloadState::Mining, false) => {
                self.mining_enabled = false;
                self.state = HostWorkloadState::StoppingMining;
                Ok(())
            }
            (HostWorkloadState::Available, false) => {
                self.mining_enabled = false;
                Ok(())
            }
            _ => Err("mining_transition_not_allowed"),
        }
    }

    pub fn accept_reservation(
        &mut self,
        reservation: VerifiedReservation,
        now: u64,
    ) -> Result<(), &'static str> {
        reservation.validate(&self.machine_id, now)?;
        if self.active_reservation.is_some() {
            return Err("reservation_already_active");
        }

        match self.state {
            HostWorkloadState::Available => {
                self.active_reservation = Some(reservation);
                self.state = HostWorkloadState::PreparingRental;
                Ok(())
            }
            HostWorkloadState::Mining => {
                self.active_reservation = Some(reservation);
                self.state = HostWorkloadState::StoppingMining;
                Ok(())
            }
            _ => Err("host_not_available_for_reservation"),
        }
    }

    pub fn confirm_mining_stopped(&mut self, process_exited: bool) -> Result<(), &'static str> {
        self.require_state(HostWorkloadState::StoppingMining)?;
        if !process_exited {
            return self.quarantine("miner_process_still_running");
        }
        self.state = if self.active_reservation.is_some() {
            HostWorkloadState::PreparingRental
        } else {
            HostWorkloadState::Available
        };
        Ok(())
    }

    pub fn confirm_workspace_ready(
        &mut self,
        isolation_verified: bool,
        gpu_attached_exclusively: bool,
        temporary_access_issued: bool,
    ) -> Result<(), &'static str> {
        self.require_state(HostWorkloadState::PreparingRental)?;
        if self.active_reservation.is_none() {
            return self.quarantine("workspace_without_reservation");
        }
        if !isolation_verified {
            return self.quarantine("workspace_isolation_unverified");
        }
        if !gpu_attached_exclusively {
            return self.quarantine("gpu_exclusivity_unverified");
        }
        if !temporary_access_issued {
            return self.quarantine("temporary_access_missing");
        }
        self.state = HostWorkloadState::RentalActive;
        Ok(())
    }

    pub fn finish_rental(&mut self) -> Result<(), &'static str> {
        self.require_state(HostWorkloadState::RentalActive)?;
        self.state = HostWorkloadState::CleaningRental;
        Ok(())
    }

    pub fn confirm_cleanup(
        &mut self,
        workspace_destroyed: bool,
        access_revoked: bool,
        gpu_healthy: bool,
        storage_clean: bool,
        network_clean: bool,
    ) -> Result<(), &'static str> {
        self.require_state(HostWorkloadState::CleaningRental)?;
        if !(workspace_destroyed && access_revoked && gpu_healthy && storage_clean && network_clean)
        {
            return self.quarantine("cleanup_verification_failed");
        }

        self.active_reservation = None;
        self.last_error = None;
        self.state = if self.mining_enabled {
            HostWorkloadState::Mining
        } else {
            HostWorkloadState::Available
        };
        Ok(())
    }

    pub fn emergency_stop(&mut self, all_processes_stopped: bool) -> Result<(), &'static str> {
        self.active_reservation = None;
        if all_processes_stopped {
            self.state = HostWorkloadState::EmergencyStopped;
            self.last_error = None;
            Ok(())
        } else {
            self.quarantine("emergency_stop_failed")
        }
    }

    pub fn clear_quarantine_after_local_review(
        &mut self,
        host_recertified: bool,
    ) -> Result<(), &'static str> {
        self.require_state(HostWorkloadState::Quarantined)?;
        if !host_recertified {
            return Err("host_recertification_required");
        }
        self.active_reservation = None;
        self.mining_enabled = false;
        self.last_error = None;
        self.state = HostWorkloadState::Available;
        Ok(())
    }

    pub fn snapshot(&self) -> OrchestrationSnapshot {
        OrchestrationSnapshot {
            state: self.state,
            mining_enabled: self.mining_enabled,
            active_reservation_id: self
                .active_reservation
                .as_ref()
                .map(|reservation| reservation.reservation_id.clone()),
            active_gpu_id: self
                .active_reservation
                .as_ref()
                .map(|reservation| reservation.gpu_id.clone()),
            last_error: self.last_error,
        }
    }

    fn require_state(&self, expected: HostWorkloadState) -> Result<(), &'static str> {
        if self.state == expected {
            Ok(())
        } else {
            Err("orchestration_transition_not_allowed")
        }
    }

    fn quarantine<T>(&mut self, error: &'static str) -> Result<T, &'static str> {
        self.state = HostWorkloadState::Quarantined;
        self.last_error = Some(error);
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reservation() -> VerifiedReservation {
        VerifiedReservation {
            reservation_id: "reservation_001".into(),
            machine_id: "machine_001".into(),
            renter_id: "renter_001".into(),
            gpu_id: "gpu_0".into(),
            funded: true,
            starts_at_unix_seconds: 1_000,
            ends_at_unix_seconds: 2_000,
        }
    }

    fn ready_host() -> RentalOrchestrator {
        let mut orchestrator = RentalOrchestrator::new("machine_001".into()).unwrap();
        orchestrator.certify_host().unwrap();
        orchestrator
    }

    #[test]
    fn unfunded_reservation_is_rejected() {
        let mut orchestrator = ready_host();
        let mut candidate = reservation();
        candidate.funded = false;
        assert_eq!(
            orchestrator.accept_reservation(candidate, 1_100),
            Err("reservation_not_funded")
        );
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::Available);
    }

    #[test]
    fn rental_preempts_mining_and_resumes_only_after_verified_cleanup() {
        let mut orchestrator = ready_host();
        orchestrator.set_mining_enabled(true).unwrap();
        orchestrator.accept_reservation(reservation(), 1_100).unwrap();
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::StoppingMining);
        orchestrator.confirm_mining_stopped(true).unwrap();
        orchestrator.confirm_workspace_ready(true, true, true).unwrap();
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::RentalActive);
        orchestrator.finish_rental().unwrap();
        orchestrator.confirm_cleanup(true, true, true, true, true).unwrap();
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::Mining);
    }

    #[test]
    fn failed_miner_stop_blocks_rental_and_quarantines_host() {
        let mut orchestrator = ready_host();
        orchestrator.set_mining_enabled(true).unwrap();
        orchestrator.accept_reservation(reservation(), 1_100).unwrap();
        assert_eq!(
            orchestrator.confirm_mining_stopped(false),
            Err("miner_process_still_running")
        );
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::Quarantined);
    }

    #[test]
    fn workspace_requires_all_security_proofs() {
        let mut orchestrator = ready_host();
        orchestrator.accept_reservation(reservation(), 1_100).unwrap();
        assert_eq!(
            orchestrator.confirm_workspace_ready(true, false, true),
            Err("gpu_exclusivity_unverified")
        );
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::Quarantined);
    }

    #[test]
    fn failed_cleanup_never_returns_host_to_available_or_mining() {
        let mut orchestrator = ready_host();
        orchestrator.accept_reservation(reservation(), 1_100).unwrap();
        orchestrator.confirm_workspace_ready(true, true, true).unwrap();
        orchestrator.finish_rental().unwrap();
        assert_eq!(
            orchestrator.confirm_cleanup(true, true, false, true, true),
            Err("cleanup_verification_failed")
        );
        assert_eq!(orchestrator.snapshot().state, HostWorkloadState::Quarantined);
    }
}
