#[path = "../src/mining_supervisor.rs"]
mod mining_supervisor;
#[path = "../src/resource_state.rs"]
mod resource_state;

use mining_supervisor::{ApprovedMiningConfig, MiningSupervisor};
use resource_state::{ResourceController, ResourceEvent, ResourceState};

fn approved_config() -> ApprovedMiningConfig {
    ApprovedMiningConfig {
        asset_id: "simulated-ravencoin".into(),
        miner_id: "gpubnb-fake-miner".into(),
        miner_version: "0.1.0".into(),
        wallet_address: "RExamplePublicAddressOnly123".into(),
        worker_name: "host-gpu-0".into(),
        gpu_id: "gpu-0".into(),
        maximum_temperature_c: 80,
        maximum_power_watts: 350,
    }
}

#[test]
fn full_simulated_mining_to_rental_handoff_is_fail_closed() {
    let mut resource = ResourceController::default();
    let mut miner = MiningSupervisor::default();

    resource
        .apply(ResourceEvent::HostCertified)
        .expect("certified host should become idle");
    resource
        .apply(ResourceEvent::MiningEnabled)
        .expect("owner should be able to enable simulated mining");
    miner
        .start_simulated(&approved_config(), true, false, true)
        .expect("approved simulation should start");

    assert_eq!(resource.state, ResourceState::Mining);
    assert!(!miner.is_gpu_released());

    resource
        .apply(ResourceEvent::ReservationReceived)
        .expect("reservation should request miner shutdown");
    assert_eq!(resource.state, ResourceState::StoppingMiner);

    assert_eq!(
        resource.apply(ResourceEvent::RentalWorkspaceReady),
        Err("resource_transition_not_allowed")
    );

    miner
        .stop_for_rental(true)
        .expect("simulated miner should stop cleanly");
    assert!(miner.is_gpu_released());

    resource
        .apply(ResourceEvent::MinerStoppedCleanly)
        .expect("clean miner stop should allow rental preparation");
    resource
        .apply(ResourceEvent::RentalWorkspaceReady)
        .expect("verified workspace should start rental");

    assert_eq!(resource.state, ResourceState::Rental);
    assert!(miner.is_gpu_released());
}

#[test]
fn failed_miner_stop_blocks_the_rental_and_quarantines_gpu() {
    let mut resource = ResourceController::default();
    let mut miner = MiningSupervisor::default();

    resource.apply(ResourceEvent::HostCertified).unwrap();
    resource.apply(ResourceEvent::MiningEnabled).unwrap();
    miner
        .start_simulated(&approved_config(), true, false, true)
        .unwrap();
    resource.apply(ResourceEvent::ReservationReceived).unwrap();

    assert_eq!(
        miner.stop_for_rental(false),
        Err("miner_process_still_running")
    );
    assert!(!miner.is_gpu_released());
    assert_eq!(resource.state, ResourceState::StoppingMiner);
    assert_eq!(
        resource.apply(ResourceEvent::RentalWorkspaceReady),
        Err("resource_transition_not_allowed")
    );
}

#[test]
fn mining_can_resume_only_after_verified_rental_cleanup() {
    let mut resource = ResourceController {
        state: ResourceState::Rental,
        mining_enabled: true,
        reservation_pending: false,
    };

    resource.apply(ResourceEvent::RentalFinished).unwrap();
    assert_eq!(resource.state, ResourceState::Cleaning);
    assert_eq!(
        resource.apply(ResourceEvent::MiningEnabled),
        Err("resource_transition_not_allowed")
    );
    resource.apply(ResourceEvent::CleanupVerified).unwrap();
    assert_eq!(resource.state, ResourceState::Mining);
}
