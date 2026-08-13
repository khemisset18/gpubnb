#![forbid(unsafe_code)]

#[path = "../wire.rs"]
mod wire;

use std::{
    collections::HashSet,
    env,
    fs::File,
    io::BufReader,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use gpubnb_edge_core::{StreamKind, ALPN};
use quinn::{crypto::rustls::QuicClientConfig, ClientConfig, Endpoint, TransportConfig};
use serde::Deserialize;
use tokio::{io::AsyncWriteExt, net::TcpStream};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use wire::{
    read_json_frame, write_json_frame, OpenStreamFrame, StreamRejectCode, StreamStatusFrame,
    STREAM_METADATA_MAX_BYTES, STREAM_STATUS_MAX_BYTES,
};

const AUTHORITY_MAX_BYTES: usize = 16 * 1024;
const AUTH_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const TARGET_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HOST_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const HOST_APPLICATION_BIDI_STREAMS: u32 = 64;
const HOST_STREAM_CREDIT_REPLENISHMENT_RESERVE: u32 = 10;
const HOST_MAX_INCOMING_BIDI_STREAMS: u32 =
    HOST_APPLICATION_BIDI_STREAMS + HOST_STREAM_CREDIT_REPLENISHMENT_RESERVE;

// Quinn batches MAX_STREAMS updates until more than one eighth of the current
// remote-stream window has been freed. Keep enough bounded transport-only
// credit for stream churn while the Host still enforces loopback target policy
// and the Edge keeps the application session limit at 64.
const _: () =
    assert!(HOST_STREAM_CREDIT_REPLENISHMENT_RESERVE > HOST_MAX_INCOMING_BIDI_STREAMS / 8);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthResponse {
    ok: bool,
    protocol: String,
}

#[derive(Debug, Deserialize)]
struct AuthorityRoleProbe {
    role: String,
}

#[derive(Clone, Debug)]
struct TargetPolicy {
    workspace_port: u16,
    jupyter_port: Option<u16>,
    allowed_app_ports: Arc<HashSet<u16>>,
}

impl TargetPolicy {
    fn from_env() -> Result<Self> {
        let workspace_port = parse_port(
            "GPUBNB_HOST_WORKSPACE_PORT",
            &required_env("GPUBNB_HOST_WORKSPACE_PORT")?,
        )?;
        let jupyter_port = match env::var("GPUBNB_HOST_JUPYTER_PORT") {
            Ok(raw) if !raw.trim().is_empty() => {
                Some(parse_port("GPUBNB_HOST_JUPYTER_PORT", &raw)?)
            }
            Ok(_) | Err(env::VarError::NotPresent) => None,
            Err(error) => return Err(anyhow!("failed to read GPUBNB_HOST_JUPYTER_PORT: {error}")),
        };
        let allowed_app_ports = match env::var("GPUBNB_HOST_ALLOWED_APP_PORTS") {
            Ok(raw) => parse_port_set(&raw)?,
            Err(env::VarError::NotPresent) => HashSet::new(),
            Err(error) => {
                return Err(anyhow!(
                    "failed to read GPUBNB_HOST_ALLOWED_APP_PORTS: {error}"
                ))
            }
        };
        Ok(Self {
            workspace_port,
            jupyter_port,
            allowed_app_ports: Arc::new(allowed_app_ports),
        })
    }

    fn target_for(
        &self,
        frame: &OpenStreamFrame,
        kind: StreamKind,
    ) -> Result<SocketAddr, StreamRejectCode> {
        let port = match kind {
            StreamKind::VsCodeManagement
            | StreamKind::VsCodeExtensionHost
            | StreamKind::Terminal
            | StreamKind::FileTransfer => self.workspace_port,
            StreamKind::Jupyter => self
                .jupyter_port
                .ok_or(StreamRejectCode::TargetUnavailable)?,
            StreamKind::AppPort => {
                let port = frame.target_port.ok_or(StreamRejectCode::InvalidTarget)?;
                if !self.allowed_app_ports.contains(&port) {
                    return Err(StreamRejectCode::InvalidTarget);
                }
                port
            }
            StreamKind::Control => return Err(StreamRejectCode::UnsupportedKind),
        };
        Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
    }
}

fn required_env(name: &str) -> Result<String> {
    let value =
        env::var(name).with_context(|| format!("missing required environment variable {name}"))?;
    if value.trim().is_empty() {
        bail!("required environment variable {name} is empty");
    }
    Ok(value)
}

fn parse_port(name: &str, raw: &str) -> Result<u16> {
    let port = raw
        .trim()
        .parse::<u16>()
        .with_context(|| format!("{name} must be a TCP port"))?;
    if port == 0 {
        bail!("{name} must be between 1 and 65535");
    }
    Ok(port)
}

fn parse_port_set(raw: &str) -> Result<HashSet<u16>> {
    let mut ports = HashSet::new();
    if raw.trim().is_empty() {
        return Ok(ports);
    }
    for item in raw.split(',') {
        ports.insert(parse_port("GPUBNB_HOST_ALLOWED_APP_PORTS", item)?);
    }
    if ports.len() > 64 {
        bail!("GPUBNB_HOST_ALLOWED_APP_PORTS may contain at most 64 unique ports");
    }
    Ok(ports)
}

fn load_client_config(ca_cert_path: &str) -> Result<ClientConfig> {
    let mut reader = BufReader::new(
        File::open(ca_cert_path)
            .with_context(|| format!("failed to open Edge CA certificate {ca_cert_path}"))?,
    );
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .context("failed to parse Edge CA certificate")?;
    if certs.is_empty() {
        bail!("Edge CA certificate file is empty");
    }
    let mut roots = rustls::RootCertStore::empty();
    for cert in certs {
        roots.add(cert).context("failed to add Edge CA root")?;
    }
    let mut tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.as_bytes().to_vec()];
    tls.enable_early_data = false;
    let quic =
        QuicClientConfig::try_from(tls).context("Host TLS configuration is not QUIC-compatible")?;
    let mut client = ClientConfig::new(Arc::new(quic));
    let mut transport = TransportConfig::default();
    transport
        .max_concurrent_bidi_streams(HOST_MAX_INCOMING_BIDI_STREAMS.into())
        .max_concurrent_uni_streams(0_u8.into())
        .keep_alive_interval(Some(HOST_KEEPALIVE_INTERVAL));
    client.transport_config(Arc::new(transport));
    Ok(client)
}

fn load_host_authority(path: &str) -> Result<Vec<u8>> {
    let raw =
        std::fs::read(path).with_context(|| format!("failed to read Host authority {path}"))?;
    if raw.is_empty() || raw.len() > AUTHORITY_MAX_BYTES {
        bail!("Host authority file size invalid");
    }
    let probe: AuthorityRoleProbe =
        serde_json::from_slice(&raw).context("invalid Host authority JSON")?;
    if probe.role != "HOST" {
        bail!("Host tunnel refuses a non-HOST authority");
    }
    Ok(raw)
}

async fn authenticate_host(connection: &quinn::Connection, authority: &[u8]) -> Result<()> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .context("failed to open Host authority stream")?;
    send.write_all(authority)
        .await
        .context("failed to write Host authority")?;
    send.finish()
        .context("failed to finish Host authority stream")?;
    let raw = recv
        .read_to_end(AUTH_RESPONSE_MAX_BYTES)
        .await
        .context("failed to read Edge Host authentication response")?;
    let response: AuthResponse =
        serde_json::from_slice(&raw).context("invalid Edge authentication response")?;
    if !response.ok || response.protocol != ALPN {
        bail!("Edge rejected Host data-plane authentication");
    }
    Ok(())
}

async fn reject_stream(
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
        .context("failed to finish rejected Host stream")?;
    Ok(())
}

async fn handle_routed_stream(
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    policy: TargetPolicy,
) -> Result<()> {
    let frame: OpenStreamFrame = match read_json_frame(&mut recv, STREAM_METADATA_MAX_BYTES).await {
        Ok(frame) => frame,
        Err(error) => {
            warn!(event = "host_stream_metadata_rejected", error = %error, "invalid routed stream metadata");
            return Err(error);
        }
    };
    let stream_id = frame.stream_id;
    let kind = match frame.validate() {
        Ok(kind) => kind,
        Err(error) => {
            reject_stream(&mut send, stream_id, StreamRejectCode::InvalidTarget).await?;
            return Err(error);
        }
    };
    if frame
        .resume_from_sequence
        .is_some_and(|sequence| sequence != 0)
    {
        reject_stream(&mut send, stream_id, StreamRejectCode::ResumeWindowExpired).await?;
        return Ok(());
    }
    let target = match policy.target_for(&frame, kind) {
        Ok(target) => target,
        Err(code) => {
            reject_stream(&mut send, stream_id, code).await?;
            return Ok(());
        }
    };

    let tcp = match tokio::time::timeout(TARGET_CONNECT_TIMEOUT, TcpStream::connect(target)).await {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(error)) => {
            warn!(event = "host_target_connect_failed", stream_id, target_port = target.port(), error = %error, "workspace loopback target unavailable");
            reject_stream(&mut send, stream_id, StreamRejectCode::TargetUnavailable).await?;
            return Ok(());
        }
        Err(_) => {
            warn!(
                event = "host_target_connect_timeout",
                stream_id,
                target_port = target.port(),
                "workspace loopback target connect timed out"
            );
            reject_stream(&mut send, stream_id, StreamRejectCode::TargetUnavailable).await?;
            return Ok(());
        }
    };
    tcp.set_nodelay(true)
        .context("failed to configure workspace target TCP_NODELAY")?;
    write_json_frame(
        &mut send,
        &StreamStatusFrame::accepted(stream_id),
        STREAM_STATUS_MAX_BYTES,
    )
    .await?;

    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let upstream = async {
        let bytes = tokio::io::copy(&mut recv, &mut tcp_write)
            .await
            .context("renter-to-workspace relay failed")?;
        tcp_write
            .shutdown()
            .await
            .context("workspace target write shutdown failed")?;
        Result::<u64>::Ok(bytes)
    };
    let downstream = async {
        let bytes = tokio::io::copy(&mut tcp_read, &mut send)
            .await
            .context("workspace-to-renter relay failed")?;
        send.finish()
            .context("failed to finish renter response stream")?;
        Result::<u64>::Ok(bytes)
    };
    let (bytes_up, bytes_down) = tokio::try_join!(upstream, downstream)?;
    info!(
        event = "host_stream_closed",
        stream_id,
        kind = ?kind,
        target_port = target.port(),
        bytes_up,
        bytes_down,
        "workspace routed stream completed"
    );
    Ok(())
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

    let edge_addr: SocketAddr = required_env("GPUBNB_HOST_EDGE_ADDR")?
        .parse()
        .context("GPUBNB_HOST_EDGE_ADDR must be a socket address")?;
    let server_name = required_env("GPUBNB_HOST_EDGE_SERVER_NAME")?;
    let ca_cert = required_env("GPUBNB_HOST_EDGE_CA_CERT")?;
    let authority_path = required_env("GPUBNB_HOST_AUTHORITY")?;
    let policy = TargetPolicy::from_env()?;
    let authority = load_host_authority(&authority_path)?;

    let mut endpoint =
        Endpoint::client("0.0.0.0:0".parse()?).context("failed to create Host QUIC endpoint")?;
    endpoint.set_default_client_config(load_client_config(&ca_cert)?);
    let connection = endpoint
        .connect(edge_addr, &server_name)
        .context("invalid Edge address/server name")?
        .await
        .context("Host QUIC/TLS connection failed")?;
    authenticate_host(&connection, &authority).await?;
    info!(
        event = "host_tunnel_ready",
        edge = %edge_addr,
        workspace_port = policy.workspace_port,
        max_incoming_bidi_streams = HOST_MAX_INCOMING_BIDI_STREAMS,
        application_bidi_streams = HOST_APPLICATION_BIDI_STREAMS,
        stream_credit_replenishment_reserve = HOST_STREAM_CREDIT_REPLENISHMENT_RESERVE,
        "outbound Host QUIC tunnel authenticated"
    );

    loop {
        tokio::select! {
            stream = connection.accept_bi() => {
                let (send, recv) = match stream {
                    Ok(stream) => stream,
                    Err(error) => {
                        if connection.close_reason().is_some() {
                            break;
                        }
                        warn!(event = "host_stream_accept_failed", error = %error, "failed to accept routed Edge stream");
                        continue;
                    }
                };
                let policy = policy.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_routed_stream(send, recv, policy).await {
                        warn!(event = "host_stream_failed", error = %error, "workspace routed stream failed");
                    }
                });
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to receive Host tunnel shutdown signal")?;
                connection.close(0_u8.into(), b"Host tunnel shutdown");
                break;
            }
        }
    }

    endpoint.wait_idle().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_port_allowlist_is_explicit_and_bounded() {
        let ports = parse_port_set("3000,8888,3000").unwrap();
        assert_eq!(ports.len(), 2);
        assert!(ports.contains(&3000));
        assert!(ports.contains(&8888));
        assert!(parse_port_set("0").is_err());
    }
}
