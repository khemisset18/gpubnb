use crate::miner_process::MinerProcessSnapshot;
use crate::miner_runtime_executor::MinerRuntimeExecutor;
use crate::mining_configuration_tauri::MiningConfigurationState;
use crate::mining_runtime_controller::{MiningRuntimeController, RuntimeDecision, RuntimeOrder};
use crate::rental_mining_coordinator::{CoordinatorSnapshot, MiningConsent};
use std::sync::Mutex;

#[derive(Debug)]
pub struct MiningRuntimeState {
    controller: Mutex<MiningRuntimeController>,
    executor: Mutex<MinerRuntimeExecutor>,
    initialization_error: Option<&'static str>,
}

#[derive(Debug)]
pub struct MiningRuntimeExecution {
    pub decision: RuntimeDecision,
    pub process: MinerProcessSnapshot,
}

impl Default for MiningRuntimeState {
    fn default() -> Self {
        match MinerRuntimeExecutor::from_environment() {
            Ok(executor) => Self {
                controller: Mutex::new(MiningRuntimeController::default()),
                executor: Mutex::new(executor),
                initialization_error: None,
            },
            Err(error) => Self {
                controller: Mutex::new(MiningRuntimeController::default()),
                executor: Mutex::new(
                    MinerRuntimeExecutor::from_environment()
                        .unwrap_or_else(|_| panic!("miner runtime unavailable: {error}")),
                ),
                initialization_error: Some(error),
            },
        }
    }
}

impl MiningRuntimeState {
    pub fn from_executor(executor: MinerRuntimeExecutor) -> Self {
        Self {
            controller: Mutex::new(MiningRuntimeController::default()),
            executor: Mutex::new(executor),
            initialization_error: None,
        }
    }

    fn ensure_initialized(&self) -> Result<(), &'static str> {
        self.initialization_error.map_or(Ok(()), Err)
    }

    pub fn snapshot(&self) -> Result<CoordinatorSnapshot, &'static str> {
        self.ensure_initialized()?;
        self.controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")
            .map(|controller| controller.snapshot())
    }

    pub fn process_snapshot(&self) -> Result<MinerProcessSnapshot, &'static str> {
        self.ensure_initialized()?;
        self.executor
            .lock()
            .map_err(|_| "miner_process_state_unavailable")?
            .snapshot()
    }

    pub fn set_owner_consent(
        &self,
        consent: MiningConsent,
        configuration: &MiningConfigurationState,
    ) -> Result<MiningRuntimeExecution, &'static str> {
        self.ensure_initialized()?;
        let decision = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .set_owner_consent(consent)?;
        self.execute_decision(decision, configuration)
    }

    pub fn execute_decision(
        &self,
        decision: RuntimeDecision,
        configuration: &MiningConfigurationState,
    ) -> Result<MiningRuntimeExecution, &'static str> {
        self.ensure_initialized()?;
        let launch_spec = match decision.order {
            RuntimeOrder::StartApprovedMiner => Some(configuration.require_ready_launch_spec()?),
            _ => None,
        };
        let process = self
            .executor
            .lock()
            .map_err(|_| "miner_process_state_unavailable")?
            .execute(&decision.order, launch_spec.as_ref())?;
        Ok(MiningRuntimeExecution { decision, process })
    }

    pub fn emergency_stop(&self) -> Result<MinerProcessSnapshot, &'static str> {
        self.ensure_initialized()?;
        self.executor
            .lock()
            .map_err(|_| "miner_process_state_unavailable")?
            .execute(&RuntimeOrder::StopMinerForRental, None)
    }
}
