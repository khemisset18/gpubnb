#[cfg(test)]
mod resource_state;
#[cfg(test)]
mod service_contract;

fn main() {
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