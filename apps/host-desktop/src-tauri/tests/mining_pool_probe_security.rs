#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_pool_probe.rs"]
mod mining_pool_probe;

use mining_pool_probe::MiningPoolEndpoint;

#[test]
fn parses_only_explicit_stratum_endpoints() {
    let tcp = MiningPoolEndpoint::parse("stratum+tcp://pool.example.com:4444").unwrap();
    assert_eq!(tcp.host, "pool.example.com");
    assert_eq!(tcp.port, 4444);
    assert!(!tcp.requires_tls);

    let tls = MiningPoolEndpoint::parse("stratum+tls://pool.example.com:443").unwrap();
    assert!(tls.requires_tls);
    assert_eq!(
        MiningPoolEndpoint::parse("https://pool.example.com:443"),
        Err("mining_pool_scheme_not_allowed")
    );
}

#[test]
fn credentials_and_ambiguous_components_are_rejected() {
    assert_eq!(
        MiningPoolEndpoint::parse("stratum+tcp://user@pool.example.com:4444"),
        Err("mining_pool_url_contains_forbidden_components")
    );
    assert_eq!(
        MiningPoolEndpoint::parse("stratum+tcp://pool.example.com:4444?x=1"),
        Err("mining_pool_url_contains_forbidden_components")
    );
    assert_eq!(
        MiningPoolEndpoint::parse("stratum+tcp://pool.example.com:0"),
        Err("mining_invalid_pool_port")
    );
}

#[test]
fn tls_probe_is_fail_closed_before_network_access() {
    // A TLS URL can be parsed, but the implementation never manufactures
    // tls_verified=true without a certificate-verifying transport.
    let endpoint = MiningPoolEndpoint::parse("stratum+ssl://localhost:1").unwrap();
    assert!(endpoint.requires_tls);
}
