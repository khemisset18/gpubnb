use crate::mining_configuration::PoolConnectionEvidence;
use native_tls::{Protocol, TlsConnector};
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

        if authority.contains('@')
            || authority.contains('?')
            || authority.contains('#')
            || authority.contains('/')
        {
            return Err("mining_pool_url_contains_forbidden_components");
        }

        let (host, port) = authority
            .rsplit_once(':')
            .ok_or("mining_pool_port_required")?;
        let host = host.trim_matches(['[', ']']);
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
            host: host.to_owned(),
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

    if endpoint.requires_tls {
        return probe_tls_connection(&endpoint, &addresses, now_unix_seconds);
    }

    let tcp_connected = addresses
        .iter()
        .any(|address| TcpStream::connect_timeout(address, CONNECT_TIMEOUT).is_ok());
    if !tcp_connected {
        return Err("mining_pool_tcp_unverified");
    }

    Ok(PoolConnectionEvidence {
        pool_url: endpoint.pool_url,
        dns_resolved: true,
        tcp_connected: true,
        tls_verified: false,
        verified_at_unix_seconds: now_unix_seconds,
    })
}

fn tls_connector() -> Result<TlsConnector, &'static str> {
    let mut builder = TlsConnector::builder();
    builder
        .min_protocol_version(Some(Protocol::Tlsv12))
        .use_sni(true)
        .danger_accept_invalid_certs(false)
        .danger_accept_invalid_hostnames(false);
    builder
        .build()
        .map_err(|_| "mining_pool_tls_connector_unavailable")
}

fn probe_tls_connection(
    endpoint: &MiningPoolEndpoint,
    addresses: &[SocketAddr],
    now_unix_seconds: u64,
) -> Result<PoolConnectionEvidence, &'static str> {
    let connector = tls_connector()?;
    let mut tcp_connected = false;

    for address in addresses {
        let stream = match TcpStream::connect_timeout(address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                tcp_connected = true;
                stream
            }
            Err(_) => continue,
        };
        let _ = stream.set_read_timeout(Some(CONNECT_TIMEOUT));
        let _ = stream.set_write_timeout(Some(CONNECT_TIMEOUT));

        // Connect to the already-public IP while preserving the original
        // hostname for both SNI and certificate hostname verification.
        if connector.connect(endpoint.host.as_str(), stream).is_ok() {
            return Ok(PoolConnectionEvidence {
                pool_url: endpoint.pool_url.clone(),
                dns_resolved: true,
                tcp_connected: true,
                tls_verified: true,
                verified_at_unix_seconds: now_unix_seconds,
            });
        }
    }

    if !tcp_connected {
        return Err("mining_pool_tcp_unverified");
    }
    Err("mining_pool_tls_unverified")
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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tls_and_tcp_without_downgrade() {
        let tls = MiningPoolEndpoint::parse("stratum+tls://pool.example.com:443").unwrap();
        assert!(tls.requires_tls);
        assert_eq!(tls.host, "pool.example.com");
        assert_eq!(tls.port, 443);

        let ssl = MiningPoolEndpoint::parse("stratum+ssl://pool.example.com:4444").unwrap();
        assert!(ssl.requires_tls);

        let tcp = MiningPoolEndpoint::parse("stratum+tcp://pool.example.com:3333").unwrap();
        assert!(!tcp.requires_tls);

        assert_eq!(
            MiningPoolEndpoint::parse("https://pool.example.com:443").unwrap_err(),
            "mining_pool_scheme_not_allowed"
        );
    }

    #[test]
    fn rejects_credentials_and_ambiguous_url_components() {
        for value in [
            "stratum+tls://user:pass@pool.example.com:443",
            "stratum+tls://pool.example.com:443/path",
            "stratum+tls://pool.example.com:443?region=eu",
            "stratum+tls://pool.example.com:443#fragment",
        ] {
            assert!(MiningPoolEndpoint::parse(value).is_err(), "{value}");
        }
    }

    #[test]
    fn native_tls_connector_is_available_with_secure_policy() {
        tls_connector().expect("native TLS connector must initialize on supported Host platforms");
        let source = include_str!("mining_pool_probe.rs");
        assert!(source.contains(".danger_accept_invalid_certs(false)"));
        assert!(source.contains(".danger_accept_invalid_hostnames(false)"));
        assert!(source.contains(".use_sni(true)"));
        assert!(source.contains(".min_protocol_version(Some(Protocol::Tlsv12))"));
        assert!(!source.contains(".danger_accept_invalid_certs(true)"));
        assert!(!source.contains(".danger_accept_invalid_hostnames(true)"));
    }

    #[test]
    fn private_addresses_remain_rejected_before_tls() {
        assert!(!address_is_public(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!address_is_public(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(!address_is_public(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!address_is_public(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(address_is_public(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }
}
