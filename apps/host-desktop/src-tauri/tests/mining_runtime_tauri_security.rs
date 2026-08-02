#![allow(dead_code)]

#[path = "../src/miner_process.rs"]
mod miner_process;
#[path = "../src/miner_runtime_executor.rs"]
mod miner_runtime_executor;
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
#[path = "../src/mining_runtime_controller.rs"]
mod mining_runtime_controller;
#[path = "../src/mining_runtime_tauri.rs"]
mod mining_runtime_tauri;
#[path = "../src/rental_mining_coordinator.rs"]
mod rental_mining_coordinator;

use miner_process::{MinerProcessManager, MinerProcessStatus};
use miner_runtime_executor::MinerRuntimeExecutor;
use mining_runtime_tauri::MiningRuntimeState;

#[test]
fn transactional_runtime_state_is_readable_with_controlled_executor() {
    let manager = MinerProcessManager::from_approved_root(std::env::temp_dir())
        .expect("temporary directory must be a valid approved root");
    let state =
        MiningRuntimeState::from_executor(MinerRuntimeExecutor::from_process_manager(manager));

    let runtime = state
        .snapshot()
        .expect("runtime snapshot must be available");
    let process = state
        .process_snapshot()
        .expect("process snapshot must be available");

    assert_eq!(
        runtime.consent,
        rental_mining_coordinator::MiningConsent::Disabled
    );
    assert_ne!(process.status, MinerProcessStatus::Running);
    assert!(process.pid.is_none());
}

#[test]
fn emergency_stop_confirms_no_process_is_running() {
    let manager = MinerProcessManager::from_approved_root(std::env::temp_dir())
        .expect("temporary directory must be a valid approved root");
    let state =
        MiningRuntimeState::from_executor(MinerRuntimeExecutor::from_process_manager(manager));

    let process = state
        .emergency_stop()
        .expect("stopping an idle runtime must be safe");

    assert_ne!(process.status, MinerProcessStatus::Running);
    assert!(process.pid.is_none());
}
