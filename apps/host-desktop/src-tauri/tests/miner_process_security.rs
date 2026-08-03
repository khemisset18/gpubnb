#![allow(dead_code)]

#[path = "../src/approved_miner_manifest.rs"]
mod approved_miner_manifest;
#[path = "../src/miner_paths.rs"]
mod miner_paths;
#[path = "../src/miner_process.rs"]
mod miner_process;
#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_catalog/secure_launcher.rs"]
mod secure_launcher;

use miner_process::MinerProcessManager;

#[test]
fn arbitrary_or_missing_miner_root_is_rejected() {
    let missing =
        std::env::temp_dir().join(format!("gpubnb-missing-miner-root-{}", std::process::id()));
    assert!(matches!(
        MinerProcessManager::from_approved_root(missing),
        Err("approved_miner_directory_unavailable")
    ));
}
