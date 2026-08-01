#[path = "../src/mining_configuration.rs"]
mod mining_configuration;

use mining_configuration::{
    authorize_configuration_change, MiningConfiguration, MiningConfigurationActor, PoolMode,
};

fn configuration(pool_mode: PoolMode) -> MiningConfiguration {
    MiningConfiguration {
        enabled: true,
        auto_mine_when_idle: true,
        cryptocurrency: "KAS".into(),
        miner_profile_id: "lolminer_kaspa".into(),
        pool_mode,
        custom_pool_url: (pool_mode == PoolMode::Custom)
            .then(|| "stratum+tls://pool.example.com:443".into()),
        wallet_address: "kaspa:qownerwallet".into(),
        worker_name: "gpu_host_001".into(),
        pool_credential_ref: Some("secret_pool_001".into()),
    }
}

#[test]
fn owner_pool_builds_structured_spec_and_managed_pool_stays_disabled() {
    let custom = configuration(PoolMode::Custom)
        .build_launch_spec(None)
        .unwrap()
        .unwrap();
    assert_eq!(custom.pool_url, "stratum+tls://pool.example.com:443");
    assert_eq!(custom.wallet_address, "kaspa:qownerwallet");
    assert_eq!(custom.worker_name, "gpu_host_001");
    assert_eq!(
        custom.pool_credential_ref.as_deref(),
        Some("secret_pool_001")
    );

    assert_eq!(
        configuration(PoolMode::Managed)
            .build_launch_spec(Some("stratum+tls://managed.example.com:443")),
        Err("managed_pool_disabled")
    );
}

#[test]
fn only_owner_can_change_mining_preferences() {
    assert!(authorize_configuration_change(MiningConfigurationActor::HostOwner).is_ok());
    for actor in [
        MiningConfigurationActor::HostService,
        MiningConfigurationActor::ControlPlane,
        MiningConfigurationActor::Renter,
    ] {
        assert_eq!(
            authorize_configuration_change(actor),
            Err("mining_configuration_change_forbidden")
        );
    }
}

#[test]
fn malicious_wallet_and_pool_inputs_are_rejected() {
    let mut malicious_wallet = configuration(PoolMode::Custom);
    malicious_wallet.wallet_address = "wallet; rm -rf /".into();
    assert_eq!(malicious_wallet.validate(), Err("mining_invalid_wallet"));

    let mut malicious_pool = configuration(PoolMode::Custom);
    malicious_pool.custom_pool_url = Some("https://example.com/miner".into());
    assert_eq!(
        malicious_pool.validate(),
        Err("mining_pool_scheme_not_allowed")
    );
}

#[test]
fn disabling_mining_never_leaves_auto_start_enabled() {
    let mut disabled = configuration(PoolMode::Custom);
    disabled.enabled = false;
    assert_eq!(
        disabled.validate(),
        Err("mining_disabled_cannot_auto_start")
    );
    disabled.auto_mine_when_idle = false;
    assert!(disabled.validate().is_ok());
    assert!(disabled.build_launch_spec(None).unwrap().is_none());
}
