use crate::mining_configuration::PoolConnectionEvidence;
use native_tls::{Protocol, TlsConnector, TlsConnectorBuilder};
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

fn tls_connector_builder() -> TlsConnectorBuilder {
    let mut builder = TlsConnector::builder();
    builder
        .min_protocol_version(Some(Protocol::Tlsv12))
        .use_sni(true)
        .danger_accept_invalid_certs(false)
        .danger_accept_invalid_hostnames(false);
    builder
}

fn tls_connector() -> Result<TlsConnector, &'static str> {
    tls_connector_builder()
        .build()
        .map_err(|_| "mining_pool_tls_connector_unavailable")
}

fn probe_tls_connection(
    endpoint: &MiningPoolEndpoint,
    addresses: &[SocketAddr],
    now_unix_seconds: u64,
) -> Result<PoolConnectionEvidence, &'static str> {
    let connector = tls_connector()?;
    probe_tls_connection_with_connector(&connector, endpoint, addresses, now_unix_seconds)
}

fn probe_tls_connection_with_connector(
    connector: &TlsConnector,
    endpoint: &MiningPoolEndpoint,
    addresses: &[SocketAddr],
    now_unix_seconds: u64,
) -> Result<PoolConnectionEvidence, &'static str> {
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

        // The socket is connected to the already-public IP selected above. The
        // original hostname is passed to native-tls for both SNI and hostname
        // certificate verification, so DNS cannot redirect the TLS handshake.
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
    use native_tls::{Certificate as NativeCertificate, Identity, TlsAcceptor};
    use rcgen::{
        date_time_ymd, BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer,
        KeyPair, KeyUsagePurpose,
    };
    use std::net::TcpListener;
    use std::thread;

    fn test_identity(
        hostname: &str,
        not_before: (i32, u8, u8),
        not_after: (i32, u8, u8),
    ) -> (Identity, NativeCertificate) {
        let mut ca_params =
            CertificateParams::new(Vec::<String>::new()).expect("empty CA SAN is valid");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyCertSign,
        ];
        let ca_key = KeyPair::generate().expect("generate CA key");
        let ca_cert = ca_params.self_signed(&ca_key).expect("self-sign CA");
        let issuer = Issuer::new(ca_params, ca_key);

        let mut leaf_params =
            CertificateParams::new(vec![hostname.to_owned()]).expect("valid DNS SAN");
        leaf_params.not_before = date_time_ymd(not_before.0, not_before.1, not_before.2);
        leaf_params.not_after = date_time_ymd(not_after.0, not_after.1, not_after.2);
        leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let leaf_key = KeyPair::generate().expect("generate leaf key");
        let leaf_cert = leaf_params
            .signed_by(&leaf_key, &issuer)
            .expect("sign leaf with test CA");

        let identity = Identity::from_pkcs8(
            leaf_cert.pem().as_bytes(),
            leaf_key.serialize_pem().as_bytes(),
        )
        .expect("native TLS accepts generated PKCS#8 identity");
        let root = NativeCertificate::from_der(ca_cert.der().as_ref())
            .expect("native TLS accepts generated CA");
        (identity, root)
    }

    fn spawn_tls_server(identity: Identity) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind TLS test server");
        let address = listener.local_addr().expect("TLS test server address");
        let acceptor = TlsAcceptor::new(identity).expect("build TLS test acceptor");
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept TLS test client");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
            let _ = acceptor.accept(stream);
        });
        (address, handle)
    }

    fn connector_with_test_root(root: NativeCertificate) -> TlsConnector {
        let mut builder = tls_connector_builder();
        builder.add_root_certificate(root);
        builder.build().expect("build TLS connector with test root")
    }

    fn local_endpoint(hostname: &str, port: u16) -> MiningPoolEndpoint {
        MiningPoolEndpoint {
            pool_url: format!("stratum+tls://{hostname}:{port}"),
            host: hostname.to_owned(),
            port,
            requires_tls: true,
        }
    }

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
    fn trusted_valid_certificate_and_hostname_complete_tls() {
        let (identity, root) =
            test_identity("pool.test", (2025, 1, 1), (2035, 1, 1));
        let (address, server) = spawn_tls_server(identity);
        let connector = connector_with_test_root(root);
        let endpoint = local_endpoint("pool.test", address.port());

        let evidence =
            probe_tls_connection_with_connector(&connector, &endpoint, &[address], 123).unwrap();
        assert!(evidence.tls_verified);
        assert!(evidence.tcp_connected);
        server.join().expect("join TLS test server");
    }

    #[test]
    fn hostname_mismatch_is_rejected() {
        let (identity, root) =
            test_identity("pool.test", (2025, 1, 1), (2035, 1, 1));
        let (address, server) = spawn_tls_server(identity);
        let connector = connector_with_test_root(root);
        let endpoint = local_endpoint("wrong.test", address.port());

        assert_eq!(
            probe_tls_connection_with_connector(&connector, &endpoint, &[address], 123),
            Err("mining_pool_tls_unverified")
        );
        server.join().expect("join TLS test server");
    }

    #[test]
    fn untrusted_certificate_is_rejected() {
        let (identity, _root) =
            test_identity("pool.test", (2025, 1, 1), (2035, 1, 1));
        let (address, server) = spawn_tls_server(identity);
        let connector = tls_connector().expect("build system-root TLS connector");
        let endpoint = local_endpoint("pool.test", address.port());

        assert_eq!(
            probe_tls_connection_with_connector(&connector, &endpoint, &[address], 123),
            Err("mining_pool_tls_unverified")
        );
        server.join().expect("join TLS test server");
    }

    #[test]
    fn expired_certificate_is_rejected() {
        let (identity, root) =
            test_identity("pool.test", (2018, 1, 1), (2019, 1, 1));
        let (address, server) = spawn_tls_server(identity);
        let connector = connector_with_test_root(root);
        let endpoint = local_endpoint("pool.test", address.port());

        assert_eq!(
            probe_tls_connection_with_connector(&connector, &endpoint, &[address], 123),
            Err("mining_pool_tls_unverified")
        );
        server.join().expect("join TLS test server");
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
