#[path = "../src/rental_orchestrator.rs"]
mod rental_orchestrator;

use rental_orchestrator::{HostWorkloadState, RentalOrchestrator, VerifiedReservation};

fn reservation() -> VerifiedReservation {
    VerifiedReservation {
        reservation_id: "reservation_e2e_001".into(),
        machine_id: "machine_e2e_001".into(),
        renter_id: "renter_e2e_001".into(),
        gpu_id: "gpu_0".into(),
        funded: true,
        starts_at_unix_seconds: 10_000,
        ends_at_unix_seconds: 20_000,
    }
}

#[test]
fn complete_idle_mining_rental_cleanup_resume_cycle() {
    let mut host = RentalOrchestrator::new("machine_e2e_001".into()).unwrap();

    host.certify_host().unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::Available);

    host.set_mining_enabled(true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::Mining);

    host.accept_reservation(reservation(), 11_000).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::StoppingMining);

    host.confirm_mining_stopped(true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::PreparingRental);

    host.confirm_workspace_ready(true, true, true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::RentalActive);

    host.finish_rental().unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::CleaningRental);

    host.confirm_cleanup(true, true, true, true, true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::Mining);
    assert!(host.snapshot().active_reservation_id.is_none());
}

#[test]
fn security_failure_requires_local_recertification() {
    let mut host = RentalOrchestrator::new("machine_e2e_001".into()).unwrap();
    host.certify_host().unwrap();
    host.accept_reservation(reservation(), 11_000).unwrap();

    assert_eq!(
        host.confirm_workspace_ready(false, true, true),
        Err("workspace_isolation_unverified")
    );
    assert_eq!(host.snapshot().state, HostWorkloadState::Quarantined);
    assert_eq!(
        host.clear_quarantine_after_local_review(false),
        Err("host_recertification_required")
    );

    host.clear_quarantine_after_local_review(true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::Available);
    assert!(!host.snapshot().mining_enabled);
}

#[test]
fn emergency_stop_is_fail_closed_until_every_process_is_confirmed_stopped() {
    let mut host = RentalOrchestrator::new("machine_e2e_001".into()).unwrap();
    host.certify_host().unwrap();
    host.set_mining_enabled(true).unwrap();

    assert_eq!(host.emergency_stop(false), Err("emergency_stop_failed"));
    assert_eq!(host.snapshot().state, HostWorkloadState::Quarantined);
    assert_eq!(host.snapshot().last_error, Some("emergency_stop_failed"));

    host.clear_quarantine_after_local_review(true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::Available);

    host.emergency_stop(true).unwrap();
    assert_eq!(host.snapshot().state, HostWorkloadState::EmergencyStopped);
    assert!(host.snapshot().active_reservation_id.is_none());
}
