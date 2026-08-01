#[path = "../src/mining_configuration.rs"]
mod mining_configuration;
#[path = "../src/mining_pool_probe.rs"]
mod mining_pool_probe;

use mining_configuration::{authorize_configuration_change, MiningConfigurationActor};
use mining_pool_probe::{probe_pool_connection, MiningPoolEndpoint};

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
    // An invalid scheme is rejected before DNS or TCP access. Calling the
    // public probe also ensures its complete fail-closed path is compiled.
    assert_eq!(
        probe_pool_connection("https://pool.example.com:443", 1_000),
        Err("mining_pool_scheme_not_allowed")
    );

    // A TLS endpoint can be parsed, but no code manufactures tls_verified=true
    // without a certificate-verifying transport.
    let endpoint = MiningPoolEndpoint::parse("stratum+ssl://localhost:1").unwrap();
    assert!(endpoint.requires_tls);
}

#[test]
fn host_service_cannot_change_owner_pool_configuration() {
    assert_eq!(
        authorize_configuration_change(MiningConfigurationActor::HostService),
        Err("mining_configuration_change_forbidden")
    );
}
