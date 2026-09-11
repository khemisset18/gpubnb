#[path = "installation_identity.rs"]
mod installation_identity;
mod windows_host_bootstrap;

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
    // On Windows this idempotently registers GPUbnb Host for the owner's next
    // logon and starts Docker Desktop in that interactive user session before the
    // Tauri UI is launched. The Agent service itself already starts at system boot.
    windows_host_bootstrap::prepare_host_startup();
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
