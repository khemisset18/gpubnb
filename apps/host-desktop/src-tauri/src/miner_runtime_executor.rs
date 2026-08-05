use crate::miner_process::{MinerProcessManager, MinerProcessSnapshot, MinerProcessStatus};
use crate::mining_configuration::MiningLaunchSpec;
use crate::mining_runtime_controller::RuntimeOrder;

#[derive(Debug)]
pub struct MinerRuntimeExecutor {
    process: MinerProcessManager,
}

impl MinerRuntimeExecutor {
    pub fn from_environment() -> Result<Self, &'static str> {
        Ok(Self {
            process: MinerProcessManager::from_environment()?,
        })
    }

    pub fn from_process_manager(process: MinerProcessManager) -> Self {
        Self { process }
    }

    pub fn execute(
        &mut self,
        order: &RuntimeOrder,
        launch_spec: Option<&MiningLaunchSpec>,
    ) -> Result<MinerProcessSnapshot, &'static str> {
        match order {
            RuntimeOrder::StartApprovedMiner => {
                let spec = launch_spec.ok_or("mining_launch_spec_required")?;
                let snapshot = self.process.start(spec)?;
                if snapshot.status != MinerProcessStatus::Running || snapshot.pid.is_none() {
                    let _ = self.process.stop();
                    return Err("miner_process_start_unconfirmed");
                }
                Ok(snapshot)
            }
            RuntimeOrder::StopMinerForRental => {
                let snapshot = self.process.stop()?;
                if snapshot.status == MinerProcessStatus::Running || snapshot.pid.is_some() {
                    return Err("miner_process_stop_unconfirmed");
                }
                Ok(snapshot)
            }
            RuntimeOrder::Noop
            | RuntimeOrder::PrepareRentalWorkspace
            | RuntimeOrder::StartRentalWorkspace
            | RuntimeOrder::DestroyRentalWorkspace => self.process.refresh(),
        }
    }

    pub fn snapshot(&mut self) -> Result<MinerProcessSnapshot, &'static str> {
        self.process.refresh()
    }
}
