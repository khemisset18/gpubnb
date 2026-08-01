use crate::mining_configuration::{MiningConfiguration, MiningConfigurationActor};
use crate::mining_configuration_service::MiningConfigurationService;
use crate::mining_configuration_store::MiningConfigurationView;
use crate::mining_pool_probe::probe_pool_connection;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct MiningConfigurationCommands {
    service: MiningConfigurationService,
}

impl MiningConfigurationCommands {
    pub fn get(&self) -> Result<MiningConfigurationView, &'static str> {
        self.service.view(unix_seconds()?)
    }

    pub fn save(
        &mut self,
        expected_revision: u64,
        configuration: MiningConfiguration,
    ) -> Result<MiningConfigurationView, &'static str> {
        self.service.save(
            MiningConfigurationActor::HostOwner,
            expected_revision,
            configuration,
        )
    }

    pub fn test_connection(
        &mut self,
        expected_revision: u64,
        pool_url: &str,
    ) -> Result<MiningConfigurationView, &'static str> {
        let now = unix_seconds()?;
        let evidence = probe_pool_connection(pool_url, now)?;
        self.service.record_connection_evidence(
            MiningConfigurationActor::HostOwner,
            expected_revision,
            evidence,
        )
    }

    pub fn clear(
        &mut self,
        expected_revision: u64,
    ) -> Result<MiningConfigurationView, &'static str> {
        self.service.clear(
            MiningConfigurationActor::HostOwner,
            expected_revision,
            unix_seconds()?,
        )
    }

    pub fn require_ready(&self) -> Result<&MiningConfiguration, &'static str> {
        self.service.require_ready_configuration(unix_seconds()?)
    }
}

fn unix_seconds() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system_clock_invalid")
}
