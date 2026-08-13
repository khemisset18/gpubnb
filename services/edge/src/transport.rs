use std::{
    env,
    net::{SocketAddr, UdpSocket},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use quinn::{default_runtime, Endpoint, EndpointConfig, IdleTimeout, TransportConfig, VarInt};
use socket2::SockRef;

#[cfg(test)]
use crate::Limits;

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

// Protocol v1 keeps application capacity at 64 workspace streams. Quinn
// deliberately batches MAX_STREAMS updates until more than 1/8 of the current
// remote-stream window has been freed, so transport needs bounded spare credit
// for auth, explicit over-capacity rejection, and normal stream churn while a
// replenishment update is pending. With 75 transport credits, Quinn's threshold
// is 9; a reserve of 10 guarantees progress until the next MAX_STREAMS update.
pub const MAX_APPLICATION_BIDI_STREAMS: u32 = 64;
pub const CONTROL_BIDI_STREAM_RESERVE: u32 = 1;
pub const STREAM_CREDIT_REPLENISHMENT_RESERVE: u32 = 10;
pub const MAX_BIDI_STREAMS: u32 = MAX_APPLICATION_BIDI_STREAMS
    + CONTROL_BIDI_STREAM_RESERVE
    + STREAM_CREDIT_REPLENISHMENT_RESERVE;
pub const MAX_UNI_STREAMS: u32 = 0;
pub const STREAM_RECEIVE_WINDOW_BYTES: u32 = 2 * 1024 * 1024;
pub const CONNECTION_RECEIVE_WINDOW_BYTES: u32 = 8 * 1024 * 1024;
pub const CONNECTION_SEND_WINDOW_BYTES: u64 = 8 * 1024 * 1024;

const _: () = assert!(STREAM_RECEIVE_WINDOW_BYTES <= CONNECTION_RECEIVE_WINDOW_BYTES);
const _: () = assert!(STREAM_CREDIT_REPLENISHMENT_RESERVE > MAX_BIDI_STREAMS / 8);

pub const DEFAULT_MAX_CONNECTIONS: usize = 256;
pub const MAX_CONFIGURED_CONNECTIONS: usize = 4096;
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 60_000;
pub const MIN_IDLE_TIMEOUT_MS: u64 = 5_000;
pub const MAX_IDLE_TIMEOUT_MS: u64 = 300_000;

// A single Quinn endpoint is backed by one UDP socket. The 16 MiB target is
// intentionally above the ~12.5 MiB bandwidth-delay product of 1 Gbit/s at
// 100 ms RTT, while remaining bounded. Production nodes run with strict mode
// and OS socket limits raised high enough for the requested value.
pub const DEFAULT_UDP_BUFFER_BYTES: usize = 16 * MIB;
pub const MIN_UDP_BUFFER_BYTES: usize = 256 * KIB;
pub const MAX_UDP_BUFFER_BYTES: usize = 64 * MIB;

// Receive_window caps aggregate receive-side stream buffering for a QUIC
// connection; send_window caps the sender. The explicit transport budget uses
// both caps and deliberately excludes application buffers, which are bounded
// independently by EdgeRegistry.
pub const PER_CONNECTION_TRANSPORT_BUDGET_BYTES: usize =
    CONNECTION_RECEIVE_WINDOW_BYTES as usize + CONNECTION_SEND_WINDOW_BYTES as usize;
pub const DEFAULT_TRANSPORT_MEMORY_BUDGET_MIB: usize = 4096;
pub const MIN_TRANSPORT_MEMORY_BUDGET_MIB: usize = 256;
pub const MAX_TRANSPORT_MEMORY_BUDGET_MIB: usize = 65_536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeTransportPolicy {
    pub max_connections: usize,
    pub idle_timeout_ms: u64,
    pub udp_buffer_bytes: usize,
    pub udp_buffer_strict: bool,
    pub transport_memory_budget_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UdpBufferState {
    pub requested_bytes: usize,
    pub receive_bytes: usize,
    pub send_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionAction {
    Accept,
    Retry,
    Refuse,
}

impl RuntimeTransportPolicy {
    pub fn from_env() -> Result<Self> {
        let max_connections =
            parse_max_connections(env::var("GPUBNB_EDGE_MAX_CONNECTIONS").ok().as_deref())?;
        let transport_memory_budget_mib = parse_transport_memory_budget_mib(
            env::var("GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB")
                .ok()
                .as_deref(),
        )?;
        let transport_memory_budget_bytes = transport_memory_budget_mib
            .checked_mul(MIB)
            .context("transport memory budget overflow")?;
        validate_transport_memory_budget(max_connections, transport_memory_budget_bytes)?;

        Ok(Self {
            max_connections,
            idle_timeout_ms: parse_idle_timeout_ms(
                env::var("GPUBNB_EDGE_IDLE_TIMEOUT_MS").ok().as_deref(),
            )?,
            udp_buffer_bytes: parse_udp_buffer_bytes(
                env::var("GPUBNB_EDGE_UDP_BUFFER_BYTES").ok().as_deref(),
            )?,
            udp_buffer_strict: parse_strict_bool(
                env::var("GPUBNB_EDGE_UDP_BUFFER_STRICT").ok().as_deref(),
                false,
                "GPUBNB_EDGE_UDP_BUFFER_STRICT",
            )?,
            transport_memory_budget_bytes,
        })
    }

    pub fn retry_threshold(self) -> usize {
        // Require address validation only once the Edge is under sustained
        // connection pressure. Normal traffic avoids the extra Retry RTT.
        self.max_connections.saturating_mul(3).saturating_add(3) / 4
    }

    pub fn transport_reservation_bytes(self) -> Result<usize> {
        transport_reservation_bytes(self.max_connections)
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

pub fn parse_udp_buffer_bytes(raw: Option<&str>) -> Result<usize> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_UDP_BUFFER_BYTES);
    };
    let value = raw
        .trim()
        .parse::<usize>()
        .context("GPUBNB_EDGE_UDP_BUFFER_BYTES must be an integer number of bytes")?;
    if !(MIN_UDP_BUFFER_BYTES..=MAX_UDP_BUFFER_BYTES).contains(&value) {
        bail!(
            "GPUBNB_EDGE_UDP_BUFFER_BYTES must be between {MIN_UDP_BUFFER_BYTES} and {MAX_UDP_BUFFER_BYTES}"
        );
    }
    Ok(value)
}

pub fn parse_transport_memory_budget_mib(raw: Option<&str>) -> Result<usize> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_TRANSPORT_MEMORY_BUDGET_MIB);
    };
    let value = raw
        .trim()
        .parse::<usize>()
        .context("GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB must be an integer MiB value")?;
    if !(MIN_TRANSPORT_MEMORY_BUDGET_MIB..=MAX_TRANSPORT_MEMORY_BUDGET_MIB).contains(&value) {
        bail!(
            "GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB must be between {MIN_TRANSPORT_MEMORY_BUDGET_MIB} and {MAX_TRANSPORT_MEMORY_BUDGET_MIB}"
        );
    }
    Ok(value)
}

fn parse_strict_bool(raw: Option<&str>, default_value: bool, name: &str) -> Result<bool> {
    let Some(raw) = raw else {
        return Ok(default_value);
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be a strict boolean"),
    }
}

pub fn transport_reservation_bytes(max_connections: usize) -> Result<usize> {
    max_connections
        .checked_mul(PER_CONNECTION_TRANSPORT_BUDGET_BYTES)
        .context("configured QUIC transport reservation overflow")
}

pub fn validate_transport_memory_budget(
    max_connections: usize,
    transport_memory_budget_bytes: usize,
) -> Result<()> {
    let required = transport_reservation_bytes(max_connections)?;
    if required > transport_memory_budget_bytes {
        bail!(
            "configured QUIC transport reservation ({required} bytes) exceeds node transport memory budget ({transport_memory_budget_bytes} bytes)"
        );
    }
    Ok(())
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

pub fn bind_server_endpoint(
    server_config: quinn::ServerConfig,
    bind: SocketAddr,
    policy: RuntimeTransportPolicy,
) -> Result<(Endpoint, UdpBufferState)> {
    let socket =
        UdpSocket::bind(bind).with_context(|| format!("failed to bind QUIC UDP socket {bind}"))?;
    socket
        .set_nonblocking(true)
        .context("failed to configure QUIC UDP socket nonblocking mode")?;

    let socket_ref = SockRef::from(&socket);
    socket_ref
        .set_recv_buffer_size(policy.udp_buffer_bytes)
        .context("failed to set QUIC UDP receive buffer")?;
    socket_ref
        .set_send_buffer_size(policy.udp_buffer_bytes)
        .context("failed to set QUIC UDP send buffer")?;
    let receive_bytes = socket_ref
        .recv_buffer_size()
        .context("failed to read QUIC UDP receive buffer")?;
    let send_bytes = socket_ref
        .send_buffer_size()
        .context("failed to read QUIC UDP send buffer")?;

    if policy.udp_buffer_strict
        && (receive_bytes < policy.udp_buffer_bytes || send_bytes < policy.udp_buffer_bytes)
    {
        bail!(
            "QUIC UDP socket buffers below strict target: requested={} receive={} send={}",
            policy.udp_buffer_bytes,
            receive_bytes,
            send_bytes
        );
    }

    let runtime = default_runtime().ok_or_else(|| anyhow!("no Quinn async runtime available"))?;
    let endpoint = Endpoint::new(
        EndpointConfig::default(),
        Some(server_config),
        socket,
        runtime,
    )
    .context("failed to create QUIC Edge endpoint")?;

    Ok((
        endpoint,
        UdpBufferState {
            requested_bytes: policy.udp_buffer_bytes,
            receive_bytes,
            send_bytes,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(max_connections: usize) -> RuntimeTransportPolicy {
        RuntimeTransportPolicy {
            max_connections,
            idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
            udp_buffer_bytes: DEFAULT_UDP_BUFFER_BYTES,
            udp_buffer_strict: false,
            transport_memory_budget_bytes: DEFAULT_TRANSPORT_MEMORY_BUDGET_MIB * MIB,
        }
    }

    #[test]
    fn transport_windows_are_consistent_with_application_backpressure() {
        let limits = Limits::default();
        assert_eq!(
            MAX_APPLICATION_BIDI_STREAMS as usize,
            limits.max_streams_per_session
        );
        assert_eq!(CONTROL_BIDI_STREAM_RESERVE, 1);
        assert_eq!(STREAM_CREDIT_REPLENISHMENT_RESERVE, 10);
        assert_eq!(
            MAX_BIDI_STREAMS,
            MAX_APPLICATION_BIDI_STREAMS
                + CONTROL_BIDI_STREAM_RESERVE
                + STREAM_CREDIT_REPLENISHMENT_RESERVE
        );
        assert!(STREAM_RECEIVE_WINDOW_BYTES as usize <= limits.max_buffered_bytes_per_stream);
        assert!(CONNECTION_RECEIVE_WINDOW_BYTES as usize <= limits.max_buffered_bytes_per_session);
        assert_eq!(MAX_UNI_STREAMS, 0);
        assert_eq!(PER_CONNECTION_TRANSPORT_BUDGET_BYTES, 16 * MIB);
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

        assert_eq!(
            parse_udp_buffer_bytes(None).unwrap(),
            DEFAULT_UDP_BUFFER_BYTES
        );
        assert!(parse_udp_buffer_bytes(Some("1")).is_err());
        assert!(parse_udp_buffer_bytes(Some("67108865")).is_err());

        assert_eq!(
            parse_transport_memory_budget_mib(None).unwrap(),
            DEFAULT_TRANSPORT_MEMORY_BUDGET_MIB
        );
        assert!(parse_transport_memory_budget_mib(Some("255")).is_err());
        assert!(parse_transport_memory_budget_mib(Some("65537")).is_err());
        assert!(parse_strict_bool(Some("true"), false, "x").unwrap());
        assert!(!parse_strict_bool(Some("off"), true, "x").unwrap());
        assert!(parse_strict_bool(Some("maybe"), false, "x").is_err());
    }

    #[test]
    fn memory_budget_rejects_connection_oversubscription() {
        let four_gib = 4096 * MIB;
        assert_eq!(transport_reservation_bytes(256).unwrap(), four_gib);
        assert!(validate_transport_memory_budget(256, four_gib).is_ok());
        assert!(validate_transport_memory_budget(257, four_gib).is_err());
    }

    #[test]
    fn admission_refuses_at_cap_and_retries_unvalidated_clients_under_pressure() {
        let policy = policy(100);
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
