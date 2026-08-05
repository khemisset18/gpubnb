use serde::{Deserialize, Serialize};

const MAX_IDENTIFIER_LEN: usize = 96;
const MAX_WALLET_LEN: usize = 192;
const MAX_POOL_URL_LEN: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolMode {
    Managed,
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiningPerformanceMode {
    Eco,
    #[default]
    Balanced,
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MiningConfigurationActor {
    HostOwner,
    HostService,
    ControlPlane,
    Renter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MiningConfiguration {
    pub enabled: bool,
    pub auto_mine_when_idle: bool,
    #[serde(default)]
    pub performance_mode: MiningPerformanceMode,
    pub cryptocurrency: String,
    pub miner_profile_id: String,
    pub pool_mode: PoolMode,
    pub custom_pool_url: Option<String>,
    pub wallet_address: String,
    pub worker_name: String,
    pub pool_credential_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolConnectionEvidence {
    pub pool_url: String,
    pub dns_resolved: bool,
    pub tcp_connected: bool,
    pub tls_verified: bool,
    pub verified_at_unix_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MiningConfigurationStatus {
    Disabled,
    NeedsConnectionTest,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningLaunchSpec {
    pub cryptocurrency: String,
    pub miner_profile_id: String,
    pub performance_mode: MiningPerformanceMode,
    pub pool_url: String,
    pub wallet_address: String,
    pub worker_name: String,
    pub pool_credential_ref: Option<String>,
}

impl MiningConfiguration {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.enabled {
            if self.auto_mine_when_idle {
                return Err("mining_disabled_cannot_auto_start");
            }
            return Ok(());
        }

        validate_identifier(&self.cryptocurrency)?;
        validate_identifier(&self.miner_profile_id)?;
        validate_identifier(&self.worker_name)?;
        validate_wallet(&self.wallet_address)?;
        validate_optional_secret_ref(self.pool_credential_ref.as_deref())?;

        if !approved_profile(&self.cryptocurrency, &self.miner_profile_id) {
            return Err("mining_profile_not_approved");
        }

        match self.pool_mode {
            PoolMode::Managed => return Err("managed_pool_disabled"),
            PoolMode::Custom => {
                let pool_url = self
                    .custom_pool_url
                    .as_deref()
                    .ok_or("custom_pool_url_required")?;
                validate_pool_url(pool_url)?;
            }
        }
        Ok(())
    }

    pub fn status(
        &self,
        evidence: Option<&PoolConnectionEvidence>,
        now_unix_seconds: u64,
        maximum_evidence_age_seconds: u64,
    ) -> Result<MiningConfigurationStatus, &'static str> {
        self.validate()?;
        if !self.enabled {
            return Ok(MiningConfigurationStatus::Disabled);
        }

        let pool_url = self
            .custom_pool_url
            .as_deref()
            .ok_or("custom_pool_url_required")?;
        let Some(evidence) = evidence else {
            return Ok(MiningConfigurationStatus::NeedsConnectionTest);
        };
        if evidence.pool_url != pool_url {
            return Err("mining_pool_evidence_url_mismatch");
        }
        if !evidence.dns_resolved {
            return Err("mining_pool_dns_unverified");
        }
        if !evidence.tcp_connected {
            return Err("mining_pool_tcp_unverified");
        }
        if requires_tls(pool_url) && !evidence.tls_verified {
            return Err("mining_pool_tls_unverified");
        }
        let age = now_unix_seconds
            .checked_sub(evidence.verified_at_unix_seconds)
            .ok_or("mining_pool_evidence_from_future")?;
        if age > maximum_evidence_age_seconds {
            return Ok(MiningConfigurationStatus::NeedsConnectionTest);
        }

        Ok(MiningConfigurationStatus::Ready)
    }

    pub fn build_launch_spec(
        &self,
        _managed_pool_url: Option<&str>,
    ) -> Result<Option<MiningLaunchSpec>, &'static str> {
        self.validate()?;
        if !self.enabled || !self.auto_mine_when_idle {
            return Ok(None);
        }

        let pool_url = match self.pool_mode {
            PoolMode::Managed => return Err("managed_pool_disabled"),
            PoolMode::Custom => self
                .custom_pool_url
                .clone()
                .ok_or("custom_pool_url_required")?,
        };

        Ok(Some(MiningLaunchSpec {
            cryptocurrency: self.cryptocurrency.clone(),
            miner_profile_id: self.miner_profile_id.clone(),
            performance_mode: self.performance_mode,
            pool_url,
            wallet_address: self.wallet_address.clone(),
            worker_name: self.worker_name.clone(),
            pool_credential_ref: self.pool_credential_ref.clone(),
        }))
    }

    pub fn build_verified_launch_spec(
        &self,
        evidence: &PoolConnectionEvidence,
        now_unix_seconds: u64,
        maximum_evidence_age_seconds: u64,
    ) -> Result<Option<MiningLaunchSpec>, &'static str> {
        match self.status(
            Some(evidence),
            now_unix_seconds,
            maximum_evidence_age_seconds,
        )? {
            MiningConfigurationStatus::Disabled => Ok(None),
            MiningConfigurationStatus::NeedsConnectionTest => {
                Err("mining_pool_connection_test_required")
            }
            MiningConfigurationStatus::Ready => self.build_launch_spec(None),
        }
    }
}

pub fn authorize_configuration_change(actor: MiningConfigurationActor) -> Result<(), &'static str> {
    matches!(actor, MiningConfigurationActor::HostOwner)
        .then_some(())
        .ok_or("mining_configuration_change_forbidden")
}

fn approved_profile(cryptocurrency: &str, profile_id: &str) -> bool {
    matches!(
        (cryptocurrency, profile_id),
        ("ALPH", "lolminer_blake3")
            | ("CFX", "lolminer_octopus")
            | ("KAS", "lolminer_kaspa")
            | ("ETC", "lolminer_etchash")
            | ("RVN", "trex_kawpow")
            | ("ERG", "lolminer_autolykos")
            | ("XMR", "xmrig_randomx")
    )
}

fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("mining_invalid_identifier");
    }
    Ok(())
}

fn validate_wallet(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_WALLET_LEN
        || value.bytes().any(|byte| {
            byte.is_ascii_whitespace()
                || matches!(
                    byte,
                    b'"' | b'\'' | b'`' | b'\\' | b';' | b'|' | b'&' | b'<' | b'>'
                )
        })
    {
        return Err("mining_invalid_wallet");
    }
    Ok(())
}

fn validate_optional_secret_ref(value: Option<&str>) -> Result<(), &'static str> {
    if let Some(value) = value {
        validate_identifier(value)?;
        if !value.starts_with("secret_") {
            return Err("mining_credential_must_be_secret_reference");
        }
    }
    Ok(())
}

fn validate_pool_url(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > MAX_POOL_URL_LEN {
        return Err("mining_invalid_pool_url");
    }
    if value
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("mining_invalid_pool_url");
    }
    if value.contains('@') || value.contains('?') || value.contains('#') {
        return Err("mining_pool_url_contains_forbidden_components");
    }

    let authority = value
        .strip_prefix("stratum+tcp://")
        .or_else(|| value.strip_prefix("stratum+ssl://"))
        .or_else(|| value.strip_prefix("stratum+tls://"))
        .ok_or("mining_pool_scheme_not_allowed")?;
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or("mining_pool_port_required")?;
    if host.is_empty()
        || host.starts_with('.')
        || host.ends_with('.')
        || !host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'[' | b']' | b':')
        })
    {
        return Err("mining_invalid_pool_host");
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| "mining_invalid_pool_port")?;
    if port == 0 {
        return Err("mining_invalid_pool_port");
    }
    Ok(())
}

fn requires_tls(pool_url: &str) -> bool {
    pool_url.starts_with("stratum+ssl://") || pool_url.starts_with("stratum+tls://")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_configuration() -> MiningConfiguration {
        MiningConfiguration {
            enabled: true,
            auto_mine_when_idle: true,
            performance_mode: MiningPerformanceMode::Balanced,
            cryptocurrency: "KAS".into(),
            miner_profile_id: "lolminer_kaspa".into(),
            pool_mode: PoolMode::Custom,
            custom_pool_url: Some("stratum+tls://pool.example.com:443".into()),
            wallet_address: "kaspa:qexamplewallet".into(),
            worker_name: "host_001".into(),
            pool_credential_ref: Some("secret_pool_001".into()),
        }
    }

    fn verified_evidence() -> PoolConnectionEvidence {
        PoolConnectionEvidence {
            pool_url: "stratum+tls://pool.example.com:443".into(),
            dns_resolved: true,
            tcp_connected: true,
            tls_verified: true,
            verified_at_unix_seconds: 1_000,
        }
    }

    #[test]
    fn approved_custom_configuration_builds_structured_spec() {
        let configuration = custom_configuration();
        let spec = configuration.build_launch_spec(None).unwrap().unwrap();
        assert_eq!(spec.miner_profile_id, "lolminer_kaspa");
        assert_eq!(spec.pool_url, "stratum+tls://pool.example.com:443");
    }

    #[test]
    fn fresh_connection_evidence_is_required_before_verified_launch() {
        let configuration = custom_configuration();
        assert_eq!(
            configuration.status(None, 1_010, 60).unwrap(),
            MiningConfigurationStatus::NeedsConnectionTest
        );
        let spec = configuration
            .build_verified_launch_spec(&verified_evidence(), 1_010, 60)
            .unwrap()
            .unwrap();
        assert_eq!(spec.pool_url, "stratum+tls://pool.example.com:443");
    }

    #[test]
    fn stale_or_mismatched_connection_evidence_never_authorizes_launch() {
        let configuration = custom_configuration();
        assert_eq!(
            configuration
                .status(Some(&verified_evidence()), 2_000, 60)
                .unwrap(),
            MiningConfigurationStatus::NeedsConnectionTest
        );

        let mut mismatch = verified_evidence();
        mismatch.pool_url = "stratum+tls://other.example.com:443".into();
        assert_eq!(
            configuration.status(Some(&mismatch), 1_010, 60),
            Err("mining_pool_evidence_url_mismatch")
        );
    }

    #[test]
    fn tls_pool_requires_verified_tls() {
        let configuration = custom_configuration();
        let mut evidence = verified_evidence();
        evidence.tls_verified = false;
        assert_eq!(
            configuration.status(Some(&evidence), 1_010, 60),
            Err("mining_pool_tls_unverified")
        );
    }

    #[test]
    fn pinned_lolminer_coin_profiles_are_approved() {
        for (coin, profile) in [
            ("ALPH", "lolminer_blake3"),
            ("CFX", "lolminer_octopus"),
            ("ETC", "lolminer_etchash"),
        ] {
            let mut configuration = custom_configuration();
            configuration.cryptocurrency = coin.into();
            configuration.miner_profile_id = profile.into();
            assert!(configuration.validate().is_ok());
        }
    }

    #[test]
    fn arbitrary_executable_profile_is_rejected() {
        let mut configuration = custom_configuration();
        configuration.miner_profile_id = "powershell".into();
        assert_eq!(configuration.validate(), Err("mining_profile_not_approved"));
    }

    #[test]
    fn pool_url_cannot_embed_credentials_or_query_parameters() {
        let mut configuration = custom_configuration();
        configuration.custom_pool_url =
            Some("stratum+tcp://user:password@pool.example.com:3333?x=1".into());
        assert_eq!(
            configuration.validate(),
            Err("mining_pool_url_contains_forbidden_components")
        );
    }

    #[test]
    fn raw_pool_password_is_rejected() {
        let mut configuration = custom_configuration();
        configuration.pool_credential_ref = Some("password123".into());
        assert_eq!(
            configuration.validate(),
            Err("mining_credential_must_be_secret_reference")
        );
    }

    #[test]
    fn managed_pool_is_disabled_for_operational_configuration() {
        let mut configuration = custom_configuration();
        configuration.pool_mode = PoolMode::Managed;
        configuration.custom_pool_url = None;
        assert_eq!(configuration.validate(), Err("managed_pool_disabled"));
        assert_eq!(
            configuration.build_launch_spec(Some("stratum+tls://managed.example.com:443")),
            Err("managed_pool_disabled")
        );
    }

    #[test]
    fn renter_and_control_plane_cannot_change_owner_mining_configuration() {
        assert!(authorize_configuration_change(MiningConfigurationActor::HostOwner).is_ok());
        assert_eq!(
            authorize_configuration_change(MiningConfigurationActor::Renter),
            Err("mining_configuration_change_forbidden")
        );
        assert_eq!(
            authorize_configuration_change(MiningConfigurationActor::ControlPlane),
            Err("mining_configuration_change_forbidden")
        );
    }
}
