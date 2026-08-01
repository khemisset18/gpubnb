use crate::mining_configuration::{
    MiningConfiguration, MiningConfigurationStatus, PoolConnectionEvidence,
};
use serde::Serialize;

pub const DEFAULT_CONNECTION_EVIDENCE_MAX_AGE_SECONDS: u64 = 300;

#[derive(Clone, Debug, Default)]
pub struct MiningConfigurationStore {
    configuration: Option<MiningConfiguration>,
    connection_evidence: Option<PoolConnectionEvidence>,
    revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningConfigurationView {
    pub configured: bool,
    pub configuration: Option<MiningConfiguration>,
    pub status: Option<MiningConfigurationStatus>,
    pub revision: u64,
    pub connection_verified_at_unix_seconds: Option<u64>,
}

impl MiningConfigurationStore {
    pub fn view(
        &self,
        now_unix_seconds: u64,
        maximum_evidence_age_seconds: u64,
    ) -> Result<MiningConfigurationView, &'static str> {
        let Some(configuration) = self.configuration.as_ref() else {
            return Ok(MiningConfigurationView {
                configured: false,
                configuration: None,
                status: None,
                revision: self.revision,
                connection_verified_at_unix_seconds: None,
            });
        };

        let status = configuration.status(
            self.connection_evidence.as_ref(),
            now_unix_seconds,
            maximum_evidence_age_seconds,
        )?;
        Ok(MiningConfigurationView {
            configured: true,
            configuration: Some(configuration.clone()),
            status: Some(status),
            revision: self.revision,
            connection_verified_at_unix_seconds: self
                .connection_evidence
                .as_ref()
                .map(|evidence| evidence.verified_at_unix_seconds),
        })
    }

    pub fn save(&mut self, configuration: MiningConfiguration) -> Result<u64, &'static str> {
        configuration.validate()?;
        self.configuration = Some(configuration);
        self.connection_evidence = None;
        self.revision = self.revision.checked_add(1).ok_or("mining_revision_overflow")?;
        Ok(self.revision)
    }

    pub fn record_connection_evidence(
        &mut self,
        evidence: PoolConnectionEvidence,
    ) -> Result<u64, &'static str> {
        let configuration = self
            .configuration
            .as_ref()
            .ok_or("mining_configuration_missing")?;
        configuration.status(Some(&evidence), evidence.verified_at_unix_seconds, 0)?;
        self.connection_evidence = Some(evidence);
        Ok(self.revision)
    }

    pub fn verified_configuration(
        &self,
        now_unix_seconds: u64,
        maximum_evidence_age_seconds: u64,
    ) -> Result<&MiningConfiguration, &'static str> {
        let configuration = self
            .configuration
            .as_ref()
            .ok_or("mining_configuration_missing")?;
        let evidence = self
            .connection_evidence
            .as_ref()
            .ok_or("mining_pool_connection_test_required")?;
        match configuration.status(
            Some(evidence),
            now_unix_seconds,
            maximum_evidence_age_seconds,
        )? {
            MiningConfigurationStatus::Ready => Ok(configuration),
            MiningConfigurationStatus::Disabled => Err("mining_configuration_disabled"),
            MiningConfigurationStatus::NeedsConnectionTest => {
                Err("mining_pool_connection_test_required")
            }
        }
    }

    pub fn clear(&mut self) -> u64 {
        self.configuration = None;
        self.connection_evidence = None;
        self.revision = self.revision.saturating_add(1);
        self.revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mining_configuration::PoolMode;

    fn configuration(worker_name: &str) -> MiningConfiguration {
        MiningConfiguration {
            enabled: true,
            auto_mine_when_idle: true,
            cryptocurrency: "KAS".into(),
            miner_profile_id: "lolminer_kaspa".into(),
            pool_mode: PoolMode::Custom,
            custom_pool_url: Some("stratum+tls://pool.example.com:443".into()),
            wallet_address: "kaspa:qownerwallet".into(),
            worker_name: worker_name.into(),
            pool_credential_ref: Some("secret_pool_001".into()),
        }
    }

    fn evidence() -> PoolConnectionEvidence {
        PoolConnectionEvidence {
            pool_url: "stratum+tls://pool.example.com:443".into(),
            dns_resolved: true,
            tcp_connected: true,
            tls_verified: true,
            verified_at_unix_seconds: 1_000,
        }
    }

    #[test]
    fn configuration_change_invalidates_previous_connection_evidence() {
        let mut store = MiningConfigurationStore::default();
        store.save(configuration("worker_a")).unwrap();
        store.record_connection_evidence(evidence()).unwrap();
        assert!(store.verified_configuration(1_010, 60).is_ok());

        store.save(configuration("worker_b")).unwrap();
        assert_eq!(
            store.verified_configuration(1_010, 60),
            Err("mining_pool_connection_test_required")
        );
    }

    #[test]
    fn stale_connection_evidence_never_returns_ready_configuration() {
        let mut store = MiningConfigurationStore::default();
        store.save(configuration("worker_a")).unwrap();
        store.record_connection_evidence(evidence()).unwrap();
        assert_eq!(
            store.verified_configuration(2_000, 60),
            Err("mining_pool_connection_test_required")
        );
    }

    #[test]
    fn clear_removes_configuration_and_evidence() {
        let mut store = MiningConfigurationStore::default();
        store.save(configuration("worker_a")).unwrap();
        store.record_connection_evidence(evidence()).unwrap();
        let revision = store.clear();
        assert_eq!(revision, 2);
        assert!(!store.view(1_010, 60).unwrap().configured);
    }
}
