#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_configuration_store.rs"]
mod mining_configuration_store;

use mining_configuration::{MiningConfiguration, PoolConnectionEvidence, PoolMode};
use mining_configuration_store::MiningConfigurationStore;

fn configuration(worker_name: &str) -> MiningConfiguration {
    MiningConfiguration {
        enabled: true,
        auto_mine_when_idle: true,
        cryptocurrency: "KAS".into(),
        miner_profile_id: "lolminer_kaspa".into(),
        pool_mode: PoolMode::Custom,
        custom_pool_url: Some("stratum+tls://pool.example.com:443".into()),
        wallet_address: "kaspa:qownerwallet".into(),
        worker_name: worker_name.into(),
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
fn owner_configuration_requires_fresh_matching_connection_evidence() {
    let mut store = MiningConfigurationStore::default();
    store.save(configuration("worker_a")).unwrap();
    assert_eq!(
        store.verified_configuration(1_010, 60),
        Err("mining_pool_connection_test_required")
    );

    store.record_connection_evidence(evidence()).unwrap();
    assert!(store.verified_configuration(1_010, 60).is_ok());
    assert_eq!(
        store.verified_configuration(2_000, 60),
        Err("mining_pool_connection_test_required")
    );
}

#[test]
fn any_configuration_change_revokes_previous_connection_proof() {
    let mut store = MiningConfigurationStore::default();
    store.save(configuration("worker_a")).unwrap();
    store.record_connection_evidence(evidence()).unwrap();
    store.save(configuration("worker_b")).unwrap();

    assert_eq!(
        store.verified_configuration(1_010, 60),
        Err("mining_pool_connection_test_required")
    );
    assert_eq!(store.view(1_010, 60).unwrap().revision, 2);
}

#[test]
fn clearing_configuration_removes_all_launch_authority() {
    let mut store = MiningConfigurationStore::default();
    store.save(configuration("worker_a")).unwrap();
    store.record_connection_evidence(evidence()).unwrap();
    store.clear();

    assert_eq!(
        store.verified_configuration(1_010, 60),
        Err("mining_configuration_missing")
    );
    assert!(!store.view(1_010, 60).unwrap().configured);
}
