use crate::mining_configuration::PoolConnectionEvidence;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
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

fn client_config_with_roots(
    roots: RootCertStore,
) -> Result<Arc<ClientConfig>, &'static str> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "mining_pool_tls_connector_unavailable")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.enable_sni = true;
    Ok(Arc::new(config))
}

fn tls_client_config() -> Result<Arc<ClientConfig>, &'static str> {
    let native = rustls_native_certs::load_native_certs();
    if native.certs.is_empty() {
        return Err("mining_pool_tls_root_store_unavailable");
    }

    let mut roots = RootCertStore::empty();
    for certificate in native.certs {
        roots
            .add(certificate)
            .map_err(|_| "mining_pool_tls_root_store_unavailable")?;
    }
    client_config_with_roots(roots)
}

fn probe_tls_connection(
    endpoint: &MiningPoolEndpoint,
    addresses: &[SocketAddr],
    now_unix_seconds: u64,
) -> Result<PoolConnectionEvidence, &'static str> {
    let config = tls_client_config()?;
    probe_tls_connection_with_config(&config, endpoint, addresses, now_unix_seconds)
}

fn probe_tls_connection_with_config(
    config: &Arc<ClientConfig>,
    endpoint: &MiningPoolEndpoint,
    addresses: &[SocketAddr],
    now_unix_seconds: u64,
) -> Result<PoolConnectionEvidence, &'static str> {
    let server_name = ServerName::try_from(endpoint.host.clone())
        .map_err(|_| "mining_invalid_pool_host")?;
    let mut tcp_connected = false;

    for address in addresses {
        let mut stream = match TcpStream::connect_timeout(address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                tcp_connected = true;
                stream
            }
            Err(_) => continue,
        };
        let _ = stream.set_read_timeout(Some(CONNECT_TIMEOUT));
        let _ = stream.set_write_timeout(Some(CONNECT_TIMEOUT));

        let mut connection = match ClientConnection::new(config.clone(), server_name.clone()) {
            Ok(connection) => connection,
            Err(_) => continue,
        };

        let mut handshake_ok = true;
        while connection.is_handshaking() {
            if connection.complete_io(&mut stream).is_err() {
                handshake_ok = false;
                break;
            }
        }
        if handshake_ok && !connection.is_handshaking() {
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
    use rcgen::{
        date_time_ymd, BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer,
        KeyPair, KeyUsagePurpose,
    };
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ServerConfig, ServerConnection, StreamOwned};
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;

    fn test_server_config(
        hostname: &str,
        not_before: (i32, u8, u8),
        not_after: (i32, u8, u8),
    ) -> (Arc<ServerConfig>, CertificateDer<'static>) {
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

        let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let server = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("safe TLS protocol versions")
            .with_no_client_auth()
            .with_single_cert(vec![leaf_cert.der().clone()], private_key)
            .expect("build portable Rustls test server");
        (Arc::new(server), ca_cert.der().clone())
    }

    fn spawn_tls_server(config: Arc<ServerConfig>) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind TLS test server");
        let address = listener.local_addr().expect("TLS test server address");
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept TLS test client");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
            let connection = ServerConnection::new(config).expect("create TLS server connection");
            let mut tls = StreamOwned::new(connection, stream);
            let mut byte = [0_u8; 1];
            let _ = tls.read(&mut byte);
        });
        (address, handle)
    }

    fn client_config_with_test_root(root: CertificateDer<'static>) -> Arc<ClientConfig> {
        let mut roots = RootCertStore::empty();
        roots.add(root).expect("add generated test CA");
        client_config_with_roots(roots).expect("build Rustls client with test root")
    }

    fn client_config_without_test_root() -> Arc<ClientConfig> {
        client_config_with_roots(RootCertStore::empty())
            .expect("build Rustls client with empty test roots")
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
    fn rustls_native_trust_is_available_with_secure_policy() {
        tls_client_config().expect("native certificate roots must initialize on Host platforms");
        let source = include_str!("mining_pool_probe.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source precedes tests");
        assert!(production.contains("rustls_native_certs::load_native_certs()"));
        assert!(production.contains("with_safe_default_protocol_versions()"));
        assert!(production.contains("config.enable_sni = true"));
        assert!(!production.contains("dangerous()"));
        assert!(!production.contains("with_custom_certificate_verifier"));
    }

    #[test]
    fn trusted_valid_certificate_and_hostname_complete_tls() {
        let (server_config, root) = test_server_config("pool.test", (2025, 1, 1), (2035, 1, 1));
        let (address, server) = spawn_tls_server(server_config);
        let config = client_config_with_test_root(root);
        let endpoint = local_endpoint("pool.test", address.port());

        let evidence =
            probe_tls_connection_with_config(&config, &endpoint, &[address], 123).unwrap();
        assert!(evidence.tls_verified);
        assert!(evidence.tcp_connected);
        server.join().expect("join TLS test server");
    }

    #[test]
    fn hostname_mismatch_is_rejected() {
        let (server_config, root) = test_server_config("pool.test", (2025, 1, 1), (2035, 1, 1));
        let (address, server) = spawn_tls_server(server_config);
        let config = client_config_with_test_root(root);
        let endpoint = local_endpoint("wrong.test", address.port());

        assert_eq!(
            probe_tls_connection_with_config(&config, &endpoint, &[address], 123),
            Err("mining_pool_tls_unverified")
        );
        server.join().expect("join TLS test server");
    }

    #[test]
    fn untrusted_certificate_is_rejected() {
        let (server_config, _root) = test_server_config("pool.test", (2025, 1, 1), (2035, 1, 1));
        let (address, server) = spawn_tls_server(server_config);
        let config = client_config_without_test_root();
        let endpoint = local_endpoint("pool.test", address.port());

        assert_eq!(
            probe_tls_connection_with_config(&config, &endpoint, &[address], 123),
            Err("mining_pool_tls_unverified")
        );
        server.join().expect("join TLS test server");
    }

    #[test]
    fn expired_certificate_is_rejected() {
        let (server_config, root) = test_server_config("pool.test", (2018, 1, 1), (2019, 1, 1));
        let (address, server) = spawn_tls_server(server_config);
        let config = client_config_with_test_root(root);
        let endpoint = local_endpoint("pool.test", address.port());

        assert_eq!(
            probe_tls_connection_with_config(&config, &endpoint, &[address], 123),
            Err("mining_pool_tls_unverified")
        );
        server.join().expect("join TLS test server");
    }

    #[test]
    fn private_addresses_remain_rejected_before_tls() {
        assert!(!address_is_public(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!address_is_public(IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
        assert!(!address_is_public(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!address_is_public(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(address_is_public(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }
}
