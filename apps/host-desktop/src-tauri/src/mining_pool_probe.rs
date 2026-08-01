use crate::mining_configuration::PoolConnectionEvidence;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESOLVED_ADDRESSES: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MiningPoolEndpoint {
    pub pool_url: String,
    pub host: String,
    pub port: u16,
    pub requires_tls: bool,
}

impl MiningPoolEndpoint {
    pub fn parse(pool_url: &str) -> Result<Self, &'static str> {
        let (authority, requires_tls) = if let Some(value) = pool_url.strip_prefix("stratum+tcp://")
        {
            (value, false)
        } else if let Some(value) = pool_url.strip_prefix("stratum+tls://") {
            (value, true)
        } else if let Some(value) = pool_url.strip_prefix("stratum+ssl://") {
            (value, true)
        } else {
            return Err("mining_pool_scheme_not_allowed");
        };

        if authority.contains('@') || authority.contains('?') || authority.contains('#') {
            return Err("mining_pool_url_contains_forbidden_components");
        }

        let (host, port) = authority
            .rsplit_once(':')
            .ok_or("mining_pool_port_required")?;
        if host.is_empty() || host.len() > 253 {
            return Err("mining_invalid_pool_host");
        }
        let port = port
            .parse::<u16>()
            .map_err(|_| "mining_invalid_pool_port")?;
        if port == 0 {
            return Err("mining_invalid_pool_port");
        }

        Ok(Self {
            pool_url: pool_url.to_owned(),
            host: host.trim_matches(['[', ']']).to_owned(),
            port,
            requires_tls,
        })
    }
}

pub fn probe_pool_connection(
    pool_url: &str,
    now_unix_seconds: u64,
) -> Result<PoolConnectionEvidence, &'static str> {
    let endpoint = MiningPoolEndpoint::parse(pool_url)?;
    let addresses = resolve_addresses(&endpoint)?;
    let tcp_connected = addresses
        .iter()
        .any(|address| TcpStream::connect_timeout(address, CONNECT_TIMEOUT).is_ok());
    if !tcp_connected {
        return Err("mining_pool_tcp_unverified");
    }

    // TLS pools remain fail-closed until a certificate-verifying native TLS
    // implementation is wired into every supported desktop platform.
    if endpoint.requires_tls {
        return Err("mining_pool_tls_probe_unavailable");
    }

    Ok(PoolConnectionEvidence {
        pool_url: endpoint.pool_url,
        dns_resolved: true,
        tcp_connected: true,
        tls_verified: false,
        verified_at_unix_seconds: now_unix_seconds,
    })
}

fn resolve_addresses(endpoint: &MiningPoolEndpoint) -> Result<Vec<SocketAddr>, &'static str> {
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|_| "mining_pool_dns_unverified")?
        .take(MAX_RESOLVED_ADDRESSES)
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("mining_pool_dns_unverified");
    }
    Ok(addresses)
}
