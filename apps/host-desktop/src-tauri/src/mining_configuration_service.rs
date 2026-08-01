use crate::mining_configuration::{
    authorize_configuration_change, MiningConfiguration, MiningConfigurationActor,
    PoolConnectionEvidence,
};
use crate::mining_configuration_store::{
    MiningConfigurationStore, MiningConfigurationView, DEFAULT_CONNECTION_EVIDENCE_MAX_AGE_SECONDS,
};

#[derive(Clone, Debug, Default)]
pub struct MiningConfigurationService {
    store: MiningConfigurationStore,
}

impl MiningConfigurationService {
    pub fn view(&self, now_unix_seconds: u64) -> Result<MiningConfigurationView, &'static str> {
        self.store.view(
            now_unix_seconds,
            DEFAULT_CONNECTION_EVIDENCE_MAX_AGE_SECONDS,
        )
    }

    pub fn save(
        &mut self,
        actor: MiningConfigurationActor,
        expected_revision: u64,
        configuration: MiningConfiguration,
    ) -> Result<MiningConfigurationView, &'static str> {
        authorize_configuration_change(actor)?;
        self.require_revision(expected_revision)?;
        self.store.save(configuration)?;
        self.view(0)
    }

    pub fn record_connection_evidence(
        &mut self,
        actor: MiningConfigurationActor,
        expected_revision: u64,
        evidence: PoolConnectionEvidence,
    ) -> Result<MiningConfigurationView, &'static str> {
        authorize_configuration_change(actor)?;
        self.require_revision(expected_revision)?;
        let verified_at = evidence.verified_at_unix_seconds;
        self.store.record_connection_evidence(evidence)?;
        self.view(verified_at)
    }

    pub fn clear(
        &mut self,
        actor: MiningConfigurationActor,
        expected_revision: u64,
        now_unix_seconds: u64,
    ) -> Result<MiningConfigurationView, &'static str> {
        authorize_configuration_change(actor)?;
        self.require_revision(expected_revision)?;
        self.store.clear();
        self.view(now_unix_seconds)
    }

    pub fn require_ready_configuration(
        &self,
        now_unix_seconds: u64,
    ) -> Result<&MiningConfiguration, &'static str> {
        self.store.verified_configuration(
            now_unix_seconds,
            DEFAULT_CONNECTION_EVIDENCE_MAX_AGE_SECONDS,
        )
    }

    fn require_revision(&self, expected_revision: u64) -> Result<(), &'static str> {
        if self.store.revision() != expected_revision {
            return Err("mining_configuration_revision_conflict");
        }
        Ok(())
    }
}
