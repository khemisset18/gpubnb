#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_configuration_commands.rs"]
mod mining_configuration_commands;
#[path = "../src/mining_configuration_service.rs"]
mod mining_configuration_service;
#[path = "../src/mining_configuration_store.rs"]
mod mining_configuration_store;
#[path = "../src/mining_pool_probe.rs"]
mod mining_pool_probe;

use mining_configuration::{MiningConfiguration, PoolMode};
use mining_configuration_commands::MiningConfigurationCommands;

fn configuration(worker_name: &str) -> MiningConfiguration {
    MiningConfiguration {
        enabled: true,
        auto_mine_when_idle: true,
        cryptocurrency: "KAS".into(),
        miner_profile_id: "lolminer_kaspa".into(),
        pool_mode: PoolMode::Custom,
        custom_pool_url: Some("stratum+tcp://127.0.0.1:1".into()),
        wallet_address: "kaspa:qownerwallet".into(),
        worker_name: worker_name.into(),
        pool_credential_ref: Some("secret_pool_001".into()),
    }
}

#[test]
fn command_views_never_expose_secret_references() {
    let mut commands = MiningConfigurationCommands::default();
    let view = commands.save(0, configuration("rig-01")).unwrap();
    let json = serde_json::to_string(&view).unwrap();
    assert!(json.contains("hasPoolCredential"));
    assert!(!json.contains("secret_pool_001"));
    assert!(!json.contains("poolCredentialRef"));
}

#[test]
fn stale_revision_is_rejected_before_mutation() {
    let mut commands = MiningConfigurationCommands::default();
    commands.save(0, configuration("rig-01")).unwrap();
    assert_eq!(
        commands.save(0, configuration("rig-02")),
        Err("mining_configuration_revision_conflict")
    );
}

#[test]
fn start_authority_is_absent_until_connection_test_is_ready() {
    let mut commands = MiningConfigurationCommands::default();
    commands.save(0, configuration("rig-01")).unwrap();
    assert_eq!(
        commands.require_ready(),
        Err("mining_pool_connection_test_required")
    );
}

#[test]
fn failed_probe_does_not_manufacture_connection_evidence() {
    let mut commands = MiningConfigurationCommands::default();
    let saved = commands.save(0, configuration("rig-01")).unwrap();
    assert_eq!(
        commands.test_connection(saved.revision, "https://pool.example.com:443"),
        Err("mining_pool_scheme_not_allowed")
    );
    assert_eq!(
        commands.require_ready(),
        Err("mining_pool_connection_test_required")
    );
}

#[test]
fn clear_removes_configuration_and_increments_revision() {
    let mut commands = MiningConfigurationCommands::default();
    let saved = commands.save(0, configuration("rig-01")).unwrap();
    let cleared = commands.clear(saved.revision).unwrap();
    assert!(!cleared.configured);
    assert_eq!(cleared.revision, saved.revision + 1);
}
