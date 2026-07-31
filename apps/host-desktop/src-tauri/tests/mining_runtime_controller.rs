#[path = "../src/mining_runtime_controller.rs"]
mod mining_runtime_controller;
#[path = "../src/rental_mining_coordinator.rs"]
mod rental_mining_coordinator;

use mining_runtime_controller::{MiningRuntimeController, RuntimeOrder};
use rental_mining_coordinator::{MiningConsent, RentalCleanupProof, StopProof};

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

fn authorize_and_start(
    runtime: &mut MiningRuntimeController,
    consent: MiningConsent,
    auto_resume: bool,
) {
    let consent_decision = runtime.set_owner_consent(consent).unwrap();
    assert_eq!(consent_decision.order, RuntimeOrder::Noop);

    let policy_decision = runtime
        .set_auto_resume_after_rental(auto_resume)
        .unwrap();
    assert_eq!(policy_decision.order, RuntimeOrder::Noop);

    let start = runtime.request_idle_mining_start().unwrap();
    assert_eq!(start.order, RuntimeOrder::StartApprovedMiner);
}

#[test]
fn full_cycle_stops_mining_before_rental_and_restarts_after_cleanup() {
    let mut runtime = MiningRuntimeController::default();
    authorize_and_start(&mut runtime, MiningConsent::ManagedPool, true);

    runtime.mining_started().unwrap();
    let stop = runtime
        .reservation_confirmed("reservation-001".into())
        .unwrap();
    assert_eq!(stop.order, RuntimeOrder::StopMinerForRental);

    let prepare = runtime.mining_stopped(stop_proof()).unwrap();
    assert_eq!(prepare.order, RuntimeOrder::PrepareRentalWorkspace);

    let start_rental = runtime.rental_ready(true, true, true).unwrap();
    assert_eq!(start_rental.order, RuntimeOrder::StartRentalWorkspace);
    runtime.rental_started().unwrap();

    let destroy = runtime.rental_finished().unwrap();
    assert_eq!(destroy.order, RuntimeOrder::DestroyRentalWorkspace);

    let restart = runtime.rental_cleanup_verified(cleanup_proof()).unwrap();
    assert_eq!(restart.order, RuntimeOrder::StartApprovedMiner);
}

#[test]
fn duplicate_reconciliation_never_emits_duplicate_process_start() {
    let mut runtime = MiningRuntimeController::default();
    authorize_and_start(&mut runtime, MiningConsent::OwnerPool, false);

    let duplicate = runtime.reconcile("duplicate_heartbeat");
    assert_eq!(duplicate.order, RuntimeOrder::Noop);
}

#[test]
fn reservation_during_miner_start_is_still_preempted() {
    let mut runtime = MiningRuntimeController::default();
    authorize_and_start(&mut runtime, MiningConsent::ManagedPool, true);

    let stop = runtime
        .reservation_confirmed("reservation-002".into())
        .unwrap();
    assert_eq!(stop.order, RuntimeOrder::StopMinerForRental);
}

#[test]
fn disabled_consent_does_not_restart_mining_after_rental() {
    let mut runtime = MiningRuntimeController::default();
    runtime
        .reservation_confirmed("reservation-003".into())
        .unwrap();
    runtime.rental_ready(true, true, true).unwrap();
    runtime.rental_started().unwrap();
    runtime.rental_finished().unwrap();

    let decision = runtime.rental_cleanup_verified(cleanup_proof()).unwrap();
    assert_eq!(decision.order, RuntimeOrder::Noop);
}
