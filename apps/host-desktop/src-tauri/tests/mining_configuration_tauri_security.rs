#![allow(dead_code)]

#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_configuration_commands.rs"]
mod mining_configuration_commands;
#[path = "../src/mining_configuration_service.rs"]
mod mining_configuration_service;
#[path = "../src/mining_configuration_store.rs"]
mod mining_configuration_store;
#[path = "../src/mining_configuration_tauri.rs"]
mod mining_configuration_tauri;
#[path = "../src/mining_pool_probe.rs"]
mod mining_pool_probe;

use mining_configuration::{MiningConfiguration, MiningConfigurationActor, PoolMode};
use mining_configuration_tauri::MiningConfigurationState;

fn configuration(pool_url: &str) -> MiningConfiguration {
    MiningConfiguration {
        enabled: true,
        auto_mine_when_idle: true,
        performance_mode: Default::default(),
        cryptocurrency: "KAS".into(),
        miner_profile_id: "lolminer_kaspa".into(),
        pool_mode: PoolMode::Custom,
        custom_pool_url: Some(pool_url.into()),
        wallet_address: "kaspa:qownerwallet".into(),
        worker_name: "rig-01".into(),
        pool_credential_ref: Some("secret_pool_001".into()),
    }
}

#[test]
fn state_round_trip_never_exposes_secret_reference() {
    let state = MiningConfigurationState::in_memory();
    let saved = state
        .save(0, configuration("stratum+tcp://127.0.0.1:1"))
        .unwrap();
    let read = state.get().unwrap();
    assert_eq!(read, saved);
    let json = serde_json::to_string(&read).unwrap();
    assert!(json.contains("hasPoolCredential"));
    assert!(!json.contains("secret_pool_001"));
    assert!(!json.contains("poolCredentialRef"));
}

#[test]
fn stale_revision_is_rejected_by_shared_state() {
    let state = MiningConfigurationState::in_memory();
    state
        .save(0, configuration("stratum+tcp://127.0.0.1:1"))
        .unwrap();
    assert_eq!(
        state.save(0, configuration("stratum+tcp://127.0.0.1:2")),
        Err("mining_configuration_revision_conflict")
    );
}

#[test]
fn connection_test_uses_saved_pool_url_and_fails_closed() {
    let state = MiningConfigurationState::in_memory();
    let saved = state
        .save(0, configuration("https://pool.example.com:443"))
        .unwrap_err();
    assert_eq!(saved, "mining_pool_scheme_not_allowed");

    let saved = state
        .save(0, configuration("stratum+tls://pool.example.com:443"))
        .unwrap();
    assert_eq!(
        state.test_connection(saved.revision),
        Err("mining_pool_dns_unverified")
    );
    assert_eq!(
        state.require_ready(),
        Err("mining_pool_connection_test_required")
    );
}

#[test]
fn clear_removes_configuration_and_launch_authority() {
    let state = MiningConfigurationState::in_memory();
    let saved = state
        .save(0, configuration("stratum+tcp://127.0.0.1:1"))
        .unwrap();
    let cleared = state.clear(saved.revision).unwrap();
    assert!(!cleared.configured);
    assert_eq!(state.require_ready(), Err("mining_configuration_missing"));
}

#[test]
fn host_service_actor_remains_non_authoritative() {
    assert_eq!(
        MiningConfigurationActor::HostService,
        MiningConfigurationActor::HostService
    );
}
