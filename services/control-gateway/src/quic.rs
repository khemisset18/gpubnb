use std::{
    fs::File,
    io::BufReader,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use quinn::crypto::rustls::QuicServerConfig;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{info, warn};

use crate::{
    config::GatewayConfig,
    metrics::GatewayMetrics,
    protocol::{AgentMessage, FenceReason, GatewayMessage, ServerHello},
    registry::{AckOutcome, GatewayRegistry},
    store::{CommandAckRecord, RedisStore, TouchOutcome},
    wire::{read_json_frame, write_json_frame},
    CONTROL_GATEWAY_ALPN, CONTROL_GATEWAY_PROTOCOL_VERSION,
};

const HELLO_MAX_BYTES: usize = 16 * 1024;
const AUTH_TIMEOUT_SECONDS: u64 = 10;
const QUIC_KEEPALIVE_SECONDS: u64 = 10;
const QUIC_IDLE_TIMEOUT_SECONDS: u64 = 90;

#[derive(Clone)]
pub struct QuicState {
    pub config: Arc<GatewayConfig>,
    pub registry: Arc<Mutex<GatewayRegistry>>,
    pub store: RedisStore,
    pub metrics: Arc<GatewayMetrics>,
}

pub async fn run(state: QuicState, mut shutdown: watch::Receiver<bool>) -> Result<()> {
    let server_config = load_server_config(&state.config)?;
    let endpoint = quinn::Endpoint::server(server_config, state.config.quic_bind)
        .context("failed to bind regional control-gateway QUIC endpoint")?;
    info!(
        event = "control_gateway_quic_ready",
        gateway = %state.config.gateway_id,
        region = %state.config.region,
        bind = %endpoint.local_addr()?,
        alpn = CONTROL_GATEWAY_ALPN,
        max_connections = state.config.max_connections,
        "regional control-gateway QUIC listener ready"
    );

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    state.registry.lock().await.set_draining(true);
                    info!(event = "control_gateway_draining", gateway = %state.config.gateway_id, "control gateway draining");
                    endpoint.close(0_u8.into(), b"gateway draining");
                    endpoint.wait_idle().await;
                    return Ok(());
                }
            }
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { return Ok(()); };
                let open_connections = endpoint.open_connections();
                if open_connections >= state.config.max_connections {
                    warn!(
                        event = "control_gateway_connection_refused_capacity",
                        remote = %incoming.remote_address(),
                        open_connections,
                        max_connections = state.config.max_connections,
                        "control gateway refused QUIC connection at capacity"
                    );
                    incoming.refuse();
                    continue;
                }
                let retry_threshold = state.config.max_connections.saturating_mul(8) / 10;
                if open_connections >= retry_threshold && !incoming.remote_address_validated() {
                    if let Err(error) = incoming.retry() {
                        let incoming = error.into_incoming();
                        incoming.refuse();
                    }
                    continue;
                }

                let connection_state = state.clone();
                tokio::spawn(async move {
                    match incoming.await {
                        Ok(connection) => {
                            if let Err(error) = handle_connection(connection, connection_state.clone()).await {
                                warn!(
                                    event = "control_gateway_connection_closed",
                                    error = %error,
                                    "regional control connection ended"
                                );
                            }
                        }
                        Err(error) => warn!(event = "control_gateway_handshake_failed", error = %error, "QUIC handshake failed"),
                    }
                });
            }
        }
    }
}

async fn handle_connection(connection: quinn::Connection, state: QuicState) -> Result<()> {
    let remote = connection.remote_address();
    let auth_stream = tokio::time::timeout(
        Duration::from_secs(AUTH_TIMEOUT_SECONDS),
        connection.accept_bi(),
    )
    .await
    .context("control connection authentication stream timed out")?
    .context("connection closed before authentication stream")?;
    let (mut send, mut recv) = auth_stream;

    let hello: crate::protocol::ClientHello = read_json_frame(&mut recv, HELLO_MAX_BYTES)
        .await
        .context("failed to read client hello")?;
    let authenticated_at_ms = now_ms()?;
    if let Err(error) = hello.validate(
        authenticated_at_ms,
        state.config.auth_clock_skew_seconds.saturating_mul(1000),
    ) {
        state.metrics.rejected_auth();
        bail!("client hello rejected: {error}");
    }
    let verifying_key = match state
        .store
        .resolve_machine_key(&hello.machine_id, hello.key_version)
        .await
    {
        Ok(key) => key,
        Err(error) => {
            state.metrics.rejected_auth();
            state.metrics.redis_error();
            return Err(error).context("machine authentication cache lookup failed");
        }
    };
    if let Err(error) = hello.verify(&verifying_key) {
        state.metrics.rejected_auth();
        return Err(error).context("machine authentication failed");
    }

    let presence = state
        .store
        .claim_presence(
            &hello.machine_id,
            &state.config.gateway_id,
            &state.config.region,
            authenticated_at_ms,
            state.config.presence_ttl_seconds,
        )
        .await
        .context("failed to claim machine presence")?;
    let connection_id = presence.connection_id;
    let machine_id = hello.machine_id.clone();
    let (outbound_tx, mut outbound_rx) = mpsc::channel(state.config.per_connection_queue);

    let registration = {
        let mut registry = state.registry.lock().await;
        registry.register(
            &machine_id,
            connection_id.clone(),
            outbound_tx,
            hello.last_acked_command_sequence,
            authenticated_at_ms,
        )
    };
    let registration = match registration {
        Ok(value) => value,
        Err(error) => {
            let _ = state
                .store
                .release_presence(&machine_id, &connection_id)
                .await;
            return Err(error).context("gateway registry rejected authenticated connection");
        }
    };

    if let Some(replaced_sender) = registration.replaced_sender {
        let _ = replaced_sender.try_send(GatewayMessage::Fence {
            reason: FenceReason::ReplacedConnection,
        });
        state.metrics.fenced_connection();
    }

    write_json_frame(
        &mut send,
        &GatewayMessage::ServerHello {
            hello: ServerHello {
                protocol_version: CONTROL_GATEWAY_PROTOCOL_VERSION,
                gateway_id: state.config.gateway_id.clone(),
                region: state.config.region.clone(),
                connection_id: connection_id.clone(),
                presence_ttl_seconds: state.config.presence_ttl_seconds,
                heartbeat_timeout_seconds: state.config.heartbeat_timeout_seconds,
                resumed_after_command_sequence: hello.last_acked_command_sequence,
            },
        },
        state.config.max_control_frame_bytes,
    )
    .await?;

    for command in registration.replay {
        write_json_frame(
            &mut send,
            &GatewayMessage::Command { command },
            state.config.max_control_frame_bytes,
        )
        .await
        .context("failed to replay pending command after reconnect")?;
    }

    state.metrics.accepted_connection();
    info!(
        event = "control_gateway_machine_authenticated",
        machine = %machine_id,
        connection = %connection_id,
        gateway = %state.config.gateway_id,
        region = %state.config.region,
        remote = %remote,
        resumed_after = hello.last_acked_command_sequence,
        "machine authenticated to regional control gateway"
    );

    let session_result = run_authenticated_session(
        &connection,
        &state,
        &machine_id,
        &connection_id,
        &mut send,
        &mut recv,
        &mut outbound_rx,
    )
    .await;

    let removed = state
        .registry
        .lock()
        .await
        .unregister(&machine_id, &connection_id);
    match state
        .store
        .release_presence(&machine_id, &connection_id)
        .await
    {
        Ok(_) => {}
        Err(error) => {
            state.metrics.redis_error();
            warn!(event = "control_gateway_presence_release_failed", machine = %machine_id, error = %error, "presence release failed");
        }
    }
    if removed {
        info!(
            event = "control_gateway_machine_disconnected",
            machine = %machine_id,
            connection = %connection_id,
            "machine disconnected from regional control gateway"
        );
    }
    connection.close(0_u8.into(), b"control session closed");
    session_result
}

async fn run_authenticated_session(
    _connection: &quinn::Connection,
    state: &QuicState,
    machine_id: &str,
    connection_id: &str,
    send: &mut quinn::SendStream,
    recv: &mut quinn::RecvStream,
    outbound_rx: &mut mpsc::Receiver<GatewayMessage>,
) -> Result<()> {
    let heartbeat_timeout = Duration::from_secs(state.config.heartbeat_timeout_seconds);
    let deadline = tokio::time::sleep(heartbeat_timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            outbound = outbound_rx.recv() => {
                let Some(outbound) = outbound else { bail!("connection outbound queue closed"); };
                let terminal_fence = matches!(outbound, GatewayMessage::Fence { .. });
                write_json_frame(send, &outbound, state.config.max_control_frame_bytes)
                    .await
                    .context("failed to write gateway control frame")?;
                if terminal_fence {
                    bail!("connection fenced by gateway");
                }
            }
            inbound = read_json_frame::<AgentMessage>(recv, state.config.max_control_frame_bytes) => {
                let inbound = inbound.context("failed to read agent control frame")?;
                let received_at_ms = now_ms()?;
                inbound.validate(received_at_ms)?;
                match inbound {
                    AgentMessage::Heartbeat { sequence, .. } => {
                        match state.store.touch_presence(
                            machine_id,
                            connection_id,
                            sequence,
                            received_at_ms,
                            state.config.presence_ttl_seconds,
                        ).await {
                            Ok(TouchOutcome::Accepted { .. }) => {
                                state.metrics.heartbeat_accepted();
                                deadline.as_mut().reset(tokio::time::Instant::now() + heartbeat_timeout);
                            }
                            Ok(TouchOutcome::Rejected { reason, .. }) => {
                                state.metrics.heartbeat_rejected();
                                let fence = GatewayMessage::Fence { reason: FenceReason::PresenceOwnershipLost };
                                let _ = write_json_frame(send, &fence, state.config.max_control_frame_bytes).await;
                                bail!("presence heartbeat rejected: {reason}");
                            }
                            Err(error) => {
                                state.metrics.redis_error();
                                bail!("presence heartbeat store failure: {error}");
                            }
                        }
                    }
                    AgentMessage::CommandAck { command_id, sequence, status, detail_code } => {
                        state.store.record_command_ack(CommandAckRecord {
                            machine_id,
                            connection_id,
                            command_id: &command_id,
                            sequence,
                            status,
                            detail_code: detail_code.as_deref(),
                            acknowledged_at_ms: received_at_ms,
                        }).await.context("failed to durably record command ack")?;
                        let ack = state.registry.lock().await.acknowledge(
                            machine_id,
                            connection_id,
                            &command_id,
                            sequence,
                            status,
                        )?;
                        if matches!(ack, AckOutcome::Recorded | AckOutcome::TerminalRecorded | AckOutcome::DuplicateTerminal) {
                            state.metrics.command_ack();
                            write_json_frame(
                                send,
                                &GatewayMessage::AckReceipt { command_id, sequence },
                                state.config.max_control_frame_bytes,
                            ).await?;
                        }
                    }
                }
            }
            _ = &mut deadline => {
                bail!("heartbeat timeout");
            }
        }
    }
}

fn load_server_config(config: &GatewayConfig) -> Result<quinn::ServerConfig> {
    let mut cert_reader = BufReader::new(File::open(&config.tls_cert).with_context(|| {
        format!(
            "failed to open TLS certificate {}",
            config.tls_cert.display()
        )
    })?);
    let certs = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .context("failed to parse TLS certificate chain")?;
    if certs.is_empty() {
        bail!("TLS certificate chain is empty");
    }

    let mut key_reader = BufReader::new(File::open(&config.tls_key).with_context(|| {
        format!(
            "failed to open TLS private key {}",
            config.tls_key.display()
        )
    })?);
    let key = rustls_pemfile::private_key(&mut key_reader)
        .context("failed to parse TLS private key")?
        .ok_or_else(|| anyhow!("TLS private key file contains no supported private key"))?;

    let mut tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("TLS certificate/private key rejected")?;
    tls.alpn_protocols = vec![CONTROL_GATEWAY_ALPN.as_bytes().to_vec()];
    tls.max_early_data_size = 0;
    tls.send_half_rtt_data = false;

    let crypto =
        QuicServerConfig::try_from(tls).context("TLS configuration is not QUIC compatible")?;
    let mut server = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    let transport = Arc::get_mut(&mut server.transport)
        .ok_or_else(|| anyhow!("QUIC transport configuration unexpectedly shared"))?;
    transport.max_concurrent_bidi_streams(quinn::VarInt::from_u32(1));
    transport.max_concurrent_uni_streams(quinn::VarInt::from_u32(0));
    transport.keep_alive_interval(Some(Duration::from_secs(QUIC_KEEPALIVE_SECONDS)));
    transport.max_idle_timeout(Some(
        Duration::from_secs(QUIC_IDLE_TIMEOUT_SECONDS)
            .try_into()
            .context("invalid QUIC idle timeout")?,
    ));
    Ok(server)
}

fn now_ms() -> Result<u64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock before Unix epoch")?;
    u64::try_from(duration.as_millis()).context("system time does not fit u64 milliseconds")
}
