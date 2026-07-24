use serde::{Deserialize, Serialize};
use std::net::IpAddr;

const MAX_HOST_LEN: usize = 253;
const MAX_WALLET_LEN: usize = 128;
const MAX_WORKER_LEN: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiningDevice {
    Cpu,
    Gpu,
    CpuAndGpu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportedAsset {
    Monero,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPoolProfile {
    pub asset: SupportedAsset,
    pub device: MiningDevice,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub wallet_address: String,
    pub worker_name: String,
}

impl ExternalPoolProfile {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_pool_host(&self.host)?;

        if self.port == 0 {
            return Err("invalid_pool_port");
        }
        if !self.tls {
            return Err("external_pool_tls_required");
        }

        validate_monero_wallet(&self.wallet_address)?;
        validate_worker_name(&self.worker_name)?;
        Ok(())
    }
}

fn validate_pool_host(host: &str) -> Result<(), &'static str> {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return Err("invalid_pool_host");
    }

    let normalized = host.trim_end_matches('.');
    if normalized.parse::<IpAddr>().is_ok() {
        return Err("pool_ip_literal_not_allowed");
    }

    if normalized.eq_ignore_ascii_case("localhost")
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".internal")
    {
        return Err("private_pool_host_not_allowed");
    }

    let labels: Vec<&str> = normalized.split('.').collect();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("invalid_pool_host");
    }

    Ok(())
}

fn validate_monero_wallet(wallet: &str) -> Result<(), &'static str> {
    if wallet.len() > MAX_WALLET_LEN || !matches!(wallet.len(), 95 | 106) {
        return Err("invalid_monero_wallet");
    }

    if !wallet
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() && !matches!(byte, b'0' | b'O' | b'I' | b'l'))
    {
        return Err("invalid_monero_wallet");
    }

    Ok(())
}

fn validate_worker_name(worker: &str) -> Result<(), &'static str> {
    if worker.is_empty()
        || worker.len() > MAX_WORKER_LEN
        || !worker
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid_worker_name");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ExternalPoolProfile {
        ExternalPoolProfile {
            asset: SupportedAsset::Monero,
            device: MiningDevice::Cpu,
            host: "pool.example.org".into(),
            port: 443,
            tls: true,
            wallet_address: "4".repeat(95),
            worker_name: "host-cpu-0".into(),
        }
    }

    #[test]
    fn valid_monero_external_pool_is_accepted() {
        assert_eq!(profile().validate(), Ok(()));
    }

    #[test]
    fn plaintext_pool_is_rejected() {
        let mut value = profile();
        value.tls = false;
        assert_eq!(value.validate(), Err("external_pool_tls_required"));
    }

    #[test]
    fn local_and_ip_targets_are_rejected() {
        for host in ["localhost", "miner.local", "127.0.0.1", "169.254.169.254"] {
            let mut value = profile();
            value.host = host.into();
            assert!(value.validate().is_err(), "{host} must be rejected");
        }
    }

    #[test]
    fn shell_fragments_are_rejected() {
        let mut value = profile();
        value.worker_name = "worker;shutdown".into();
        assert_eq!(value.validate(), Err("invalid_worker_name"));
    }
}
