#[path = "../src/wire.rs"]
mod wire;

use std::{
    env,
    fs::File,
    io::{BufReader, Write},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use gpubnb_edge_core::ALPN;
use quinn::{crypto::rustls::QuicClientConfig, ClientConfig, ConnectionError, Endpoint};
use serde::Deserialize;
use wire::{
    read_json_frame, write_json_frame, OpenStreamFrame, StreamStatusFrame, WireStreamKind,
    STREAM_METADATA_MAX_BYTES, STREAM_STATUS_MAX_BYTES,
};

const CONTROL_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const ROUTED_RESPONSE_MAX_BYTES: usize = 4 * 1024 * 1024;
const PRESSURE_STREAMS: u32 = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlResponse {
    ok: bool,
    protocol: String,
}

fn client_config(ca_cert_path: &str) -> Result<ClientConfig> {
    let mut reader = BufReader::new(File::open(ca_cert_path).context("open test CA certificate")?);
    let certs = rustls_pemfile::certs(&mut reader).collect::<Result<Vec<_>, _>>()?;
    if certs.is_empty() {
        bail!("test CA certificate file is empty");
    }

    let mut roots = rustls::RootCertStore::empty();
    for cert in certs {
        roots.add(cert).context("add test CA root")?;
    }

    let mut tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.as_bytes().to_vec()];
    tls.enable_early_data = false;
    let quic = QuicClientConfig::try_from(tls).context("QUIC client TLS config")?;
    Ok(ClientConfig::new(Arc::new(quic)))
}

fn verify_success_response(response: &[u8]) -> Result<()> {
    let payload: ControlResponse =
        serde_json::from_slice(response).context("parse Edge control response JSON")?;
    if !payload.ok || payload.protocol != ALPN {
        bail!("unexpected Edge control response: {payload:?}");
    }
    Ok(())
}

async fn connect(endpoint: &Endpoint, addr: SocketAddr) -> Result<quinn::Connection> {
    endpoint
        .connect(addr, "localhost")?
        .await
        .context("QUIC/TLS connection failed")
}

async fn authenticate(connection: &quinn::Connection, authority: &[u8]) -> Result<()> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .context("open authority stream")?;
    send.write_all(authority)
        .await
        .context("write authority envelope")?;
    send.finish().context("finish authority stream")?;
    let response = recv
        .read_to_end(CONTROL_RESPONSE_MAX_BYTES)
        .await
        .context("read Edge control response")?;
    verify_success_response(&response)
}

async fn run_authority_case(
    endpoint: &Endpoint,
    addr: SocketAddr,
    authority: &[u8],
    expectation: &str,
) -> Result<()> {
    // Transport/TLS/ALPN must always succeed. A network or certificate failure
    // must never be accepted as proof that replay protection worked.
    let connection = connect(endpoint, addr).await?;
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .context("open authority stream")?;
    send.write_all(authority)
        .await
        .context("write authority envelope")?;
    send.finish().context("finish authority stream")?;

    let read_result = recv.read_to_end(CONTROL_RESPONSE_MAX_BYTES).await;
    match expectation {
        "expect-ok" => {
            let response = read_result.context("read Edge control response")?;
            verify_success_response(&response)?;
        }
        "expect-reject" => {
            if let Ok(response) = read_result {
                bail!(
                    "expected application-level rejection after a successful QUIC handshake; got response: {}",
                    String::from_utf8_lossy(&response)
                );
            }
        }
        other => bail!("unknown authority expectation {other}"),
    }

    connection.close(0_u8.into(), b"e2e complete");
    Ok(())
}

async fn run_idle_timeout_case(endpoint: &Endpoint, addr: SocketAddr) -> Result<()> {
    let connection = connect(endpoint, addr)
        .await
        .context("QUIC/TLS connection failed before idle-timeout test")?;

    let close = tokio::time::timeout(Duration::from_secs(8), connection.closed())
        .await
        .context("Edge did not reclaim idle pre-auth connection within test deadline")?;
    if close != ConnectionError::TimedOut {
        bail!("expected QUIC idle timeout, got {close:?}");
    }
    Ok(())
}

async fn run_hold_preauth_case(endpoint: &Endpoint, addr: SocketAddr, hold_ms: u64) -> Result<()> {
    let connection = connect(endpoint, addr)
        .await
        .context("failed to establish held pre-auth QUIC connection")?;
    println!("preauth-connected");
    std::io::stdout()
        .flush()
        .context("flush readiness marker")?;
    tokio::time::sleep(Duration::from_millis(hold_ms)).await;
    connection.close(0_u8.into(), b"capacity probe complete");
    Ok(())
}

async fn run_capacity_reject_case(endpoint: &Endpoint, addr: SocketAddr) -> Result<()> {
    let connecting = endpoint.connect(addr, "localhost")?;
    let result = tokio::time::timeout(Duration::from_secs(3), connecting)
        .await
        .context("capacity refusal did not arrive within deadline")?;
    if let Ok(connection) = result {
        connection.close(0_u8.into(), b"unexpected capacity admission");
        bail!("expected Edge connection-cap refusal but QUIC handshake succeeded");
    }
    Ok(())
}

async fn open_routed_stream(
    connection: &quinn::Connection,
    stream_id: u32,
    kind: WireStreamKind,
) -> Result<(quinn::SendStream, quinn::RecvStream)> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .context("open routed renter stream")?;
    let frame = OpenStreamFrame {
        message_type: "OPEN_STREAM".into(),
        stream_id,
        kind,
        target_port: None,
        resume_from_sequence: None,
    };
    write_json_frame(&mut send, &frame, STREAM_METADATA_MAX_BYTES).await?;
    let status: StreamStatusFrame = read_json_frame(&mut recv, STREAM_STATUS_MAX_BYTES).await?;
    status.validate_for(stream_id)?;
    if !status.is_accepted() {
        bail!(
            "Edge/Host rejected routed stream {stream_id}: {:?}",
            status.code
        );
    }
    Ok((send, recv))
}

async fn assert_echo(
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    payload: &[u8],
) -> Result<()> {
    send.write_all(payload)
        .await
        .context("write routed E2E payload")?;
    send.finish().context("finish routed E2E request")?;
    let response = recv
        .read_to_end(ROUTED_RESPONSE_MAX_BYTES)
        .await
        .context("read routed E2E response")?;
    if response != payload {
        bail!("routed E2E payload corruption detected");
    }
    Ok(())
}

async fn run_interactive_route_case(
    endpoint: &Endpoint,
    addr: SocketAddr,
    authority: &[u8],
) -> Result<()> {
    let connection = connect(endpoint, addr).await?;
    authenticate(&connection, authority).await?;

    // Open both streams before closing either one. This proves the Edge's
    // INTERACTIVE gate only becomes true when Management and ExtensionHost
    // coexist as healthy independent routed streams.
    let management = open_routed_stream(&connection, 101, WireStreamKind::VscodeManagement).await?;
    let extension =
        open_routed_stream(&connection, 102, WireStreamKind::VscodeExtensionHost).await?;

    let management_echo = assert_echo(management.0, management.1, b"gpubnb-management-e2e");
    let extension_echo = assert_echo(extension.0, extension.1, b"gpubnb-extension-host-e2e");
    tokio::try_join!(management_echo, extension_echo)?;

    connection.close(0_u8.into(), b"routed workspace E2E complete");
    Ok(())
}

async fn run_large_route_case(
    endpoint: &Endpoint,
    addr: SocketAddr,
    authority: &[u8],
) -> Result<()> {
    let connection = connect(endpoint, addr).await?;
    authenticate(&connection, authority).await?;
    let stream = open_routed_stream(&connection, 201, WireStreamKind::FileTransfer).await?;
    let mut payload = vec![0_u8; 1024 * 1024];
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte = ((index * 31 + 17) % 251) as u8;
    }
    tokio::time::timeout(Duration::from_secs(30), assert_echo(stream.0, stream.1, &payload))
        .await
        .context("large routed transfer exceeded bounded deadline")??;
    connection.close(0_u8.into(), b"large routed E2E complete");
    Ok(())
}

async fn run_stream_pressure_case(
    endpoint: &Endpoint,
    addr: SocketAddr,
    authority: &[u8],
) -> Result<()> {
    let connection = connect(endpoint, addr).await?;
    authenticate(&connection, authority).await?;

    let mut streams = Vec::with_capacity(PRESSURE_STREAMS as usize);
    for index in 0..PRESSURE_STREAMS {
        streams.push(
            open_routed_stream(
                &connection,
                1_000 + index,
                WireStreamKind::Terminal,
            )
            .await
            .with_context(|| format!("open pressure stream {index}"))?,
        );
    }

    if tokio::time::timeout(Duration::from_millis(750), connection.open_bi())
        .await
        .is_ok()
    {
        bail!("65th bidirectional stream opened before capacity was released");
    }

    let (mut released_send, released_recv) = streams.remove(0);
    released_send
        .finish()
        .context("finish released pressure stream")?;
    drop(released_recv);

    let (mut send, mut recv) = tokio::time::timeout(Duration::from_secs(5), connection.open_bi())
        .await
        .context("stream capacity was not released after closing one stream")??;
    let frame = OpenStreamFrame {
        message_type: "OPEN_STREAM".into(),
        stream_id: 9_999,
        kind: WireStreamKind::Terminal,
        target_port: None,
        resume_from_sequence: None,
    };
    write_json_frame(&mut send, &frame, STREAM_METADATA_MAX_BYTES).await?;
    let status: StreamStatusFrame = read_json_frame(&mut recv, STREAM_STATUS_MAX_BYTES).await?;
    status.validate_for(9_999)?;
    if !status.is_accepted() {
        bail!("replacement stream was rejected after capacity release");
    }
    send.finish().context("finish replacement pressure stream")?;
    drop(recv);

    for (mut send, recv) in streams {
        let _ = send.finish();
        drop(recv);
    }
    connection.close(0_u8.into(), b"stream pressure E2E complete");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        bail!("usage: e2e_client <addr> <ca-cert.pem> <mode> [authority.json|hold-ms]");
    }

    let addr: SocketAddr = args[1].parse().context("parse Edge address")?;
    let mut endpoint = Endpoint::client("0.0.0.0:0".parse()?).context("create client endpoint")?;
    endpoint.set_default_client_config(client_config(&args[2])?);

    match args[3].as_str() {
        "expect-idle-timeout" => {
            if args.len() != 4 {
                bail!("expect-idle-timeout takes no extra argument");
            }
            run_idle_timeout_case(&endpoint, addr).await?;
        }
        "expect-capacity-reject" => {
            if args.len() != 4 {
                bail!("expect-capacity-reject takes no extra argument");
            }
            run_capacity_reject_case(&endpoint, addr).await?;
        }
        "hold-preauth" => {
            if args.len() != 5 {
                bail!("hold-preauth requires hold milliseconds");
            }
            let hold_ms = args[4]
                .parse::<u64>()
                .context("hold-preauth milliseconds must be an integer")?;
            if !(100..=10_000).contains(&hold_ms) {
                bail!("hold-preauth milliseconds must be between 100 and 10000");
            }
            run_hold_preauth_case(&endpoint, addr, hold_ms).await?;
        }
        "route-interactive" | "route-large" | "stream-pressure" => {
            if args.len() != 5 {
                bail!("routed test mode requires a RENTER authority path");
            }
            let authority = std::fs::read(&args[4]).context("read renter route authority")?;
            match args[3].as_str() {
                "route-interactive" => run_interactive_route_case(&endpoint, addr, &authority).await?,
                "route-large" => run_large_route_case(&endpoint, addr, &authority).await?,
                "stream-pressure" => run_stream_pressure_case(&endpoint, addr, &authority).await?,
                _ => unreachable!(),
            }
        }
        "expect-ok" | "expect-reject" => {
            if args.len() != 5 {
                bail!("authority test mode requires an authority path");
            }
            let authority = std::fs::read(&args[4]).context("read authority envelope")?;
            run_authority_case(&endpoint, addr, &authority, &args[3]).await?;
        }
        other => bail!("unknown E2E mode {other}"),
    }

    endpoint.wait_idle().await;
    Ok(())
}
