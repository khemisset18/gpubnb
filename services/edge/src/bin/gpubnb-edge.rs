#![forbid(unsafe_code)]

#[path = "../authority.rs"]
mod authority;
#[path = "../replay.rs"]
mod replay;
#[path = "../router.rs"]
mod router;
#[path = "../transport.rs"]
mod transport;
#[path = "../wire.rs"]
mod wire;

use std::{
    env,
    fs::File,
    io::BufReader,
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use authority::{
    parse_verifying_key_hex, validate_edge_id, verify_authority, AuthorityRole, VerifiedAuthority,
};
use ed25519_dalek::VerifyingKey;
use gpubnb_edge_core::{EdgeError, EdgeRegistry, Limits, SessionBinding, StreamKind, ALPN};
use quinn::{crypto::rustls::QuicServerConfig, Endpoint};
use replay::{ReplayError, ReplayStore};
use router::WorkspaceRouter;
use tokio::sync::Mutex;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use transport::{
    admission_action, configure_transport, AdmissionAction, RuntimeTransportPolicy,
    CONNECTION_RECEIVE_WINDOW_BYTES, CONNECTION_SEND_WINDOW_BYTES, MAX_BIDI_STREAMS,
    MAX_UNI_STREAMS, STREAM_RECEIVE_WINDOW_BYTES,
};
use wire::{
    read_json_frame, write_json_frame, OpenStreamFrame, StreamRejectCode, StreamStatusFrame,
    STREAM_METADATA_MAX_BYTES, STREAM_STATUS_MAX_BYTES,
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

async fn authenticate_connection(
    connection: &quinn::Connection,
    replay_store: &Arc<Mutex<ReplayStore>>,
    verifying_key: &VerifyingKey,
    edge_id: &str,
) -> Result<(VerifiedAuthority, quinn::SendStream)> {
    let (send, mut recv) = connection
        .accept_bi()
        .await
        .context("connection closed before authority stream")?;
    let raw = recv
        .read_to_end(AUTHORITY_MAX_BYTES)
        .await
        .context("failed to read authority stream")?;
    let authenticated_at_ms = now_ms()?;
    let verified = verify_authority(&raw, verifying_key, edge_id, authenticated_at_ms)?;
    {
        let mut guard = replay_store.lock().await;
        match guard.consume(&verified.binding, authenticated_at_ms) {
            Ok(()) => {}
            Err(ReplayError::AlreadyConsumed) => {
                warn!(
                    event = "edge_authority_replay_rejected",
                    remote = %connection.remote_address(),
                    "replayed data-plane authority rejected"
                );
                bail!("data-plane authority already consumed");
            }
            Err(ReplayError::Capacity) => {
                warn!(
                    event = "edge_replay_store_saturated",
                    remote = %connection.remote_address(),
                    "authority replay store capacity exhausted"
                );
                bail!("authority replay store capacity exhausted");
            }
            Err(ReplayError::Persistence) => {
                error!(
                    event = "edge_replay_store_persistence_failure",
                    remote = %connection.remote_address(),
                    "authority rejected because replay state could not be durably committed"
                );
                bail!("authority replay state persistence failed");
            }
        }
    }
    Ok((verified, send))
}

fn connection_lease_binding(
    binding: &SessionBinding,
    authenticated_at_ms: u64,
    max_session_lifetime_ms: u64,
) -> Result<SessionBinding> {
    let expires_at_ms = authenticated_at_ms
        .checked_add(max_session_lifetime_ms)
        .context("authenticated session lease expiry overflow")?;
    let mut lease = binding.clone();
    lease.issued_at_ms = authenticated_at_ms;
    lease.expires_at_ms = expires_at_ms;
    Ok(lease)
}

fn edge_reject_code(error: &EdgeError) -> StreamRejectCode {
    match error {
        EdgeError::StreamCapacity => StreamRejectCode::StreamLimit,
        EdgeError::InvalidTargetPort | EdgeError::ForbiddenTargetPort => {
            StreamRejectCode::InvalidTarget
        }
        EdgeError::SessionNotCurrent | EdgeError::InvalidLifetime => {
            StreamRejectCode::SessionExpired
        }
        EdgeError::UnknownSession | EdgeError::NotAcceptingSessions => {
            StreamRejectCode::HostUnavailable
        }
        _ => StreamRejectCode::InternalError,
    }
}

async fn reject_renter_stream(
    send: &mut quinn::SendStream,
    stream_id: u32,
    code: StreamRejectCode,
) -> Result<()> {
    write_json_frame(
        send,
        &StreamStatusFrame::rejected(stream_id, code),
        STREAM_STATUS_MAX_BYTES,
    )
    .await?;
    send.finish()
        .context("failed to finish rejected renter stream")?;
    Ok(())
}

async fn route_renter_stream(
    mut renter_send: quinn::SendStream,
    mut renter_recv: quinn::RecvStream,
    renter_binding: SessionBinding,
    router: Arc<Mutex<WorkspaceRouter>>,
    registry: Arc<Mutex<EdgeRegistry>>,
) -> Result<()> {
    let frame: OpenStreamFrame =
        read_json_frame(&mut renter_recv, STREAM_METADATA_MAX_BYTES).await?;
    let stream_id = frame.stream_id;
    let kind = match frame.validate() {
        Ok(kind) => kind,
        Err(error) => {
            reject_renter_stream(&mut renter_send, stream_id, StreamRejectCode::InvalidTarget)
                .await?;
            return Err(error);
        }
    };
    if kind == StreamKind::Control {
        reject_renter_stream(
            &mut renter_send,
            stream_id,
            StreamRejectCode::UnsupportedKind,
        )
        .await?;
        return Ok(());
    }
    if frame
        .resume_from_sequence
        .is_some_and(|sequence| sequence != 0)
    {
        reject_renter_stream(
            &mut renter_send,
            stream_id,
            StreamRejectCode::ResumeWindowExpired,
        )
        .await?;
        return Ok(());
    }

    let host = {
        let guard = router.lock().await;
        match guard.host_for(&renter_binding) {
            Ok(host) => host,
            Err(error) => {
                reject_renter_stream(
                    &mut renter_send,
                    stream_id,
                    StreamRejectCode::HostUnavailable,
                )
                .await?;
                return Err(error);
            }
        }
    };

    let opened_at_ms = now_ms()?;
    let became_interactive = {
        let mut guard = registry.lock().await;
        let was_interactive = guard
            .interactive_ready(&renter_binding.session_id)
            .unwrap_or(false);
        if let Err(error) = guard.open_stream(
            &renter_binding.session_id,
            stream_id,
            kind,
            frame.target_port,
            opened_at_ms,
        ) {
            let code = edge_reject_code(&error);
            drop(guard);
            reject_renter_stream(&mut renter_send, stream_id, code).await?;
            return Err(anyhow!("Edge stream registry rejected route: {error:?}"));
        }
        !was_interactive
            && guard
                .interactive_ready(&renter_binding.session_id)
                .unwrap_or(false)
    };

    if became_interactive {
        info!(
            event = "edge_session_interactive_ready",
            session = %renter_binding.session_id,
            "Management and ExtensionHost streams are both healthy"
        );
    }

    let route_result = async {
        let (mut host_send, mut host_recv) = host
            .connection
            .open_bi()
            .await
            .context("Host tunnel unavailable while opening routed stream")?;
        write_json_frame(&mut host_send, &frame, STREAM_METADATA_MAX_BYTES).await?;
        let status: StreamStatusFrame =
            read_json_frame(&mut host_recv, STREAM_STATUS_MAX_BYTES).await?;
        status.validate_for(stream_id)?;
        write_json_frame(&mut renter_send, &status, STREAM_STATUS_MAX_BYTES).await?;
        if !status.is_accepted() {
            renter_send
                .finish()
                .context("failed to finish Host-rejected renter stream")?;
            return Ok((0_u64, 0_u64));
        }

        let renter_to_host = async {
            let bytes = tokio::io::copy(&mut renter_recv, &mut host_send)
                .await
                .context("renter-to-Host QUIC relay failed")?;
            host_send
                .finish()
                .context("failed to finish Host request stream")?;
            Result::<u64>::Ok(bytes)
        };
        let host_to_renter = async {
            let bytes = tokio::io::copy(&mut host_recv, &mut renter_send)
                .await
                .context("Host-to-renter QUIC relay failed")?;
            renter_send
                .finish()
                .context("failed to finish renter response stream")?;
            Result::<u64>::Ok(bytes)
        };
        tokio::try_join!(renter_to_host, host_to_renter)
    }
    .await;

    let became_noninteractive = {
        let mut guard = registry.lock().await;
        let was_interactive = guard
            .interactive_ready(&renter_binding.session_id)
            .unwrap_or(false);
        let _ = guard.close_stream(&renter_binding.session_id, stream_id);
        was_interactive
            && !guard
                .interactive_ready(&renter_binding.session_id)
                .unwrap_or(false)
    };
    if became_noninteractive {
        warn!(
            event = "edge_session_interactive_degraded",
            session = %renter_binding.session_id,
            "Management or ExtensionHost stream closed"
        );
    }

    let (bytes_up, bytes_down) = route_result?;
    info!(
        event = "edge_stream_closed",
        session = %renter_binding.session_id,
        stream_id,
        kind = ?kind,
        bytes_up,
        bytes_down,
        "routed data-plane stream completed"
    );
    Ok(())
}

async fn handle_host_connection(
    connection: quinn::Connection,
    binding: SessionBinding,
    mut auth_send: quinn::SendStream,
    router: Arc<Mutex<WorkspaceRouter>>,
    registry: Arc<Mutex<EdgeRegistry>>,
    max_session_lifetime_ms: u64,
    edge_id: Arc<String>,
) -> Result<()> {
    let session_id = binding.session_id.clone();
    let authenticated_at_ms = now_ms()?;
    let lease_binding =
        connection_lease_binding(&binding, authenticated_at_ms, max_session_lifetime_ms)?;

    let (lease_id, previous_connection) = {
        let mut router_guard = router.lock().await;
        let mut registry_guard = registry.lock().await;
        let (lease_id, previous_connection) =
            router_guard.register_host(binding.clone(), connection.clone());
        if previous_connection.is_some() {
            let _ = registry_guard.remove_session(&session_id);
        }
        if let Err(error) = registry_guard.register_session(lease_binding, authenticated_at_ms) {
            router_guard.remove_host(&session_id, lease_id);
            bail!("Host session registration rejected: {error:?}");
        }
        (lease_id, previous_connection)
    };
    if let Some(previous) = previous_connection {
        warn!(
            event = "edge_host_tunnel_replaced",
            session = %session_id,
            "fresh authenticated Host tunnel replaced previous connection"
        );
        previous.close(1_u8.into(), b"Host tunnel superseded");
    }

    if let Err(error) =
        write_control_response(&mut auth_send, br#"{"ok":true,"protocol":"gpubnb-dp/1"}"#).await
    {
        let mut router_guard = router.lock().await;
        let mut registry_guard = registry.lock().await;
        if router_guard.remove_host(&session_id, lease_id) {
            let _ = registry_guard.remove_session(&session_id);
        }
        return Err(error);
    }

    info!(
        event = "edge_host_tunnel_ready",
        remote = %connection.remote_address(),
        edge = %edge_id,
        session = %session_id,
        "authenticated outbound Host tunnel registered"
    );
    let close = connection.closed().await;
    let removed = {
        let mut router_guard = router.lock().await;
        let mut registry_guard = registry.lock().await;
        let removed = router_guard.remove_host(&session_id, lease_id);
        if removed {
            let _ = registry_guard.remove_session(&session_id);
        }
        removed
    };
    if removed {
        warn!(
            event = "edge_host_tunnel_closed",
            edge = %edge_id,
            session = %session_id,
            reason = ?close,
            "Host tunnel disconnected and route was removed"
        );
    }
    Ok(())
}

async fn handle_renter_connection(
    connection: quinn::Connection,
    binding: SessionBinding,
    mut auth_send: quinn::SendStream,
    router: Arc<Mutex<WorkspaceRouter>>,
    registry: Arc<Mutex<EdgeRegistry>>,
    edge_id: Arc<String>,
) -> Result<()> {
    write_control_response(&mut auth_send, br#"{"ok":true,"protocol":"gpubnb-dp/1"}"#).await?;
    info!(
        event = "edge_session_authenticated",
        remote = %connection.remote_address(),
        edge = %edge_id,
        session = %binding.session_id,
        role = "RENTER",
        "authenticated renter data-plane connection"
    );

    loop {
        match connection.accept_bi().await {
            Ok((send, recv)) => {
                let binding = binding.clone();
                let router = Arc::clone(&router);
                let registry = Arc::clone(&registry);
                tokio::spawn(async move {
                    if let Err(error) =
                        route_renter_stream(send, recv, binding, router, registry).await
                    {
                        warn!(event = "edge_routed_stream_failed", error = %error, "routed renter stream failed");
                    }
                });
            }
            Err(error) => {
                info!(
                    event = "edge_session_closed",
                    remote = %connection.remote_address(),
                    edge = %edge_id,
                    session = %binding.session_id,
                    reason = ?error,
                    "renter data-plane connection closed"
                );
                break;
            }
        }
    }
    Ok(())
}

async fn handle_connection(
    connection: quinn::Connection,
    registry: Arc<Mutex<EdgeRegistry>>,
    router: Arc<Mutex<WorkspaceRouter>>,
    replay_store: Arc<Mutex<ReplayStore>>,
    verifying_key: Arc<VerifyingKey>,
    edge_id: Arc<String>,
    max_session_lifetime_ms: u64,
) -> Result<()> {
    let (verified, auth_send) =
        authenticate_connection(&connection, &replay_store, &verifying_key, edge_id.as_str())
            .await?;
    match verified.role {
        AuthorityRole::Host => {
            handle_host_connection(
                connection,
                verified.binding,
                auth_send,
                router,
                registry,
                max_session_lifetime_ms,
                edge_id,
            )
            .await
        }
        AuthorityRole::Renter => {
            handle_renter_connection(
                connection,
                verified.binding,
                auth_send,
                router,
                registry,
                edge_id,
            )
            .await
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
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
    let limits = Limits::default();
    let max_session_lifetime_ms = limits.max_session_lifetime_ms;
    let registry = Arc::new(Mutex::new(EdgeRegistry::new(limits)));
    let router = Arc::new(Mutex::new(WorkspaceRouter::default()));
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
                let router = Arc::clone(&router);
                let replay_store = Arc::clone(&replay_store);
                let verifying_key = Arc::clone(&verifying_key);
                let edge_id = Arc::clone(&edge_id);
                tokio::spawn(async move {
                    match incoming.await {
                        Ok(connection) => {
                            if let Err(error) = handle_connection(
                                connection,
                                registry,
                                router,
                                replay_store,
                                verifying_key,
                                edge_id,
                                max_session_lifetime_ms,
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
