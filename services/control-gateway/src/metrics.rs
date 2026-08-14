use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct GatewayMetrics {
    accepted_connections: AtomicU64,
    rejected_auth: AtomicU64,
    fenced_connections: AtomicU64,
    heartbeats_accepted: AtomicU64,
    heartbeats_rejected: AtomicU64,
    commands_enqueued: AtomicU64,
    commands_backpressured: AtomicU64,
    command_acks: AtomicU64,
    redis_errors: AtomicU64,
}

impl GatewayMetrics {
    pub fn accepted_connection(&self) {
        self.accepted_connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn rejected_auth(&self) {
        self.rejected_auth.fetch_add(1, Ordering::Relaxed);
    }

    pub fn fenced_connection(&self) {
        self.fenced_connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn heartbeat_accepted(&self) {
        self.heartbeats_accepted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn heartbeat_rejected(&self) {
        self.heartbeats_rejected.fetch_add(1, Ordering::Relaxed);
    }

    pub fn command_enqueued(&self) {
        self.commands_enqueued.fetch_add(1, Ordering::Relaxed);
    }

    pub fn command_backpressured(&self) {
        self.commands_backpressured.fetch_add(1, Ordering::Relaxed);
    }

    pub fn command_ack(&self) {
        self.command_acks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn redis_error(&self) {
        self.redis_errors.fetch_add(1, Ordering::Relaxed);
    }

    pub fn render_prometheus(&self, active_connections: usize, pending_commands: usize) -> String {
        format!(
            concat!(
                "# TYPE gpubnb_control_gateway_active_connections gauge\n",
                "gpubnb_control_gateway_active_connections {}\n",
                "# TYPE gpubnb_control_gateway_pending_commands gauge\n",
                "gpubnb_control_gateway_pending_commands {}\n",
                "# TYPE gpubnb_control_gateway_connections_accepted_total counter\n",
                "gpubnb_control_gateway_connections_accepted_total {}\n",
                "# TYPE gpubnb_control_gateway_auth_rejected_total counter\n",
                "gpubnb_control_gateway_auth_rejected_total {}\n",
                "# TYPE gpubnb_control_gateway_connections_fenced_total counter\n",
                "gpubnb_control_gateway_connections_fenced_total {}\n",
                "# TYPE gpubnb_control_gateway_heartbeats_accepted_total counter\n",
                "gpubnb_control_gateway_heartbeats_accepted_total {}\n",
                "# TYPE gpubnb_control_gateway_heartbeats_rejected_total counter\n",
                "gpubnb_control_gateway_heartbeats_rejected_total {}\n",
                "# TYPE gpubnb_control_gateway_commands_enqueued_total counter\n",
                "gpubnb_control_gateway_commands_enqueued_total {}\n",
                "# TYPE gpubnb_control_gateway_commands_backpressured_total counter\n",
                "gpubnb_control_gateway_commands_backpressured_total {}\n",
                "# TYPE gpubnb_control_gateway_command_acks_total counter\n",
                "gpubnb_control_gateway_command_acks_total {}\n",
                "# TYPE gpubnb_control_gateway_redis_errors_total counter\n",
                "gpubnb_control_gateway_redis_errors_total {}\n"
            ),
            active_connections,
            pending_commands,
            self.accepted_connections.load(Ordering::Relaxed),
            self.rejected_auth.load(Ordering::Relaxed),
            self.fenced_connections.load(Ordering::Relaxed),
            self.heartbeats_accepted.load(Ordering::Relaxed),
            self.heartbeats_rejected.load(Ordering::Relaxed),
            self.commands_enqueued.load(Ordering::Relaxed),
            self.commands_backpressured.load(Ordering::Relaxed),
            self.command_acks.load(Ordering::Relaxed),
            self.redis_errors.load(Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_are_low_cardinality_and_machine_ids_never_become_labels() {
        let metrics = GatewayMetrics::default();
        metrics.accepted_connection();
        let rendered = metrics.render_prometheus(7, 11);
        assert!(rendered.contains("gpubnb_control_gateway_active_connections 7"));
        assert!(!rendered.contains("machineId"));
        assert!(!rendered.contains("machine_id="));
    }
}
