use crate::rental_orchestrator::{
    OrchestrationSnapshot, RentalOrchestrator, VerifiedReservation,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

const MAX_IDENTIFIER_LEN: usize = 96;
const MAX_CLOCK_SKEW_SECONDS: u64 = 120;
const MAX_REPLAY_ENTRIES: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorRole {
    ControlPlane,
    LocalAdministrator,
    HostService,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatedContext {
    pub request_id: String,
    pub installation_id: String,
    pub actor_id: String,
    pub actor_role: ActorRole,
    pub issued_at_unix_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "payload")]
pub enum OrchestrationCommand {
    ReadStatus,
    CertifyHost,
    SetMiningEnabled { enabled: bool },
    AcceptReservation { reservation: VerifiedReservation },
    ConfirmMiningStopped { process_exited: bool },
    ConfirmWorkspaceReady {
        isolation_verified: bool,
        gpu_attached_exclusively: bool,
        temporary_access_issued: bool,
    },
    FinishRental,
    ConfirmCleanup {
        workspace_destroyed: bool,
        access_revoked: bool,
        gpu_healthy: bool,
        storage_clean: bool,
        network_clean: bool,
    },
    EmergencyStop { all_processes_stopped: bool },
    ClearQuarantine { host_recertified: bool },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub snapshot: OrchestrationSnapshot,
}

#[derive(Debug, Default)]
struct ReplayGuard {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl ReplayGuard {
    fn accept(&mut self, request_id: &str) -> Result<(), &'static str> {
        if self.seen.contains(request_id) {
            return Err("orchestration_request_replayed");
        }
        self.seen.insert(request_id.to_owned());
        self.order.push_back(request_id.to_owned());
        while self.order.len() > MAX_REPLAY_ENTRIES {
            if let Some(expired) = self.order.pop_front() {
                self.seen.remove(&expired);
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct OrchestrationGateway {
    installation_id: String,
    orchestrator: RentalOrchestrator,
    replay_guard: ReplayGuard,
}

impl OrchestrationGateway {
    pub fn new(installation_id: String, machine_id: String) -> Result<Self, &'static str> {
        validate_identifier(&installation_id)?;
        Ok(Self {
            installation_id,
            orchestrator: RentalOrchestrator::new(machine_id)?,
            replay_guard: ReplayGuard::default(),
        })
    }

    pub fn execute(
        &mut self,
        context: AuthenticatedContext,
        command: OrchestrationCommand,
        now_unix_seconds: u64,
    ) -> Result<CommandResult, &'static str> {
        self.validate_context(&context, now_unix_seconds)?;
        authorize(context.actor_role, &command)?;
        self.replay_guard.accept(&context.request_id)?;

        match command {
            OrchestrationCommand::ReadStatus => {}
            OrchestrationCommand::CertifyHost => self.orchestrator.certify_host()?,
            OrchestrationCommand::SetMiningEnabled { enabled } => {
                self.orchestrator.set_mining_enabled(enabled)?
            }
            OrchestrationCommand::AcceptReservation { reservation } => {
                self.orchestrator
                    .accept_reservation(reservation, now_unix_seconds)?
            }
            OrchestrationCommand::ConfirmMiningStopped { process_exited } => {
                self.orchestrator.confirm_mining_stopped(process_exited)?
            }
            OrchestrationCommand::ConfirmWorkspaceReady {
                isolation_verified,
                gpu_attached_exclusively,
                temporary_access_issued,
            } => self.orchestrator.confirm_workspace_ready(
                isolation_verified,
                gpu_attached_exclusively,
                temporary_access_issued,
            )?,
            OrchestrationCommand::FinishRental => self.orchestrator.finish_rental()?,
            OrchestrationCommand::ConfirmCleanup {
                workspace_destroyed,
                access_revoked,
                gpu_healthy,
                storage_clean,
                network_clean,
            } => self.orchestrator.confirm_cleanup(
                workspace_destroyed,
                access_revoked,
                gpu_healthy,
                storage_clean,
                network_clean,
            )?,
            OrchestrationCommand::EmergencyStop {
                all_processes_stopped,
            } => self.orchestrator.emergency_stop(all_processes_stopped)?,
            OrchestrationCommand::ClearQuarantine { host_recertified } => self
                .orchestrator
                .clear_quarantine_after_local_review(host_recertified)?,
        }

        Ok(CommandResult {
            snapshot: self.orchestrator.snapshot(),
        })
    }

    fn validate_context(
        &self,
        context: &AuthenticatedContext,
        now_unix_seconds: u64,
    ) -> Result<(), &'static str> {
        validate_identifier(&context.request_id)?;
        validate_identifier(&context.installation_id)?;
        validate_identifier(&context.actor_id)?;
        if context.installation_id != self.installation_id {
            return Err("orchestration_installation_mismatch");
        }
        if now_unix_seconds.abs_diff(context.issued_at_unix_seconds) > MAX_CLOCK_SKEW_SECONDS {
            return Err("orchestration_request_expired");
        }
        Ok(())
    }
}

fn authorize(role: ActorRole, command: &OrchestrationCommand) -> Result<(), &'static str> {
    let allowed = match role {
        ActorRole::ControlPlane => matches!(
            command,
            OrchestrationCommand::ReadStatus
                | OrchestrationCommand::AcceptReservation { .. }
                | OrchestrationCommand::FinishRental
                | OrchestrationCommand::EmergencyStop { .. }
        ),
        ActorRole::LocalAdministrator => matches!(
            command,
            OrchestrationCommand::ReadStatus
                | OrchestrationCommand::CertifyHost
                | OrchestrationCommand::SetMiningEnabled { .. }
                | OrchestrationCommand::EmergencyStop { .. }
                | OrchestrationCommand::ClearQuarantine { .. }
        ),
        ActorRole::HostService => matches!(
            command,
            OrchestrationCommand::ReadStatus
                | OrchestrationCommand::ConfirmMiningStopped { .. }
                | OrchestrationCommand::ConfirmWorkspaceReady { .. }
                | OrchestrationCommand::ConfirmCleanup { .. }
                | OrchestrationCommand::EmergencyStop { .. }
        ),
    };
    allowed.then_some(()).ok_or("orchestration_command_forbidden")
}

fn validate_identifier(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("orchestration_invalid_identifier");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(role: ActorRole, request_id: &str) -> AuthenticatedContext {
        AuthenticatedContext {
            request_id: request_id.into(),
            installation_id: "install_001".into(),
            actor_id: "actor_001".into(),
            actor_role: role,
            issued_at_unix_seconds: 1_000,
        }
    }

    #[test]
    fn frontend_like_control_plane_cannot_certify_host() {
        let mut gateway = OrchestrationGateway::new(
            "install_001".into(),
            "machine_001".into(),
        )
        .unwrap();
        assert_eq!(
            gateway.execute(
                context(ActorRole::ControlPlane, "request_001"),
                OrchestrationCommand::CertifyHost,
                1_000,
            ),
            Err("orchestration_command_forbidden")
        );
    }

    #[test]
    fn replay_is_rejected_before_second_state_change() {
        let mut gateway = OrchestrationGateway::new(
            "install_001".into(),
            "machine_001".into(),
        )
        .unwrap();
        let ctx = context(ActorRole::LocalAdministrator, "request_001");
        gateway
            .execute(ctx.clone(), OrchestrationCommand::CertifyHost, 1_000)
            .unwrap();
        assert_eq!(
            gateway.execute(ctx, OrchestrationCommand::ReadStatus, 1_000),
            Err("orchestration_request_replayed")
        );
    }

    #[test]
    fn host_service_cannot_enable_mining() {
        let mut gateway = OrchestrationGateway::new(
            "install_001".into(),
            "machine_001".into(),
        )
        .unwrap();
        assert_eq!(
            gateway.execute(
                context(ActorRole::HostService, "request_001"),
                OrchestrationCommand::SetMiningEnabled { enabled: true },
                1_000,
            ),
            Err("orchestration_command_forbidden")
        );
    }
}
