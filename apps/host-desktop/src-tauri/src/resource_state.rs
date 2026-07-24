use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceState {
    #[default]
    Offline,
    Idle,
    Mining,
    StoppingMiner,
    PreparingRental,
    Rental,
    Cleaning,
    EmergencyStopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceEvent {
    HostCertified,
    MiningEnabled,
    MiningDisabled,
    ReservationReceived,
    MinerStoppedCleanly,
    RentalWorkspaceReady,
    RentalFinished,
    CleanupVerified,
    EmergencyStop,
    SecurityInvalidated,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceController {
    pub state: ResourceState,
    pub mining_enabled: bool,
}

impl ResourceController {
    pub fn apply(&mut self, event: ResourceEvent) -> Result<ResourceState, &'static str> {
        if event == ResourceEvent::EmergencyStop {
            self.state = ResourceState::EmergencyStopped;
            return Ok(self.state);
        }

        if event == ResourceEvent::SecurityInvalidated {
            self.state = ResourceState::Offline;
            return Ok(self.state);
        }

        self.state = match (self.state, event) {
            (ResourceState::Offline, ResourceEvent::HostCertified) => ResourceState::Idle,
            (ResourceState::Idle, ResourceEvent::MiningEnabled) => {
                self.mining_enabled = true;
                ResourceState::Mining
            }
            (ResourceState::Idle, ResourceEvent::MiningDisabled) => {
                self.mining_enabled = false;
                ResourceState::Idle
            }
            (ResourceState::Mining, ResourceEvent::MiningDisabled) => {
                self.mining_enabled = false;
                ResourceState::StoppingMiner
            }
            (ResourceState::Mining, ResourceEvent::ReservationReceived) => {
                ResourceState::StoppingMiner
            }
            (ResourceState::Idle, ResourceEvent::ReservationReceived) => {
                ResourceState::PreparingRental
            }
            (ResourceState::StoppingMiner, ResourceEvent::MinerStoppedCleanly) => {
                ResourceState::PreparingRental
            }
            (ResourceState::PreparingRental, ResourceEvent::RentalWorkspaceReady) => {
                ResourceState::Rental
            }
            (ResourceState::Rental, ResourceEvent::RentalFinished) => ResourceState::Cleaning,
            (ResourceState::Cleaning, ResourceEvent::CleanupVerified) => {
                if self.mining_enabled {
                    ResourceState::Mining
                } else {
                    ResourceState::Idle
                }
            }
            (state, ResourceEvent::MiningDisabled)
                if matches!(state, ResourceState::Offline | ResourceState::EmergencyStopped) =>
            {
                self.mining_enabled = false;
                state
            }
            _ => return Err("resource_transition_not_allowed"),
        };

        Ok(self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rental_cannot_start_before_clean_miner_stop() {
        let mut controller = ResourceController {
            state: ResourceState::Mining,
            mining_enabled: true,
        };

        assert_eq!(
            controller.apply(ResourceEvent::ReservationReceived),
            Ok(ResourceState::StoppingMiner)
        );
        assert_eq!(
            controller.apply(ResourceEvent::RentalWorkspaceReady),
            Err("resource_transition_not_allowed")
        );
        assert_eq!(
            controller.apply(ResourceEvent::MinerStoppedCleanly),
            Ok(ResourceState::PreparingRental)
        );
    }

    #[test]
    fn rental_requires_workspace_readiness_proof() {
        let mut controller = ResourceController {
            state: ResourceState::Idle,
            mining_enabled: false,
        };

        controller
            .apply(ResourceEvent::ReservationReceived)
            .expect("reservation should enter preparation");
        assert_eq!(controller.state, ResourceState::PreparingRental);
        assert_eq!(
            controller.apply(ResourceEvent::RentalFinished),
            Err("resource_transition_not_allowed")
        );
        assert_eq!(
            controller.apply(ResourceEvent::RentalWorkspaceReady),
            Ok(ResourceState::Rental)
        );
    }

    #[test]
    fn mining_never_resumes_before_verified_cleanup() {
        let mut controller = ResourceController {
            state: ResourceState::Rental,
            mining_enabled: true,
        };

        controller
            .apply(ResourceEvent::RentalFinished)
            .expect("rental should enter cleanup");
        assert_eq!(controller.state, ResourceState::Cleaning);
        assert_eq!(
            controller.apply(ResourceEvent::MiningEnabled),
            Err("resource_transition_not_allowed")
        );
        assert_eq!(
            controller.apply(ResourceEvent::CleanupVerified),
            Ok(ResourceState::Mining)
        );
    }

    #[test]
    fn emergency_stop_is_available_from_every_state() {
        for state in [
            ResourceState::Offline,
            ResourceState::Idle,
            ResourceState::Mining,
            ResourceState::StoppingMiner,
            ResourceState::PreparingRental,
            ResourceState::Rental,
            ResourceState::Cleaning,
            ResourceState::EmergencyStopped,
        ] {
            let mut controller = ResourceController {
                state,
                mining_enabled: true,
            };
            assert_eq!(
                controller.apply(ResourceEvent::EmergencyStop),
                Ok(ResourceState::EmergencyStopped)
            );
        }
    }

    #[test]
    fn invalidated_security_forces_offline() {
        let mut controller = ResourceController {
            state: ResourceState::Rental,
            mining_enabled: true,
        };
        assert_eq!(
            controller.apply(ResourceEvent::SecurityInvalidated),
            Ok(ResourceState::Offline)
        );
    }
}