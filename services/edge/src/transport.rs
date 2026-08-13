use std::{env, time::Duration};

use anyhow::{bail, Context, Result};
use quinn::{IdleTimeout, TransportConfig, VarInt};

use crate::Limits;

const MIB: u64 = 1024 * 1024;

pub const MAX_BIDI_STREAMS: u32 = 64;
pub const MAX_UNI_STREAMS: u32 = 0;
pub const STREAM_RECEIVE_WINDOW_BYTES: u32 = 2 * 1024 * 1024;
pub const CONNECTION_RECEIVE_WINDOW_BYTES: u32 = 8 * 1024 * 1024;
pub const CONNECTION_SEND_WINDOW_BYTES: u64 = 8 * MIB;

pub const DEFAULT_MAX_CONNECTIONS: usize = 256;
pub const MAX_CONFIGURED_CONNECTIONS: usize = 4096;
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 60_000;
pub const MIN_IDLE_TIMEOUT_MS: u64 = 5_000;
pub const MAX_IDLE_TIMEOUT_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeTransportPolicy {
    pub max_connections: usize,
    pub idle_timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionAction {
    Accept,
    Retry,
    Refuse,
}

impl RuntimeTransportPolicy {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            max_connections: parse_max_connections(
                env::var("GPUBNB_EDGE_MAX_CONNECTIONS").ok().as_deref(),
            )?,
            idle_timeout_ms: parse_idle_timeout_ms(
                env::var("GPUBNB_EDGE_IDLE_TIMEOUT_MS").ok().as_deref(),
            )?,
        })
    }

    pub fn retry_threshold(self) -> usize {
        // Require address validation only once the Edge is under sustained
        // connection pressure. Normal traffic avoids the extra Retry RTT.
        self.max_connections.saturating_mul(3).saturating_add(3) / 4
    }
}

pub fn parse_max_connections(raw: Option<&str>) -> Result<usize> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_MAX_CONNECTIONS);
    };
    let value = raw
        .trim()
        .parse::<usize>()
        .context("GPUBNB_EDGE_MAX_CONNECTIONS must be a positive integer")?;
    if !(1..=MAX_CONFIGURED_CONNECTIONS).contains(&value) {
        bail!("GPUBNB_EDGE_MAX_CONNECTIONS must be between 1 and {MAX_CONFIGURED_CONNECTIONS}");
    }
    Ok(value)
}

pub fn parse_idle_timeout_ms(raw: Option<&str>) -> Result<u64> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_IDLE_TIMEOUT_MS);
    };
    let value = raw
        .trim()
        .parse::<u64>()
        .context("GPUBNB_EDGE_IDLE_TIMEOUT_MS must be an integer number of milliseconds")?;
    if !(MIN_IDLE_TIMEOUT_MS..=MAX_IDLE_TIMEOUT_MS).contains(&value) {
        bail!(
            "GPUBNB_EDGE_IDLE_TIMEOUT_MS must be between {MIN_IDLE_TIMEOUT_MS} and {MAX_IDLE_TIMEOUT_MS}"
        );
    }
    Ok(value)
}

pub fn admission_action(
    open_connections: usize,
    remote_address_validated: bool,
    policy: RuntimeTransportPolicy,
) -> AdmissionAction {
    if open_connections >= policy.max_connections {
        return AdmissionAction::Refuse;
    }
    if open_connections >= policy.retry_threshold() && !remote_address_validated {
        return AdmissionAction::Retry;
    }
    AdmissionAction::Accept
}

pub fn configure_transport(
    transport: &mut TransportConfig,
    policy: RuntimeTransportPolicy,
) -> Result<()> {
    let idle_timeout = IdleTimeout::try_from(Duration::from_millis(policy.idle_timeout_ms))
        .context("QUIC idle timeout does not fit transport encoding")?;

    transport
        .max_concurrent_bidi_streams(VarInt::from_u32(MAX_BIDI_STREAMS))
        .max_concurrent_uni_streams(VarInt::from_u32(MAX_UNI_STREAMS))
        .stream_receive_window(VarInt::from_u32(STREAM_RECEIVE_WINDOW_BYTES))
        .receive_window(VarInt::from_u32(CONNECTION_RECEIVE_WINDOW_BYTES))
        .send_window(CONNECTION_SEND_WINDOW_BYTES)
        .max_idle_timeout(Some(idle_timeout));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_windows_are_consistent_with_application_backpressure() {
        let limits = Limits::default();
        assert_eq!(MAX_BIDI_STREAMS as usize, limits.max_streams_per_session);
        assert!(STREAM_RECEIVE_WINDOW_BYTES as usize <= limits.max_buffered_bytes_per_stream);
        assert!(CONNECTION_RECEIVE_WINDOW_BYTES as usize <= limits.max_buffered_bytes_per_session);
        assert!(STREAM_RECEIVE_WINDOW_BYTES <= CONNECTION_RECEIVE_WINDOW_BYTES);
        assert_eq!(MAX_UNI_STREAMS, 0);
    }

    #[test]
    fn runtime_bounds_fail_closed() {
        assert_eq!(
            parse_max_connections(None).unwrap(),
            DEFAULT_MAX_CONNECTIONS
        );
        assert_eq!(parse_max_connections(Some("1")).unwrap(), 1);
        assert_eq!(
            parse_max_connections(Some(&MAX_CONFIGURED_CONNECTIONS.to_string())).unwrap(),
            MAX_CONFIGURED_CONNECTIONS
        );
        assert!(parse_max_connections(Some("0")).is_err());
        assert!(parse_max_connections(Some("4097")).is_err());
        assert!(parse_max_connections(Some("not-a-number")).is_err());

        assert_eq!(
            parse_idle_timeout_ms(None).unwrap(),
            DEFAULT_IDLE_TIMEOUT_MS
        );
        assert_eq!(
            parse_idle_timeout_ms(Some(&MIN_IDLE_TIMEOUT_MS.to_string())).unwrap(),
            MIN_IDLE_TIMEOUT_MS
        );
        assert_eq!(
            parse_idle_timeout_ms(Some(&MAX_IDLE_TIMEOUT_MS.to_string())).unwrap(),
            MAX_IDLE_TIMEOUT_MS
        );
        assert!(parse_idle_timeout_ms(Some("4999")).is_err());
        assert!(parse_idle_timeout_ms(Some("300001")).is_err());
    }

    #[test]
    fn admission_refuses_at_cap_and_retries_unvalidated_clients_under_pressure() {
        let policy = RuntimeTransportPolicy {
            max_connections: 100,
            idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
        };
        assert_eq!(policy.retry_threshold(), 75);
        assert_eq!(admission_action(74, false, policy), AdmissionAction::Accept);
        assert_eq!(admission_action(75, false, policy), AdmissionAction::Retry);
        assert_eq!(admission_action(99, true, policy), AdmissionAction::Accept);
        assert_eq!(admission_action(100, true, policy), AdmissionAction::Refuse);
        assert_eq!(
            admission_action(100, false, policy),
            AdmissionAction::Refuse
        );
    }
}
