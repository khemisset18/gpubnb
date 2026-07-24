use crate::external_pool::ExternalPoolProfile;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationState {
    #[default]
    Offline,
    Idle,
    Mining,
    StoppingMining,
    PreparingRental,
    RentalActive,
    CleaningRental,
    Quarantined,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrchestrationEvent {
    HostCertified,
    MiningPreferenceEnabled,
    MiningPreferenceDisabled,
    ReservationConfirmed,
    MiningStoppedAndVerified,
    RentalWorkspaceReady,
    RentalEnded,
    CleanupVerified,
    SafetyFailure,
    LocalQuarantineCleared,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeOrchestrator {
    pub state: OrchestrationState,
    pub mining_preference_enabled: bool,
    pub reservation_pending: bool,
    pub external_pool: Option<ExternalPoolProfile>,
    pub last_error: Option<&'static str>,
}

impl ComputeOrchestrator {
    pub fn configure_external_pool(
        &mut self,
        profile: ExternalPoolProfile,
    ) -> Result<(), &'static str> {
        profile.validate()?;
        if matches!(
            self.state,
            OrchestrationState::Mining
                | OrchestrationState::StoppingMining
                | OrchestrationState::PreparingRental
                | OrchestrationState::RentalActive
                | OrchestrationState::CleaningRental
        ) {
            return Err("pool_change_requires_idle_host");
        }
        self.external_pool = Some(profile);
        Ok(())
    }

    pub fn apply(
        &mut self,
        event: OrchestrationEvent,
    ) -> Result<OrchestrationState, &'static str> {
        if event == OrchestrationEvent::SafetyFailure {
            self.state = OrchestrationState::Quarantined;
            self.reservation_pending = false;
            self.last_error = Some("orchestration_safety_failure");
            return Ok(self.state);
        }

        self.state = match (self.state, event) {
            (OrchestrationState::Offline, OrchestrationEvent::HostCertified) => {
                OrchestrationState::Idle
            }
            (OrchestrationState::Idle, OrchestrationEvent::MiningPreferenceEnabled) => {
                if self.external_pool.is_none() {
                    return Err("external_pool_not_configured");
                }
                self.mining_preference_enabled = true;
                OrchestrationState::Mining
            }
            (OrchestrationState::Idle, OrchestrationEvent::MiningPreferenceDisabled) => {
                self.mining_preference_enabled = false;
                OrchestrationState::Idle
            }
            (OrchestrationState::Mining, OrchestrationEvent::MiningPreferenceDisabled) => {
                self.mining_preference_enabled = false;
                OrchestrationState::StoppingMining
            }
            (OrchestrationState::Mining, OrchestrationEvent::ReservationConfirmed) => {
                self.reservation_pending = true;
                OrchestrationState::StoppingMining
            }
            (OrchestrationState::Idle, OrchestrationEvent::ReservationConfirmed) => {
                self.reservation_pending = true;
                OrchestrationState::PreparingRental
            }
            (
                OrchestrationState::StoppingMining,
                OrchestrationEvent::MiningStoppedAndVerified,
            ) => {
                if self.reservation_pending {
                    OrchestrationState::PreparingRental
                } else {
                    OrchestrationState::Idle
                }
            }
            (
                OrchestrationState::PreparingRental,
                OrchestrationEvent::RentalWorkspaceReady,
            ) if self.reservation_pending => {
                self.reservation_pending = false;
                OrchestrationState::RentalActive
            }
            (OrchestrationState::RentalActive, OrchestrationEvent::RentalEnded) => {
                OrchestrationState::CleaningRental
            }
            (OrchestrationState::CleaningRental, OrchestrationEvent::CleanupVerified) => {
                if self.mining_preference_enabled && self.external_pool.is_some() {
                    OrchestrationState::Mining
                } else {
                    OrchestrationState::Idle
                }
            }
            (
                OrchestrationState::Quarantined,
                OrchestrationEvent::LocalQuarantineCleared,
            ) => {
                self.last_error = None;
                OrchestrationState::Idle
            }
            _ => return Err("orchestration_transition_not_allowed"),
        };

        Ok(self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_pool::{MiningDevice, SupportedAsset};

    fn profile() -> ExternalPoolProfile {
        ExternalPoolProfile {
            asset: SupportedAsset::Monero,
            device: MiningDevice::Cpu,
            host: "pool.example.org".into(),
            port: 443,
            tls: true,
            wallet_address: "4".repeat(95),
            worker_name: "host-cpu-0".into(),
        }
    }

    fn mining_host() -> ComputeOrchestrator {
        let mut orchestrator = ComputeOrchestrator::default();
        orchestrator
            .apply(OrchestrationEvent::HostCertified)
            .expect("host should become idle");
        orchestrator
            .configure_external_pool(profile())
            .expect("profile should be valid");
        orchestrator
            .apply(OrchestrationEvent::MiningPreferenceEnabled)
            .expect("mining should start");
        orchestrator
    }

    #[test]
    fn full_rental_cycle_stops_and_resumes_mining() {
        let mut orchestrator = mining_host();

        assert_eq!(
            orchestrator.apply(OrchestrationEvent::ReservationConfirmed),
            Ok(OrchestrationState::StoppingMining)
        );
        assert_eq!(
            orchestrator.apply(OrchestrationEvent::MiningStoppedAndVerified),
            Ok(OrchestrationState::PreparingRental)
        );
        assert_eq!(
            orchestrator.apply(OrchestrationEvent::RentalWorkspaceReady),
            Ok(OrchestrationState::RentalActive)
        );
        assert_eq!(
            orchestrator.apply(OrchestrationEvent::RentalEnded),
            Ok(OrchestrationState::CleaningRental)
        );
        assert_eq!(
            orchestrator.apply(OrchestrationEvent::CleanupVerified),
            Ok(OrchestrationState::Mining)
        );
    }

    #[test]
    fn rental_never_starts_before_verified_miner_stop() {
        let mut orchestrator = mining_host();
        orchestrator
            .apply(OrchestrationEvent::ReservationConfirmed)
            .expect("reservation should request miner stop");

        assert_eq!(
            orchestrator.apply(OrchestrationEvent::RentalWorkspaceReady),
            Err("orchestration_transition_not_allowed")
        );
    }

    #[test]
    fn mining_never_resumes_before_cleanup_verification() {
        let mut orchestrator = mining_host();
        orchestrator
            .apply(OrchestrationEvent::ReservationConfirmed)
            .unwrap();
        orchestrator
            .apply(OrchestrationEvent::MiningStoppedAndVerified)
            .unwrap();
        orchestrator
            .apply(OrchestrationEvent::RentalWorkspaceReady)
            .unwrap();
        orchestrator.apply(OrchestrationEvent::RentalEnded).unwrap();

        assert_eq!(orchestrator.state, OrchestrationState::CleaningRental);
        assert_eq!(
            orchestrator.apply(OrchestrationEvent::MiningPreferenceEnabled),
            Err("orchestration_transition_not_allowed")
        );
    }

    #[test]
    fn safety_failure_quarantines_from_any_active_state() {
        for state in [
            OrchestrationState::Mining,
            OrchestrationState::StoppingMining,
            OrchestrationState::PreparingRental,
            OrchestrationState::RentalActive,
            OrchestrationState::CleaningRental,
        ] {
            let mut orchestrator = ComputeOrchestrator {
                state,
                mining_preference_enabled: true,
                reservation_pending: true,
                external_pool: Some(profile()),
                last_error: None,
            };
            assert_eq!(
                orchestrator.apply(OrchestrationEvent::SafetyFailure),
                Ok(OrchestrationState::Quarantined)
            );
            assert!(!orchestrator.reservation_pending);
        }
    }
}
