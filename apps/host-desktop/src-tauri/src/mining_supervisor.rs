use serde::Serialize;

const MAX_WORKER_NAME_LEN: usize = 64;
const MAX_WALLET_ADDRESS_LEN: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MinerRuntimeState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Faulted,
    Quarantined,
}

impl Default for MinerRuntimeState {
    fn default() -> Self {
        Self::Stopped
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedMiningConfig {
    pub asset_id: String,
    pub miner_id: String,
    pub miner_version: String,
    pub wallet_address: String,
    pub worker_name: String,
    pub gpu_id: String,
    pub maximum_temperature_c: u16,
    pub maximum_power_watts: u16,
}

impl ApprovedMiningConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identifier(&self.asset_id)?;
        validate_identifier(&self.miner_id)?;
        validate_version(&self.miner_version)?;
        validate_identifier(&self.gpu_id)?;

        if self.wallet_address.is_empty()
            || self.wallet_address.len() > MAX_WALLET_ADDRESS_LEN
            || !self.wallet_address.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err("invalid_wallet_address");
        }

        if self.worker_name.is_empty()
            || self.worker_name.len() > MAX_WORKER_NAME_LEN
            || !self
                .worker_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("invalid_worker_name");
        }

        if !(50..=95).contains(&self.maximum_temperature_c) {
            return Err("invalid_temperature_limit");
        }

        if !(25..=1_500).contains(&self.maximum_power_watts) {
            return Err("invalid_power_limit");
        }

        Ok(())
    }
}

fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("invalid_approved_identifier");
    }
    Ok(())
}

fn validate_version(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err("invalid_miner_version");
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningSupervisor {
    pub state: MinerRuntimeState,
    pub active_gpu_id: Option<String>,
    pub restart_attempts: u8,
    pub last_error: Option<&'static str>,
}

impl MiningSupervisor {
    /// Phase 1 deliberately simulates process control. No binary, URL, shell,
    /// command line or user-provided argument is executed here.
    pub fn start_simulated(
        &mut self,
        config: &ApprovedMiningConfig,
        gpu_is_idle: bool,
        reservation_pending: bool,
        locally_allowed: bool,
    ) -> Result<(), &'static str> {
        config.validate()?;

        if !locally_allowed {
            return Err("mining_not_locally_authorized");
        }
        if reservation_pending || !gpu_is_idle {
            return Err("gpu_not_available_for_mining");
        }
        if self.state == MinerRuntimeState::Quarantined {
            return Err("miner_quarantined");
        }
        if self.state != MinerRuntimeState::Stopped {
            return Err("miner_already_active");
        }

        self.state = MinerRuntimeState::Starting;
        self.active_gpu_id = Some(config.gpu_id.clone());
        self.state = MinerRuntimeState::Running;
        self.last_error = None;
        Ok(())
    }

    pub fn stop_for_rental(&mut self, process_exited: bool) -> Result<(), &'static str> {
        match self.state {
            MinerRuntimeState::Stopped => Ok(()),
            MinerRuntimeState::Running | MinerRuntimeState::Starting => {
                self.state = MinerRuntimeState::Stopping;
                if process_exited {
                    self.finish_stop();
                    Ok(())
                } else {
                    self.state = MinerRuntimeState::Quarantined;
                    self.last_error = Some("miner_process_still_running");
                    Err("miner_process_still_running")
                }
            }
            MinerRuntimeState::Stopping => Err("miner_stop_already_in_progress"),
            MinerRuntimeState::Faulted => {
                self.state = MinerRuntimeState::Quarantined;
                Err("faulted_miner_requires_cleanup")
            }
            MinerRuntimeState::Quarantined => Err("miner_quarantined"),
        }
    }

    pub fn emergency_stop(&mut self, process_exited: bool) -> Result<(), &'static str> {
        if process_exited {
            self.finish_stop();
            return Ok(());
        }

        self.state = MinerRuntimeState::Quarantined;
        self.last_error = Some("emergency_stop_failed");
        Err("emergency_stop_failed")
    }

    pub fn record_fault(&mut self, error: &'static str) {
        self.state = MinerRuntimeState::Faulted;
        self.last_error = Some(error);
    }

    pub fn clear_quarantine_after_local_review(&mut self) {
        self.finish_stop();
        self.restart_attempts = 0;
    }

    pub fn is_gpu_released(&self) -> bool {
        self.state == MinerRuntimeState::Stopped && self.active_gpu_id.is_none()
    }

    fn finish_stop(&mut self) {
        self.state = MinerRuntimeState::Stopped;
        self.active_gpu_id = None;
        self.last_error = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ApprovedMiningConfig {
        ApprovedMiningConfig {
            asset_id: "simulated-ravencoin".into(),
            miner_id: "gpubnb-fake-miner".into(),
            miner_version: "0.1.0".into(),
            wallet_address: "RExamplePublicAddressOnly123".into(),
            worker_name: "host-gpu-0".into(),
            gpu_id: "gpu-0".into(),
            maximum_temperature_c: 80,
            maximum_power_watts: 350,
        }
    }

    #[test]
    fn mining_is_rejected_when_a_rental_is_pending() {
        let mut supervisor = MiningSupervisor::default();
        assert_eq!(
            supervisor.start_simulated(&config(), true, true, true),
            Err("gpu_not_available_for_mining")
        );
        assert!(supervisor.is_gpu_released());
    }

    #[test]
    fn local_consent_is_required() {
        let mut supervisor = MiningSupervisor::default();
        assert_eq!(
            supervisor.start_simulated(&config(), true, false, false),
            Err("mining_not_locally_authorized")
        );
    }

    #[test]
    fn clean_stop_releases_the_gpu_for_rental() {
        let mut supervisor = MiningSupervisor::default();
        supervisor
            .start_simulated(&config(), true, false, true)
            .expect("simulation should start");
        supervisor
            .stop_for_rental(true)
            .expect("simulation should stop");
        assert!(supervisor.is_gpu_released());
    }

    #[test]
    fn failed_stop_quarantines_the_gpu() {
        let mut supervisor = MiningSupervisor::default();
        supervisor
            .start_simulated(&config(), true, false, true)
            .expect("simulation should start");
        assert_eq!(
            supervisor.stop_for_rental(false),
            Err("miner_process_still_running")
        );
        assert_eq!(supervisor.state, MinerRuntimeState::Quarantined);
        assert!(!supervisor.is_gpu_released());
    }

    #[test]
    fn arbitrary_worker_arguments_are_not_accepted() {
        let mut unsafe_config = config();
        unsafe_config.worker_name = "worker; rm -rf /".into();
        assert_eq!(unsafe_config.validate(), Err("invalid_worker_name"));
    }
}