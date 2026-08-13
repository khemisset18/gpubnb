#![forbid(unsafe_code)]

#[path = "../authority.rs"]
mod authority;
#[path = "../replay.rs"]
mod replay;
#[path = "../transport.rs"]
mod transport;

use std::{
    env,
    fs::File,
    io::BufReader,
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use authority::{parse_verifying_key_hex, validate_edge_id, verify_authority};
use ed25519_dalek::VerifyingKey;
use gpubnb_edge_core::{EdgeRegistry, Limits, ALPN};
use quinn::{crypto::rustls::QuicServerConfig, Endpoint};
use replay::{ReplayError, ReplayStore};
use tokio::sync::Mutex;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use transport::{
    admission_action, configure_transport, AdmissionAction, RuntimeTransportPolicy,
    CONNECTION_RECEIVE_WINDOW_BYTES, CONNECTION_SEND_WINDOW_BYTES, MAX_BIDI_STREAMS,
    MAX_UNI_STREAMS, STREAM_RECEIVE_WINDOW_BYTES,
};

const AUTHORITY_MAX_BYTES: usize = 16 * 1024;
const CONTROL_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const DEFAULT_REPLAY_CACHE_CAPACITY: usize = 100_000;
const MAX_REPLAY_CACHE_CAPACITY: usize = 1_000_000;

fn now_ms() -> Result<u64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock before Unix epoch")?;
    u64::try_from(duration.as_millis()).context("system time does not fit u64 milliseconds")
}

fn required_env(name: &str) -> Result<String> {
    let value =
        env::var(name).with_context(|| format!("missing required environment variable {name}"))?;
    if value.trim().is_empty() {
        bail!("required environment variable {name} is empty");
    }
    Ok(value)
}

fn replay_cache_capacity() -> Result<usize> {
    match env::var("GPUBNB_EDGE_REPLAY_CACHE_CAPACITY") {
        Ok(raw) => {
            let capacity = raw
                .trim()
                .parse::<usize>()
                .context("GPUBNB_EDGE_REPLAY_CACHE_CAPACITY must be a positive integer")?;
            if !(1..=MAX_REPLAY_CACHE_CAPACITY).contains(&capacity) {
                bail!(
                    "GPUBNB_EDGE_REPLAY_CACHE_CAPACITY must be between 1 and {MAX_REPLAY_CACHE_CAPACITY}"
                );
            }
            Ok(capacity)
        }
        Err(env::VarError::NotPresent) => Ok(DEFAULT_REPLAY_CACHE_CAPACITY),
        Err(error) => Err(anyhow!(
            "failed to read GPUBNB_EDGE_REPLAY_CACHE_CAPACITY: {error}"
        )),
    }
}

fn load_server_config(
    cert_path: &str,
    key_path: &str,
    transport_policy: RuntimeTransportPolicy,
) -> Result<quinn::ServerConfig> {
    let mut cert_reader = BufReader::new(
        File::open(cert_path)
            .with_context(|| format!("failed to open TLS certificate {cert_path}"))?,
    );
    let certs = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .context("failed to parse TLS certificate chain")?;
    if certs.is_empty() {
        bail!("TLS certificate chain is empty");
    }

    let mut key_reader = BufReader::new(
        File::open(key_path)
            .with_context(|| format!("failed to open TLS private key {key_path}"))?,
    );
    let key = rustls_pemfile::private_key(&mut key_reader)
        .context("failed to parse TLS private key")?
        .ok_or_else(|| anyhow!("TLS private key file contains no supported private key"))?;

    let mut tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("TLS certificate/private key rejected")?;
    tls.alpn_protocols = vec![ALPN.as_bytes().to_vec()];
    // GPUbnb has no replay-safe 0-RTT application profile. Keep early data and
    // half-RTT responses explicitly disabled even though rustls currently
    // defaults both settings to disabled.
    tls.max_early_data_size = 0;
    tls.send_half_rtt_data = false;

    let crypto =
        QuicServerConfig::try_from(tls).context("TLS configuration is not QUIC-compatible")?;
    let mut server = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    let transport = Arc::get_mut(&mut server.transport)
        .ok_or_else(|| anyhow!("QUIC transport configuration unexpectedly shared"))?;
    configure_transport(transport, transport_policy)?;
    Ok(server)
}

async fn write_control_response(send: &mut quinn::SendStream, payload: &[u8]) -> Result<()> {
    if payload.len() > CONTROL_RESPONSE_MAX_BYTES {
        bail!("control response too large");
    }
    send.write_all(payload)
        .await
        .context("failed to write QUIC control response")?;
    send.finish()
        .context("failed to finish QUIC control response")?;
    Ok(())
}

async fn handle_connection(
    connection: quinn::Connection,
    registry: Arc<Mutex<EdgeRegistry>>,
    replay_store: Arc<Mutex<ReplayStore>>,
    verifying_key: Arc<VerifyingKey>,
    edge_id: Arc<String>,
) -> Result<()> {
    let remote = connection.remote_address();
    let (mut send, mut recv) = connection
        .accept_bi()
        .await
        .context("connection closed before authority stream")?;
    let raw = recv
        .read_to_end(AUTHORITY_MAX_BYTES)
        .await
        .context("failed to read authority stream")?;
    let authenticated_at_ms = now_ms()?;
    let binding = verify_authority(&raw, &verifying_key, edge_id.as_str(), authenticated_at_ms)?;
    let session_id = binding.session_id.clone();

    {
        let mut guard = replay_store.lock().await;
        match guard.consume(&binding, authenticated_at_ms) {
            Ok(()) => {}
            Err(ReplayError::AlreadyConsumed) => {
                warn!(
                    event = "edge_authority_replay_rejected",
                    remote = %remote,
                    "replayed data-plane authority rejected"
                );
                bail!("data-plane authority already consumed");
            }
            Err(ReplayError::Capacity) => {
                warn!(
                    event = "edge_replay_store_saturated",
                    remote = %remote,
                    "authority replay store capacity exhausted"
                );
                bail!("authority replay store capacity exhausted");
            }
            Err(ReplayError::Persistence) => {
                error!(
                    event = "edge_replay_store_persistence_failure",
                    remote = %remote,
                    "authority rejected because replay state could not be durably committed"
                );
                bail!("authority replay state persistence failed");
            }
        }
    }

    {
        let mut guard = registry.lock().await;
        guard
            .register_session(binding, authenticated_at_ms)
            .map_err(|error| anyhow!("session registration rejected: {error:?}"))?;
    }

    if let Err(error) =
        write_control_response(&mut send, br#"{"ok":true,"protocol":"gpubnb-dp/1"}"#).await
    {
        let mut guard = registry.lock().await;
        let _ = guard.remove_session(&session_id);
        return Err(error);
    }

    info!(
        event = "edge_session_authenticated",
        remote = %remote,
        edge = %edge_id,
        session = %session_id,
        "authenticated QUIC data-plane session"
    );

    let close = connection.closed().await;
    {
        let mut guard = registry.lock().await;
        let _ = guard.remove_session(&session_id);
    }
    info!(
        event = "edge_session_closed",
        remote = %remote,
        edge = %edge_id,
        session = %session_id,
        reason = ?close,
        "QUIC data-plane session closed"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        // Edge logs are consumed by CI, probes and operations automation. Keep
        // them deterministic even when stderr/stdout is attached to a TTY.
        .with_ansi(false)
        .with_target(false)
        .compact()
        .init();

    let bind: SocketAddr = required_env("GPUBNB_EDGE_BIND")?
        .parse()
        .context("GPUBNB_EDGE_BIND must be a socket address such as 0.0.0.0:4433")?;
    let cert_path = required_env("GPUBNB_EDGE_TLS_CERT")?;
    let key_path = required_env("GPUBNB_EDGE_TLS_KEY")?;
    let replay_capacity = replay_cache_capacity()?;
    let replay_dir = required_env("GPUBNB_EDGE_REPLAY_DIR")?;
    let transport_policy = RuntimeTransportPolicy::from_env()?;
    let edge_id = Arc::new(required_env("GPUBNB_EDGE_ID")?);
    validate_edge_id(edge_id.as_str()).context("GPUBNB_EDGE_ID invalid")?;
    let verifying_key = Arc::new(parse_verifying_key_hex(&required_env(
        "GPUBNB_EDGE_AUTHORITY_PUBLIC_KEY_HEX",
    )?)?);

    let endpoint = Endpoint::server(
        load_server_config(&cert_path, &key_path, transport_policy)?,
        bind,
    )
    .context("failed to bind QUIC Edge endpoint")?;
    let registry = Arc::new(Mutex::new(EdgeRegistry::new(Limits::default())));
    let replay_store = ReplayStore::open(&replay_dir, replay_capacity, now_ms()?)
        .context("failed to initialize durable authority replay store")?;
    let replay_entries = replay_store.len();
    let replay_quarantined = replay_store.quarantined_markers();
    let replay_store = Arc::new(Mutex::new(replay_store));

    info!(
        event = "edge_ready",
        bind = %endpoint.local_addr()?,
        edge = %edge_id,
        alpn = ALPN,
        replay_store_capacity = replay_capacity,
        replay_store_entries = replay_entries,
        replay_store_quarantined = replay_quarantined,
        max_connections = transport_policy.max_connections,
        retry_threshold = transport_policy.retry_threshold(),
        idle_timeout_ms = transport_policy.idle_timeout_ms,
        max_bidi_streams = MAX_BIDI_STREAMS,
        max_uni_streams = MAX_UNI_STREAMS,
        stream_receive_window_bytes = STREAM_RECEIVE_WINDOW_BYTES,
        connection_receive_window_bytes = CONNECTION_RECEIVE_WINDOW_BYTES,
        connection_send_window_bytes = CONNECTION_SEND_WINDOW_BYTES,
        "GPUbnb Edge ready"
    );

    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break; };
                let remote = incoming.remote_address();
                let open_connections = endpoint.open_connections();
                match admission_action(
                    open_connections,
                    incoming.remote_address_validated(),
                    transport_policy,
                ) {
                    AdmissionAction::Refuse => {
                        warn!(
                            event = "edge_connection_refused_capacity",
                            remote = %remote,
                            open_connections,
                            max_connections = transport_policy.max_connections,
                            "QUIC connection refused at Edge capacity"
                        );
                        incoming.refuse();
                        continue;
                    }
                    AdmissionAction::Retry => {
                        info!(
                            event = "edge_address_retry_required",
                            remote = %remote,
                            open_connections,
                            retry_threshold = transport_policy.retry_threshold(),
                            "requiring QUIC address validation under connection pressure"
                        );
                        if let Err(error) = incoming.retry() {
                            let incoming = error.into_incoming();
                            warn!(
                                event = "edge_address_retry_failed_closed",
                                remote = %remote,
                                "QUIC Retry unexpectedly unavailable; refusing connection"
                            );
                            incoming.refuse();
                        }
                        continue;
                    }
                    AdmissionAction::Accept => {}
                }

                let registry = Arc::clone(&registry);
                let replay_store = Arc::clone(&replay_store);
                let verifying_key = Arc::clone(&verifying_key);
                let edge_id = Arc::clone(&edge_id);
                tokio::spawn(async move {
                    match incoming.await {
                        Ok(connection) => {
                            if let Err(error) = handle_connection(
                                connection,
                                registry,
                                replay_store,
                                verifying_key,
                                edge_id,
                            ).await {
                                warn!(event = "edge_connection_rejected", error = %error, "QUIC connection rejected");
                            }
                        }
                        Err(error) => warn!(event = "edge_handshake_failed", error = %error, "QUIC handshake failed"),
                    }
                });
            }
            signal = tokio::signal::ctrl_c() => {
                if let Err(error) = signal {
                    error!(event = "edge_signal_error", error = %error, "failed to receive shutdown signal");
                }
                info!(event = "edge_draining", "GPUbnb Edge stopping new connections");
                endpoint.close(0_u8.into(), b"edge shutdown");
                endpoint.wait_idle().await;
                break;
            }
        }
    }

    Ok(())
}
