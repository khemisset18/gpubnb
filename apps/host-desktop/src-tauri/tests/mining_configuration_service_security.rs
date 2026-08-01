#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_configuration_store.rs"]
mod mining_configuration_store;
#[path = "../src/mining_configuration_service.rs"]
mod mining_configuration_service;

use mining_configuration::{
    MiningConfiguration, MiningConfigurationActor, PoolConnectionEvidence, PoolMode,
};
use mining_configuration_service::MiningConfigurationService;

fn configuration(worker: &str) -> MiningConfiguration {
    MiningConfiguration {
        enabled: true,
        auto_mine_when_idle: true,
        cryptocurrency: "KAS".into(),
        miner_profile_id: "lolminer_kaspa".into(),
        pool_mode: PoolMode::Custom,
        custom_pool_url: Some("stratum+tls://pool.example.com:443".into()),
        wallet_address: "kaspa:qownerwallet".into(),
        worker_name: worker.into(),
        pool_credential_ref: Some("secret_pool_001".into()),
    }
}

fn evidence() -> PoolConnectionEvidence {
    PoolConnectionEvidence {
        pool_url: "stratum+tls://pool.example.com:443".into(),
        dns_resolved: true,
        tcp_connected: true,
        tls_verified: true,
        verified_at_unix_seconds: 1_000,
    }
}

#[test]
fn only_owner_can_mutate_configuration() {
    let mut service = MiningConfigurationService::default();
    assert_eq!(
        service.save(
            MiningConfigurationActor::HostService,
            0,
            configuration("worker_a"),
        ),
        Err("mining_configuration_change_forbidden")
    );
    assert!(!service.view(1_000).unwrap().configured);
}

#[test]
fn optimistic_revision_prevents_lost_updates() {
    let mut service = MiningConfigurationService::default();
    let first = service
        .save(
            MiningConfigurationActor::HostOwner,
            0,
            configuration("worker_a"),
        )
        .unwrap();
    assert_eq!(first.revision, 1);

    assert_eq!(
        service.save(
            MiningConfigurationActor::HostOwner,
            0,
            configuration("worker_b"),
        ),
        Err("mining_configuration_revision_conflict")
    );
}

#[test]
fn configuration_change_revokes_ready_authority() {
    let mut service = MiningConfigurationService::default();
    service
        .save(
            MiningConfigurationActor::HostOwner,
            0,
            configuration("worker_a"),
        )
        .unwrap();
    service
        .record_connection_evidence(MiningConfigurationActor::HostOwner, 1, evidence())
        .unwrap();
    assert!(service.require_ready_configuration(1_010).is_ok());

    service
        .save(
            MiningConfigurationActor::HostOwner,
            1,
            configuration("worker_b"),
        )
        .unwrap();
    assert_eq!(
        service.require_ready_configuration(1_010),
        Err("mining_pool_connection_test_required")
    );
}

#[test]
fn frontend_view_never_exposes_secret_reference() {
    let mut service = MiningConfigurationService::default();
    let view = service
        .save(
            MiningConfigurationActor::HostOwner,
            0,
            configuration("worker_a"),
        )
        .unwrap();
    let json = serde_json::to_string(&view).unwrap();
    assert!(json.contains("hasPoolCredential"));
    assert!(!json.contains("secret_pool_001"));
    assert!(!json.contains("poolCredentialRef"));
}
