use crate::miner_process::{MinerProcessSnapshot, MinerProcessStatus};
use crate::miner_runtime_executor::MinerRuntimeExecutor;
use crate::mining_configuration_tauri::MiningConfigurationState;
use crate::mining_runtime_controller::{MiningRuntimeController, RuntimeDecision, RuntimeOrder};
use crate::rental_mining_coordinator::{CoordinatorSnapshot, MiningConsent};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Debug)]
pub struct MiningRuntimeState {
    controller: Mutex<MiningRuntimeController>,
    executor: Option<Mutex<MinerRuntimeExecutor>>,
    initialization_error: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningRuntimeExecution {
    pub decision: RuntimeDecision,
    pub process: MinerProcessSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningRuntimeSnapshot {
    pub runtime: CoordinatorSnapshot,
    pub process: MinerProcessSnapshot,
}

impl Default for MiningRuntimeState {
    fn default() -> Self {
        match MinerRuntimeExecutor::from_environment() {
            Ok(executor) => Self {
                controller: Mutex::new(MiningRuntimeController::default()),
                executor: Some(Mutex::new(executor)),
                initialization_error: None,
            },
            Err(error) => Self {
                controller: Mutex::new(MiningRuntimeController::default()),
                executor: None,
                initialization_error: Some(error),
            },
        }
    }
}

impl MiningRuntimeState {
    pub fn from_executor(executor: MinerRuntimeExecutor) -> Self {
        Self {
            controller: Mutex::new(MiningRuntimeController::default()),
            executor: Some(Mutex::new(executor)),
            initialization_error: None,
        }
    }

    fn executor(&self) -> Result<&Mutex<MinerRuntimeExecutor>, &'static str> {
        self.initialization_error.map_or(Ok(()), Err)?;
        self.executor.as_ref().ok_or("miner_runtime_unavailable")
    }

    pub fn snapshot(&self) -> Result<CoordinatorSnapshot, &'static str> {
        self.controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")
            .map(|controller| controller.snapshot())
    }

    pub fn process_snapshot(&self) -> Result<MinerProcessSnapshot, &'static str> {
        self.executor()?
            .lock()
            .map_err(|_| "miner_process_state_unavailable")?
            .snapshot()
    }

    pub fn runtime_snapshot(&self) -> Result<MiningRuntimeSnapshot, &'static str> {
        let process = self.process_snapshot()?;
        let mut controller = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?;
        if controller.snapshot().state
            == crate::rental_mining_coordinator::CoordinatedGpuState::Mining
            && process.status != MinerProcessStatus::Running
        {
            controller.unexpected_miner_exit()?;
        }
        Ok(MiningRuntimeSnapshot {
            runtime: controller.snapshot(),
            process,
        })
    }

    pub fn set_owner_consent(
        &self,
        consent: MiningConsent,
        configuration: &MiningConfigurationState,
    ) -> Result<MiningRuntimeExecution, &'static str> {
        let decision = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .set_owner_consent(consent)?;
        let execution = self.execute_decision(decision, configuration)?;
        if consent == MiningConsent::Disabled
            && execution.decision.order == RuntimeOrder::StopMinerForRental
        {
            let process_exited = execution.process.status != MinerProcessStatus::Running
                && execution.process.pid.is_none();
            self.controller
                .lock()
                .map_err(|_| "mining_runtime_state_unavailable")?
                .owner_mining_stopped(process_exited)?;
        }
        Ok(execution)
    }

    pub fn execute_decision(
        &self,
        decision: RuntimeDecision,
        configuration: &MiningConfigurationState,
    ) -> Result<MiningRuntimeExecution, &'static str> {
        let launch_spec = match decision.order {
            RuntimeOrder::StartApprovedMiner => match configuration.require_ready_launch_spec() {
                Ok(spec) => Some(spec),
                Err(error) => {
                    if let Ok(mut controller) = self.controller.lock() {
                        let _ = controller.emergency_stop(false);
                    }
                    return Err(error);
                }
            },
            _ => None,
        };
        let process_result = self.executor()?.lock().map_or_else(
            |_| Err("miner_process_state_unavailable"),
            |mut executor| executor.execute(&decision.order, launch_spec.as_ref()),
        );
        let process = match process_result {
            Ok(process) => process,
            Err(error) => {
                if let Ok(mut controller) = self.controller.lock() {
                    let _ = controller.emergency_stop(false);
                }
                return Err(error);
            }
        };
        Ok(MiningRuntimeExecution { decision, process })
    }

    pub fn start_idle_mining(
        &self,
        configuration: &MiningConfigurationState,
    ) -> Result<MiningRuntimeExecution, &'static str> {
        let decision = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .request_idle_mining_start()?;
        let execution = self.execute_decision(decision, configuration)?;
        let confirmation = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .mining_started();
        if let Err(error) = confirmation {
            if let Ok(executor) = self.executor() {
                if let Ok(mut executor) = executor.lock() {
                    let _ = executor.execute(&RuntimeOrder::StopMinerForRental, None);
                }
            }
            if let Ok(mut controller) = self.controller.lock() {
                let _ = controller.emergency_stop(false);
            }
            return Err(error);
        }
        Ok(execution)
    }

    pub fn emergency_stop(&self) -> Result<MiningRuntimeExecution, &'static str> {
        let process_result = self.executor()?.lock().map_or_else(
            |_| Err("miner_process_state_unavailable"),
            |mut executor| executor.execute(&RuntimeOrder::StopMinerForRental, None),
        );
        let process = match process_result {
            Ok(process) => process,
            Err(error) => {
                if let Ok(mut controller) = self.controller.lock() {
                    let _ = controller.emergency_stop(false);
                }
                return Err(error);
            }
        };
        let decision = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .emergency_stop(true)?;
        Ok(MiningRuntimeExecution { decision, process })
    }

    pub fn thermal_safety_stop(&self) -> Result<MiningRuntimeExecution, &'static str> {
        let decision = self
            .controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .set_owner_consent(MiningConsent::Disabled)?;
        let execution = self.execute_decision(decision, &MiningConfigurationState::in_memory())?;
        let process_exited = execution.process.status != MinerProcessStatus::Running
            && execution.process.pid.is_none();
        self.controller
            .lock()
            .map_err(|_| "mining_runtime_state_unavailable")?
            .owner_mining_stopped(process_exited)?;
        Ok(execution)
    }
}
