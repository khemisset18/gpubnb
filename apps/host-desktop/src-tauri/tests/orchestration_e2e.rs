#[path = "../src/external_pool.rs"]
mod external_pool;
#[path = "../src/orchestrator.rs"]
mod orchestrator;

use external_pool::{ExternalPoolProfile, MiningDevice, SupportedAsset};
use orchestrator::{ComputeOrchestrator, OrchestrationEvent, OrchestrationState};

fn monero_pool() -> ExternalPoolProfile {
    ExternalPoolProfile {
        asset: SupportedAsset::Monero,
        device: MiningDevice::Cpu,
        host: "pool.example.org".into(),
        port: 443,
        tls: true,
        wallet_address: "4".repeat(95),
        worker_name: "host-cpu-0".into(),
    }
}

#[test]
fn certified_host_mines_then_yields_to_a_rental_and_resumes() {
    let mut host = ComputeOrchestrator::default();
    assert_eq!(
        host.apply(OrchestrationEvent::HostCertified),
        Ok(OrchestrationState::Idle)
    );
    host.configure_external_pool(monero_pool()).unwrap();
    assert_eq!(
        host.apply(OrchestrationEvent::MiningPreferenceEnabled),
        Ok(OrchestrationState::Mining)
    );

    assert_eq!(
        host.apply(OrchestrationEvent::ReservationConfirmed),
        Ok(OrchestrationState::StoppingMining)
    );
    assert_eq!(
        host.apply(OrchestrationEvent::MiningStoppedAndVerified),
        Ok(OrchestrationState::PreparingRental)
    );
    assert_eq!(
        host.apply(OrchestrationEvent::RentalWorkspaceReady),
        Ok(OrchestrationState::RentalActive)
    );
    assert_eq!(
        host.apply(OrchestrationEvent::RentalEnded),
        Ok(OrchestrationState::CleaningRental)
    );
    assert_eq!(
        host.apply(OrchestrationEvent::CleanupVerified),
        Ok(OrchestrationState::Mining)
    );
}

#[test]
fn unsafe_external_pool_never_enables_mining() {
    let mut host = ComputeOrchestrator::default();
    host.apply(OrchestrationEvent::HostCertified).unwrap();
    let mut pool = monero_pool();
    pool.host = "127.0.0.1".into();

    assert_eq!(
        host.configure_external_pool(pool),
        Err("pool_ip_literal_not_allowed")
    );
    assert_eq!(
        host.apply(OrchestrationEvent::MiningPreferenceEnabled),
        Err("external_pool_not_configured")
    );
}
