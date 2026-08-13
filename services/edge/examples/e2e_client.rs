use std::{env, fs::File, io::BufReader, net::SocketAddr, sync::Arc};

use anyhow::{bail, Context, Result};
use gpubnb_edge_core::ALPN;
use quinn::{crypto::rustls::QuicClientConfig, ClientConfig, Endpoint};
use serde::Deserialize;

const CONTROL_RESPONSE_MAX_BYTES: usize = 8 * 1024;

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

async fn run_case(
    endpoint: &Endpoint,
    addr: SocketAddr,
    authority: &[u8],
    expectation: &str,
) -> Result<()> {
    // Transport/TLS/ALPN must always succeed. A network or certificate failure
    // must never be accepted as proof that replay protection worked.
    let connection = endpoint
        .connect(addr, "localhost")?
        .await
        .context("QUIC/TLS connection failed")?;
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
        other => bail!("unknown expectation {other}"),
    }

    connection.close(0_u8.into(), b"e2e complete");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        bail!("usage: e2e_client <addr> <ca-cert.pem> <expect-ok|expect-reject> <authority.json>");
    }

    let addr: SocketAddr = args[1].parse().context("parse Edge address")?;
    let mut endpoint = Endpoint::client("0.0.0.0:0".parse()?).context("create client endpoint")?;
    endpoint.set_default_client_config(client_config(&args[2])?);
    let authority = std::fs::read(&args[4]).context("read authority envelope")?;

    run_case(&endpoint, addr, &authority, &args[3]).await?;
    endpoint.wait_idle().await;
    Ok(())
}
