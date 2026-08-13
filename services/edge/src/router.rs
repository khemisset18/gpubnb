use std::collections::HashMap;

use anyhow::{bail, Result};
use gpubnb_edge_core::SessionBinding;
use quinn::Connection;

#[derive(Clone)]
pub struct HostRoute {
    pub lease_id: u64,
    pub binding: SessionBinding,
    pub connection: Connection,
}

pub struct WorkspaceRouter {
    hosts: HashMap<String, HostRoute>,
    next_lease_id: u64,
}

impl Default for WorkspaceRouter {
    fn default() -> Self {
        Self {
            hosts: HashMap::new(),
            next_lease_id: 1,
        }
    }
}

impl WorkspaceRouter {
    pub fn register_host(
        &mut self,
        binding: SessionBinding,
        connection: Connection,
    ) -> (u64, Option<Connection>) {
        let lease_id = self.next_lease_id;
        self.next_lease_id = self.next_lease_id.saturating_add(1).max(1);
        let session_id = binding.session_id.clone();
        let previous = self.hosts.insert(
            session_id,
            HostRoute {
                lease_id,
                binding,
                connection,
            },
        );
        (lease_id, previous.map(|route| route.connection))
    }

    pub fn host_for(&self, renter: &SessionBinding) -> Result<HostRoute> {
        let route = self
            .hosts
            .get(&renter.session_id)
            .ok_or_else(|| anyhow::anyhow!("no Host tunnel registered for session"))?;
        if !same_session_scope(&route.binding, renter) {
            bail!("renter authority scope does not match Host tunnel scope");
        }
        Ok(route.clone())
    }

    pub fn remove_host(&mut self, session_id: &str, lease_id: u64) -> bool {
        let should_remove = self
            .hosts
            .get(session_id)
            .is_some_and(|route| route.lease_id == lease_id);
        if should_remove {
            self.hosts.remove(session_id);
        }
        should_remove
    }
}

pub fn same_session_scope(left: &SessionBinding, right: &SessionBinding) -> bool {
    left.protocol_version == right.protocol_version
        && left.session_id == right.session_id
        && left.machine_id == right.machine_id
        && left.booking_id == right.booking_id
        && left.renter_user_id == right.renter_user_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpubnb_edge_core::PROTOCOL_VERSION;

    fn binding(session: &str, machine: &str, renter: &str) -> SessionBinding {
        SessionBinding {
            protocol_version: PROTOCOL_VERSION,
            session_id: session.into(),
            machine_id: machine.into(),
            booking_id: "booking_1".into(),
            renter_user_id: renter.into(),
            issued_at_ms: 1_000,
            expires_at_ms: 2_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn scope_match_ignores_nonce_and_issue_time_but_not_identity() {
        let host = binding("session_1", "machine_1", "user_1");
        let mut renter = host.clone();
        renter.issued_at_ms = 1_500;
        renter.expires_at_ms = 2_500;
        renter.nonce = "abcdef0123456789abcdef0123456789".into();
        assert!(same_session_scope(&host, &renter));

        renter.machine_id = "machine_2".into();
        assert!(!same_session_scope(&host, &renter));
        renter.machine_id = "machine_1".into();
        renter.renter_user_id = "user_2".into();
        assert!(!same_session_scope(&host, &renter));
    }
}
