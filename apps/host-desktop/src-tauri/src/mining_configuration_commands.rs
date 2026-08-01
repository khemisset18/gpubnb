#[path = "mining_configuration_persistence.rs"]
pub(crate) mod mining_configuration_persistence;

use crate::mining_configuration::{MiningConfiguration, MiningConfigurationActor};
use crate::mining_configuration_service::MiningConfigurationService;
use crate::mining_configuration_store::MiningConfigurationView;
use crate::mining_pool_probe::probe_pool_connection;
use mining_configuration_persistence::MiningConfigurationPersistence;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct MiningConfigurationCommands {
    service: MiningConfigurationService,
    persistence: Option<MiningConfigurationPersistence>,
}

impl Default for MiningConfigurationCommands {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl MiningConfigurationCommands {
    pub fn in_memory() -> Self {
        Self {
            service: MiningConfigurationService::default(),
            persistence: None,
        }
    }

    pub fn persistent_default() -> Result<Self, &'static str> {
        let persistence = MiningConfigurationPersistence::from_default_location()?;
        let restored = persistence.load_or_quarantine();
        let service = MiningConfigurationService::from_persistent(restored)?;
        Ok(Self {
            service,
            persistence: Some(persistence),
        })
    }

    pub fn get(&self) -> Result<MiningConfigurationView, &'static str> {
        self.service.view(unix_seconds()?)
    }

    pub fn save(
        &mut self,
        expected_revision: u64,
        configuration: MiningConfiguration,
    ) -> Result<MiningConfigurationView, &'static str> {
        let previous = self.service.clone();
        let view = self.service.save(
            MiningConfigurationActor::HostOwner,
            expected_revision,
            configuration,
        )?;
        self.persist_or_restore(previous)?;
        Ok(view)
    }

    pub fn test_connection(
        &mut self,
        expected_revision: u64,
        pool_url: &str,
    ) -> Result<MiningConfigurationView, &'static str> {
        let now = unix_seconds()?;
        let evidence = probe_pool_connection(pool_url, now)?;
        let previous = self.service.clone();
        let view = self.service.record_connection_evidence(
            MiningConfigurationActor::HostOwner,
            expected_revision,
            evidence,
        )?;
        self.persist_or_restore(previous)?;
        Ok(view)
    }

    pub fn clear(
        &mut self,
        expected_revision: u64,
    ) -> Result<MiningConfigurationView, &'static str> {
        let previous = self.service.clone();
        let view = self.service.clear(
            MiningConfigurationActor::HostOwner,
            expected_revision,
            unix_seconds()?,
        )?;
        self.persist_or_restore(previous)?;
        Ok(view)
    }

    pub fn require_ready(&self) -> Result<&MiningConfiguration, &'static str> {
        self.service.require_ready_configuration(unix_seconds()?)
    }

    fn persist_or_restore(
        &mut self,
        previous: MiningConfigurationService,
    ) -> Result<(), &'static str> {
        let Some(persistence) = self.persistence.as_ref() else {
            return Ok(());
        };
        if let Err(error) = persistence.save(&self.service.persistent_snapshot()) {
            self.service = previous;
            return Err(error);
        }
        Ok(())
    }
}

fn unix_seconds() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system_clock_invalid")
}
