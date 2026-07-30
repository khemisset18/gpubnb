#[path = "../src/rental_mining_coordinator.rs"]
mod rental_mining_coordinator;

use rental_mining_coordinator::{
    MiningConsent, MiningPoolPreference, RentalCleanupProof, RentalMiningCoordinator,
    StopMiningProof, WorkloadState,
};

fn managed_consent() -> MiningConsent {
    MiningConsent {
        enabled: true,
        auto_resume_after_rental: true,
        pool_preference: MiningPoolPreference::GpuBnbManaged,
    }
}

fn clean_stop_proof() -> StopMiningProof {
    StopMiningProof {
        process_tree_exited: true,
        gpu_handles_released: true,
        container_removed: true,
        temporary_files_removed: true,
        utilization_below_threshold: true,
        temperature_below_threshold: true,
    }
}

fn clean_rental_proof() -> RentalCleanupProof {
    RentalCleanupProof {
        workspace_destroyed: true,
        temporary_access_revoked: true,
        storage_clean: true,
        network_clean: true,
        gpu_healthy: true,
        renter_processes_absent: true,
    }
}

#[test]
fn rental_preempts_active_mining_and_resumes_after_verified_cleanup() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator.update_owner_consent(managed_consent()).unwrap();
    coordinator.confirm_mining_started().unwrap();

    coordinator
        .reservation_confirmed("reservation_001".into())
        .unwrap();
    assert_eq!(coordinator.snapshot().state, WorkloadState::PreemptingMining);
    assert!(!coordinator.snapshot().should_start_mining);

    coordinator.confirm_mining_stopped(clean_stop_proof()).unwrap();
    assert_eq!(coordinator.snapshot().state, WorkloadState::RentalReady);

    coordinator.confirm_rental_started().unwrap();
    assert_eq!(coordinator.snapshot().state, WorkloadState::RentalActive);

    coordinator.confirm_rental_finished().unwrap();
    assert_eq!(coordinator.snapshot().state, WorkloadState::CleaningRental);

    coordinator.confirm_rental_cleanup(clean_rental_proof()).unwrap();
    let snapshot = coordinator.snapshot();
    assert_eq!(snapshot.state, WorkloadState::Idle);
    assert!(snapshot.should_start_mining);
    assert_eq!(snapshot.pool_preference, MiningPoolPreference::GpuBnbManaged);
}

#[test]
fn incomplete_stop_proof_quarantines_and_blocks_rental() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator.update_owner_consent(managed_consent()).unwrap();
    coordinator.confirm_mining_started().unwrap();
    coordinator
        .reservation_confirmed("reservation_002".into())
        .unwrap();

    let mut incomplete = clean_stop_proof();
    incomplete.gpu_handles_released = false;

    assert_eq!(
        coordinator.confirm_mining_stopped(incomplete),
        Err("mining_cleanup_verification_failed")
    );
    assert_eq!(coordinator.snapshot().state, WorkloadState::Quarantined);
    assert!(!coordinator.snapshot().should_start_mining);
}

#[test]
fn disabling_auto_resume_keeps_gpu_idle_after_rental() {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator
        .update_owner_consent(MiningConsent {
            enabled: true,
            auto_resume_after_rental: false,
            pool_preference: MiningPoolPreference::OwnerCustom,
        })
        .unwrap();

    coordinator
        .reservation_confirmed("reservation_003".into())
        .unwrap();
    coordinator.confirm_rental_started().unwrap();
    coordinator.confirm_rental_finished().unwrap();
    coordinator.confirm_rental_cleanup(clean_rental_proof()).unwrap();

    let snapshot = coordinator.snapshot();
    assert_eq!(snapshot.state, WorkloadState::Idle);
    assert!(!snapshot.should_start_mining);
    assert_eq!(snapshot.pool_preference, MiningPoolPreference::OwnerCustom);
}
