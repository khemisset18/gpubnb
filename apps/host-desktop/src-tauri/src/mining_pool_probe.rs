use crate::mining_configuration::PoolConnectionEvidence;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs};
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

fn ipv4_is_public(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_documentation()
    {
        return false;
    }
    // Shared CGNAT, protocol-assignment, benchmarking and reserved ranges are
    // never valid mining-pool destinations.
    if octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240
    {
        return false;
    }
    true
}

fn ipv6_is_public(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    let unique_local = segments[0] & 0xfe00 == 0xfc00;
    let unicast_link_local = segments[0] & 0xffc0 == 0xfe80;
    if address.is_unspecified()
        || address.is_loopback()
        || unique_local
        || unicast_link_local
        || address.is_multicast()
    {
        return false;
    }
    // Documentation prefix 2001:db8::/32.
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    if let Some(mapped) = address.to_ipv4_mapped() {
        return ipv4_is_public(mapped);
    }
    true
}

fn address_is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => ipv4_is_public(value),
        IpAddr::V6(value) => ipv6_is_public(value),
    }
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
    if addresses
        .iter()
        .any(|address| !address_is_public(address.ip()))
    {
        return Err("mining_pool_address_not_public");
    }
    Ok(addresses)
}
