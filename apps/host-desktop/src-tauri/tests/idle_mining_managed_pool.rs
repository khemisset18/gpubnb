#[path = "../src/mining_catalog.rs"]
mod mining_catalog;
#[path = "../src/mining_fee_policy.rs"]
mod mining_fee_policy;
#[path = "../src/mining_supervisor.rs"]
mod mining_supervisor;

use mining_catalog::{approved_for_vendor, GpuVendor};
use mining_fee_policy::{apply_pool_fee, PoolBillingMode};
use mining_supervisor::{ApprovedMiningConfig, MiningSupervisor};

fn approved_config() -> ApprovedMiningConfig {
    ApprovedMiningConfig {
        asset_id: "ravencoin".into(),
        miner_id: "gpubnb-approved-miner".into(),
        miner_version: "0.1.0".into(),
        wallet_address: "RExamplePublicAddressOnly123".into(),
        worker_name: "host-gpu-0".into(),
        gpu_id: "gpu-0".into(),
        maximum_temperature_c: 80,
        maximum_power_watts: 350,
    }
}

#[test]
fn managed_pool_keeps_exact_one_percent_and_owner_receives_rest() {
    let settlement = apply_pool_fee(1_000_000, PoolBillingMode::GpuBnbManaged);
    assert_eq!(settlement.platform_amount, 10_000);
    assert_eq!(settlement.owner_amount, 990_000);
    assert_eq!(settlement.owner_amount + settlement.platform_amount, 1_000_000);
}

#[test]
fn custom_pool_has_zero_gpubnb_fee() {
    let settlement = apply_pool_fee(1_000_000, PoolBillingMode::OwnerCustom);
    assert_eq!(settlement.platform_amount, 0);
    assert_eq!(settlement.owner_amount, 1_000_000);
}

#[test]
fn rental_always_preempts_mining_and_failed_stop_quarantines_gpu() {
    let mut supervisor = MiningSupervisor::default();
    supervisor
        .record_verified_start(&approved_config(), true, false, true, true, true)
        .unwrap();
    assert_eq!(supervisor.stop_for_rental(false), Err("miner_process_still_running"));
    assert!(!supervisor.is_gpu_released());
}

#[test]
fn catalog_rejects_wrong_vendor_or_disabled_profile() {
    assert!(approved_for_vendor("trex_rvn_kawpow", GpuVendor::Nvidia));
    assert!(!approved_for_vendor("trex_rvn_kawpow", GpuVendor::Amd));
    assert!(!approved_for_vendor("lolminer_beam_beamhashiii", GpuVendor::Nvidia));
}
