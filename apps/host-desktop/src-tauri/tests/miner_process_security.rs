#![allow(dead_code)]

#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/miner_process.rs"]
mod miner_process;

use miner_process::MinerProcessManager;

#[test]
fn arbitrary_or_missing_miner_root_is_rejected() {
    let missing = std::env::temp_dir().join(format!(
        "gpubnb-missing-miner-root-{}",
        std::process::id()
    ));
    assert_eq!(
        MinerProcessManager::from_approved_root(missing),
        Err("approved_miner_directory_unavailable")
    );
}
