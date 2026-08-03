#![allow(dead_code)]

#[path = "../src/approved_miner_manifest.rs"]
mod approved_miner_manifest;
#[path = "../src/miner_paths.rs"]
mod miner_paths;
#[path = "../src/miner_process.rs"]
mod miner_process;
#[path = "../src/miner_runtime_executor.rs"]
mod miner_runtime_executor;
#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_runtime_controller.rs"]
mod mining_runtime_controller;
#[path = "../src/rental_mining_coordinator.rs"]
mod rental_mining_coordinator;
#[path = "../src/mining_catalog/secure_launcher.rs"]
mod secure_launcher;

use miner_process::{MinerProcessManager, MinerProcessStatus};
use miner_runtime_executor::MinerRuntimeExecutor;
use mining_runtime_controller::RuntimeOrder;

#[test]
fn start_requires_a_verified_launch_spec() {
    let root = std::env::temp_dir();
    let manager = MinerProcessManager::from_approved_root(root)
        .expect("temporary directory must be a valid approved root");
    let mut executor = MinerRuntimeExecutor::from_process_manager(manager);

    assert_eq!(
        executor.execute(&RuntimeOrder::StartApprovedMiner, None),
        Err("mining_launch_spec_required")
    );
}

#[test]
fn stopping_an_idle_manager_is_confirmed() {
    let root = std::env::temp_dir();
    let manager = MinerProcessManager::from_approved_root(root)
        .expect("temporary directory must be a valid approved root");
    let mut executor = MinerRuntimeExecutor::from_process_manager(manager);

    let snapshot = executor
        .execute(&RuntimeOrder::StopMinerForRental, None)
        .expect("stopping an idle process manager must be safe");
    assert_ne!(snapshot.status, MinerProcessStatus::Running);
    assert!(snapshot.pid.is_none());
}
