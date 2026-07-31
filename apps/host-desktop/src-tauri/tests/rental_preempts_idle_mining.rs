#[path = "../src/rental_mining_coordinator.rs"]
mod rental_mining_coordinator;

use rental_mining_coordinator::{
    CoordinatedGpuState, MiningConsent, RentalCleanupProof, RentalMiningCoordinator, StopProof,
};

fn verified_stop_proof() -> StopProof {
    StopProof {
        process_tree_exited: true,
        gpu_handles_released: true,
        temporary_files_removed: true,
        miner_container_removed: true,
        utilization_below_threshold: true,
        temperature_below_threshold: true,
    }
}

fn verified_cleanup_proof() -> RentalCleanupProof {
    RentalCleanupProof {
        workspace_destroyed: true,
        credentials_revoked: true,
        storage_clean: true,
        network_clean: true,
        gpu_healthy: true,
        renter_processes_absent: true,
    }
}

fn complete_verified_rental(coordinator: &mut RentalMiningCoordinator, reservation_id: &str) {
    coordinator
        .reservation_requested(reservation_id.into())
        .unwrap();
    if coordinator.snapshot().should_stop_mining {
        coordinator
            .confirm_mining_stopped(verified_stop_proof())
            .unwrap();
    }
    coordinator.confirm_rental_ready(true, true, true).unwrap();
    coordinator.start_rental().unwrap();
    coordinator.finish_rental().unwrap();
    coordinator
        .confirm_rental_cleanup(verified_cleanup_proof())
        .unwrap();
}

#[test]
fn rental_preempts_active_mining_and_resumes_only_when_enabled() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::ManagedPool)
        .unwrap();
    coordinator.set_auto_resume_after_rental(true).unwrap();
    coordinator.request_idle_mining_start().unwrap();
    coordinator.confirm_mining_started().unwrap();

    coordinator
        .reservation_requested("reservation_001".into())
        .unwrap();
    let preempting = coordinator.snapshot();
    assert_eq!(preempting.state, CoordinatedGpuState::PreemptingMining);
    assert!(preempting.should_stop_mining);
    assert!(!preempting.rental_may_start);

    coordinator
        .confirm_mining_stopped(verified_stop_proof())
        .unwrap();
    assert_eq!(
        coordinator.snapshot().state,
        CoordinatedGpuState::VerifyingRentalReadiness
    );

    coordinator.confirm_rental_ready(true, true, true).unwrap();
    assert!(coordinator.snapshot().rental_may_start);
    coordinator.start_rental().unwrap();
    assert_eq!(
        coordinator.snapshot().state,
        CoordinatedGpuState::RentalActive
    );

    coordinator.finish_rental().unwrap();
    assert_eq!(
        coordinator.snapshot().state,
        CoordinatedGpuState::CleaningRental
    );
    coordinator
        .confirm_rental_cleanup(verified_cleanup_proof())
        .unwrap();

    let resumed = coordinator.snapshot();
    assert_eq!(resumed.state, CoordinatedGpuState::Idle);
    assert!(resumed.auto_resume_after_rental);
    assert!(resumed.should_start_mining);
    assert_eq!(resumed.consent, MiningConsent::ManagedPool);
    assert!(resumed.reservation_id.is_none());
}

#[test]
fn default_policy_does_not_resume_after_verified_cleanup() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::ManagedPool)
        .unwrap();
    coordinator.request_idle_mining_start().unwrap();
    coordinator.confirm_mining_started().unwrap();

    complete_verified_rental(&mut coordinator, "reservation_default_off");

    let snapshot = coordinator.snapshot();
    assert!(!snapshot.auto_resume_after_rental);
    assert!(!snapshot.should_start_mining);
}

#[test]
fn enabled_policy_does_not_start_a_gpu_that_was_idle() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::ManagedPool)
        .unwrap();
    coordinator.set_auto_resume_after_rental(true).unwrap();

    complete_verified_rental(&mut coordinator, "reservation_idle");

    assert!(!coordinator.snapshot().should_start_mining);
}

#[test]
fn incomplete_stop_proof_quarantines_and_blocks_rental() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::OwnerPool)
        .unwrap();
    coordinator.set_auto_resume_after_rental(true).unwrap();
    coordinator.request_idle_mining_start().unwrap();
    coordinator.confirm_mining_started().unwrap();
    coordinator
        .reservation_requested("reservation_002".into())
        .unwrap();

    let mut incomplete = verified_stop_proof();
    incomplete.gpu_handles_released = false;

    assert_eq!(
        coordinator.confirm_mining_stopped(incomplete),
        Err("mining_stop_proof_failed")
    );
    let quarantined = coordinator.snapshot();
    assert_eq!(quarantined.state, CoordinatedGpuState::Quarantined);
    assert!(!quarantined.rental_may_start);
    assert!(!quarantined.should_start_mining);
    assert_eq!(quarantined.last_error, Some("mining_stop_proof_failed"));
}

#[test]
fn reservation_blocks_new_mining_before_rental_readiness() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::ManagedPool)
        .unwrap();
    coordinator
        .reservation_requested("reservation_003".into())
        .unwrap();

    assert_eq!(
        coordinator.request_idle_mining_start(),
        Err("reservation_has_priority")
    );
    assert_eq!(
        coordinator.snapshot().state,
        CoordinatedGpuState::VerifyingRentalReadiness
    );
}

#[test]
fn cleanup_failure_prevents_resume_and_keeps_gpu_quarantined() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::ManagedPool)
        .unwrap();
    coordinator.set_auto_resume_after_rental(true).unwrap();
    coordinator.request_idle_mining_start().unwrap();
    coordinator.confirm_mining_started().unwrap();
    coordinator
        .reservation_requested("reservation_004".into())
        .unwrap();
    coordinator
        .confirm_mining_stopped(verified_stop_proof())
        .unwrap();
    coordinator.confirm_rental_ready(true, true, true).unwrap();
    coordinator.start_rental().unwrap();
    coordinator.finish_rental().unwrap();

    let mut incomplete = verified_cleanup_proof();
    incomplete.renter_processes_absent = false;
    assert_eq!(
        coordinator.confirm_rental_cleanup(incomplete),
        Err("rental_cleanup_proof_failed")
    );

    let quarantined = coordinator.snapshot();
    assert_eq!(quarantined.state, CoordinatedGpuState::Quarantined);
    assert!(!quarantined.should_start_mining);
    assert_eq!(quarantined.last_error, Some("rental_cleanup_proof_failed"));
}

#[test]
fn emergency_stop_is_fail_closed_until_shutdown_is_verified() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .set_owner_consent(MiningConsent::ManagedPool)
        .unwrap();
    coordinator.request_idle_mining_start().unwrap();

    assert_eq!(
        coordinator.emergency_stop(false),
        Err("emergency_stop_failed")
    );
    let quarantined = coordinator.snapshot();
    assert_eq!(quarantined.state, CoordinatedGpuState::Quarantined);
    assert!(!quarantined.should_start_mining);

    let mut coordinator = RentalMiningCoordinator::default();
    coordinator.emergency_stop(true).unwrap();
    assert_eq!(
        coordinator.snapshot().state,
        CoordinatedGpuState::EmergencyStopped
    );
}
