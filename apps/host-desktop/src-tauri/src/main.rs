#[path = "installation_identity.rs"]
mod installation_identity;

#[cfg(test)]
mod resource_state;
#[cfg(test)]
mod service_contract;

use installation_identity::InstallationIdentityStore;

fn configure_runtime_identity() -> Result<(), &'static str> {
    let identity = InstallationIdentityStore::from_default_location()?.load_or_create()?;
    std::env::set_var("GPUBNB_INSTALLATION_ID", identity.installation_id);
    std::env::set_var("GPUBNB_MACHINE_ID", identity.local_machine_id);
    Ok(())
}

fn main() {
    if let Err(error) = configure_runtime_identity() {
        eprintln!("GPUbnb Host startup failed: {error}");
        std::process::exit(1);
    }
    gpubnb_host_desktop_lib::run();
}

#[cfg(test)]
mod tests {
    use super::resource_state::{ResourceController, ResourceEvent, ResourceState};

    #[test]
    fn certified_host_starts_idle_and_fail_closed() {
        let mut controller = ResourceController::default();
        assert_eq!(
            controller.apply(ResourceEvent::HostCertified),
            Ok(ResourceState::Idle)
        );
        assert!(!controller.mining_enabled);
        assert!(!controller.reservation_pending);
    }
}
