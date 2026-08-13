use std::{env, fs::File, io::BufReader, net::SocketAddr, sync::Arc};

use anyhow::{bail, Context, Result};
use gpubnb_edge_core::ALPN;
use quinn::{crypto::rustls::QuicClientConfig, ClientConfig, Endpoint};

fn client_config(cert_path: &str) -> Result<ClientConfig> {
    let mut reader = BufReader::new(File::open(cert_path).context("open test certificate")?);
    let certs = rustls_pemfile::certs(&mut reader).collect::<Result<Vec<_>, _>>()?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in certs {
        roots.add(cert).context("add test root")?;
    }
    let mut tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.as_bytes().to_vec()];
    let quic = QuicClientConfig::try_from(tls).context("QUIC client TLS config")?;
    Ok(ClientConfig::new(Arc::new(quic)))
}

async fn attempt(endpoint: &Endpoint, addr: SocketAddr, authority: &[u8]) -> Result<Vec<u8>> {
    let connection = endpoint.connect(addr, "localhost")?.await.context("QUIC connect")?;
    let (mut send, mut recv) = connection.open_bi().await.context("open authority stream")?;
    send.write_all(authority).await.context("write authority")?;
    send.finish().context("finish authority stream")?;
    let response = recv.read_to_end(8192).await.context("read control response")?;
    connection.close(0_u8.into(), b"e2e complete");
    Ok(response)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        bail!("usage: e2e_client <addr> <cert.pem> <expect-ok|expect-reject> <authority.json>");
    }
    let addr: SocketAddr = args[1].parse().context("parse Edge address")?;
    let mut endpoint = Endpoint::client("0.0.0.0:0".parse()?).context("create client endpoint")?;
    endpoint.set_default_client_config(client_config(&args[2])?);
    let authority = std::fs::read(&args[4]).context("read authority envelope")?;
    let result = attempt(&endpoint, addr, &authority).await;
    match args[3].as_str() {
        "expect-ok" => {
            let response = result?;
            if response != br#"{\"ok\":true,\"protocol\":\"gpubnb-dp/1\"}"# {
                bail!("unexpected Edge control response: {}", String::from_utf8_lossy(&response));
            }
        }
        "expect-reject" => {
            if let Ok(response) = result {
                if response == br#"{\"ok\":true,\"protocol\":\"gpubnb-dp/1\"}"# {
                    bail!("replayed authority was unexpectedly accepted");
                }
            }
        }
        other => bail!("unknown expectation {other}"),
    }
    endpoint.wait_idle().await;
    Ok(())
}
