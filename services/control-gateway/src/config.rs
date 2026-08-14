use std::{env, net::SocketAddr, path::PathBuf};

use anyhow::{bail, Context, Result};

#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub gateway_id: String,
    pub region: String,
    pub quic_bind: SocketAddr,
    pub admin_bind: SocketAddr,
    pub tls_cert: PathBuf,
    pub tls_key: PathBuf,
    pub redis_url: String,
    pub internal_token: String,
    pub max_connections: usize,
    pub per_connection_queue: usize,
    pub max_pending_commands_per_machine: usize,
    pub presence_ttl_seconds: u64,
    pub heartbeat_timeout_seconds: u64,
    pub auth_clock_skew_seconds: u64,
    pub command_retention_seconds: u64,
    pub max_control_frame_bytes: usize,
}

impl GatewayConfig {
    pub fn from_env() -> Result<Self> {
        let gateway_id = required("GPUBNB_CONTROL_GATEWAY_ID")?;
        if !safe_id(&gateway_id) {
            bail!("GPUBNB_CONTROL_GATEWAY_ID is invalid");
        }
        let region = required("GPUBNB_CONTROL_REGION")?;
        if !safe_region(&region) {
            bail!("GPUBNB_CONTROL_REGION is invalid");
        }

        let quic_bind = parse_addr("GPUBNB_CONTROL_QUIC_BIND", "0.0.0.0:4443")?;
        let admin_bind = parse_addr("GPUBNB_CONTROL_ADMIN_BIND", "0.0.0.0:9090")?;
        let tls_cert = PathBuf::from(required("GPUBNB_CONTROL_TLS_CERT")?);
        let tls_key = PathBuf::from(required("GPUBNB_CONTROL_TLS_KEY")?);
        let redis_url = required("GPUBNB_CONTROL_REDIS_URL")?;
        if !(redis_url.starts_with("redis://") || redis_url.starts_with("rediss://")) {
            bail!("GPUBNB_CONTROL_REDIS_URL must use redis:// or rediss://");
        }
        let internal_token = required("GPUBNB_CONTROL_INTERNAL_TOKEN")?;
        if !(32..=256).contains(&internal_token.len()) {
            bail!("GPUBNB_CONTROL_INTERNAL_TOKEN must contain 32..=256 bytes");
        }

        let max_connections = bounded_usize(
            "GPUBNB_CONTROL_MAX_CONNECTIONS",
            50_000,
            1,
            1_000_000,
        )?;
        let per_connection_queue = bounded_usize(
            "GPUBNB_CONTROL_CONNECTION_QUEUE",
            128,
            8,
            4_096,
        )?;
        let max_pending_commands_per_machine = bounded_usize(
            "GPUBNB_CONTROL_PENDING_PER_MACHINE",
            256,
            1,
            4_096,
        )?;
        let presence_ttl_seconds = bounded_u64(
            "GPUBNB_CONTROL_PRESENCE_TTL_SECONDS",
            60,
            15,
            300,
        )?;
        let heartbeat_timeout_seconds = bounded_u64(
            "GPUBNB_CONTROL_HEARTBEAT_TIMEOUT_SECONDS",
            45,
            10,
            300,
        )?;
        if heartbeat_timeout_seconds >= presence_ttl_seconds {
            bail!("heartbeat timeout must be lower than presence TTL");
        }
        let auth_clock_skew_seconds = bounded_u64(
            "GPUBNB_CONTROL_AUTH_CLOCK_SKEW_SECONDS",
            30,
            5,
            120,
        )?;
        let command_retention_seconds = bounded_u64(
            "GPUBNB_CONTROL_COMMAND_RETENTION_SECONDS",
            300,
            30,
            3_600,
        )?;
        let max_control_frame_bytes = bounded_usize(
            "GPUBNB_CONTROL_MAX_FRAME_BYTES",
            64 * 1024,
            4 * 1024,
            256 * 1024,
        )?;

        Ok(Self {
            gateway_id,
            region,
            quic_bind,
            admin_bind,
            tls_cert,
            tls_key,
            redis_url,
            internal_token,
            max_connections,
            per_connection_queue,
            max_pending_commands_per_machine,
            presence_ttl_seconds,
            heartbeat_timeout_seconds,
            auth_clock_skew_seconds,
            command_retention_seconds,
            max_control_frame_bytes,
        })
    }
}

fn required(name: &str) -> Result<String> {
    let value = env::var(name).with_context(|| format!("missing required environment variable {name}"))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("required environment variable {name} is empty");
    }
    Ok(trimmed.to_owned())
}

fn parse_addr(name: &str, default: &str) -> Result<SocketAddr> {
    let raw = env::var(name).unwrap_or_else(|_| default.to_owned());
    raw.parse().with_context(|| format!("{name} must be a socket address"))
}

fn bounded_usize(name: &str, default: usize, min: usize, max: usize) -> Result<usize> {
    let value = match env::var(name) {
        Ok(raw) => raw.trim().parse::<usize>().with_context(|| format!("{name} must be an integer"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("failed to read {name}")),
    };
    if !(min..=max).contains(&value) {
        bail!("{name} must be between {min} and {max}");
    }
    Ok(value)
}

fn bounded_u64(name: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    let value = match env::var(name) {
        Ok(raw) => raw.trim().parse::<u64>().with_context(|| format!("{name} must be an integer"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("failed to read {name}")),
    };
    if !(min..=max).contains(&value) {
        bail!("{name} must be between {min} and {max}");
    }
    Ok(value)
}

fn safe_id(value: &str) -> bool {
    (8..=160).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':' | b'.')
        })
}

fn safe_region(value: &str) -> bool {
    (2..=32).contains(&value.len())
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_regions_are_bounded() {
        assert!(safe_id("gateway_eu_0001"));
        assert!(!safe_id("short"));
        assert!(safe_region("eu-west-1"));
        assert!(!safe_region("EU-west-1"));
    }
}
