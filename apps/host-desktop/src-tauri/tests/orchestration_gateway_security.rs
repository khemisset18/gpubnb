#[path = "../src/rental_orchestrator.rs"]
mod rental_orchestrator;
#[path = "../src/orchestration_gateway.rs"]
mod orchestration_gateway;

use orchestration_gateway::{
    ActorRole, AuthenticatedContext, OrchestrationCommand, OrchestrationGateway,
};
use rental_orchestrator::{HostWorkloadState, VerifiedReservation};

fn context(role: ActorRole, request_id: &str, now: u64) -> AuthenticatedContext {
    AuthenticatedContext {
        request_id: request_id.into(),
        installation_id: "install_e2e_001".into(),
        actor_id: "actor_e2e_001".into(),
        actor_role: role,
        issued_at_unix_seconds: now,
    }
}

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
fn authorized_roles_complete_the_full_cycle_without_privilege_overlap() {
    let mut gateway = OrchestrationGateway::new(
        "install_e2e_001".into(),
        "machine_e2e_001".into(),
    )
    .unwrap();

    let certified = gateway
        .execute(
            context(ActorRole::LocalAdministrator, "request_001", 10_000),
            OrchestrationCommand::CertifyHost,
            10_000,
        )
        .unwrap();
    assert_eq!(certified.snapshot.state, HostWorkloadState::Available);

    let mining = gateway
        .execute(
            context(ActorRole::LocalAdministrator, "request_002", 10_001),
            OrchestrationCommand::SetMiningEnabled { enabled: true },
            10_001,
        )
        .unwrap();
    assert_eq!(mining.snapshot.state, HostWorkloadState::Mining);

    let stopping = gateway
        .execute(
            context(ActorRole::ControlPlane, "request_003", 11_000),
            OrchestrationCommand::AcceptReservation {
                reservation: reservation(),
            },
            11_000,
        )
        .unwrap();
    assert_eq!(stopping.snapshot.state, HostWorkloadState::StoppingMining);

    gateway
        .execute(
            context(ActorRole::HostService, "request_004", 11_001),
            OrchestrationCommand::ConfirmMiningStopped {
                process_exited: true,
            },
            11_001,
        )
        .unwrap();

    let active = gateway
        .execute(
            context(ActorRole::HostService, "request_005", 11_002),
            OrchestrationCommand::ConfirmWorkspaceReady {
                isolation_verified: true,
                gpu_attached_exclusively: true,
                temporary_access_issued: true,
            },
            11_002,
        )
        .unwrap();
    assert_eq!(active.snapshot.state, HostWorkloadState::RentalActive);

    gateway
        .execute(
            context(ActorRole::ControlPlane, "request_006", 12_000),
            OrchestrationCommand::FinishRental,
            12_000,
        )
        .unwrap();

    let resumed = gateway
        .execute(
            context(ActorRole::HostService, "request_007", 12_001),
            OrchestrationCommand::ConfirmCleanup {
                workspace_destroyed: true,
                access_revoked: true,
                gpu_healthy: true,
                storage_clean: true,
                network_clean: true,
            },
            12_001,
        )
        .unwrap();
    assert_eq!(resumed.snapshot.state, HostWorkloadState::Mining);
}

#[test]
fn expired_wrong_installation_and_replayed_requests_are_rejected() {
    let mut gateway = OrchestrationGateway::new(
        "install_e2e_001".into(),
        "machine_e2e_001".into(),
    )
    .unwrap();

    let mut wrong_installation = context(ActorRole::LocalAdministrator, "request_101", 1_000);
    wrong_installation.installation_id = "install_other".into();
    assert_eq!(
        gateway.execute(wrong_installation, OrchestrationCommand::ReadStatus, 1_000),
        Err("orchestration_installation_mismatch")
    );

    assert_eq!(
        gateway.execute(
            context(ActorRole::LocalAdministrator, "request_102", 1_000),
            OrchestrationCommand::ReadStatus,
            1_121,
        ),
        Err("orchestration_request_expired")
    );

    let replayed = context(ActorRole::LocalAdministrator, "request_103", 1_000);
    gateway
        .execute(replayed.clone(), OrchestrationCommand::ReadStatus, 1_000)
        .unwrap();
    assert_eq!(
        gateway.execute(replayed, OrchestrationCommand::ReadStatus, 1_000),
        Err("orchestration_request_replayed")
    );
}
