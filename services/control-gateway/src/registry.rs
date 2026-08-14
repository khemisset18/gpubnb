use std::collections::{HashMap, VecDeque};

use anyhow::{bail, Result};
use tokio::sync::mpsc;

use crate::protocol::{CommandAckStatus, CommandEnvelope, GatewayMessage, MachinePhase};

#[derive(Clone, Copy, Debug)]
pub struct RegistryLimits {
    pub max_connections: usize,
    pub max_pending_commands_per_machine: usize,
    pub command_retention_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RegistryStats {
    pub active_connections: usize,
    pub pending_commands: usize,
    pub machine_slots: usize,
    pub draining: bool,
}

#[derive(Debug)]
struct ConnectionState {
    connection_id: String,
    sender: mpsc::Sender<GatewayMessage>,
    last_acked_sequence: u64,
}

#[derive(Debug)]
struct MachineState {
    connection: Option<ConnectionState>,
    journal: VecDeque<CommandEnvelope>,
    highest_sequence_seen: u64,
    phase: MachinePhase,
}

impl Default for MachineState {
    fn default() -> Self {
        Self {
            connection: None,
            journal: VecDeque::new(),
            highest_sequence_seen: 0,
            phase: MachinePhase::Draining,
        }
    }
}

#[derive(Debug)]
pub struct RegisterOutcome {
    pub replaced_sender: Option<mpsc::Sender<GatewayMessage>>,
    pub replay: Vec<CommandEnvelope>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchStatus {
    Delivered,
    QueuedDisconnected,
    QueuedBackpressure,
    Existing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DispatchOutcome {
    pub status: DispatchStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AckOutcome {
    Recorded,
    TerminalRecorded,
    DuplicateTerminal,
}

#[derive(Debug)]
pub struct GatewayRegistry {
    limits: RegistryLimits,
    draining: bool,
    machines: HashMap<String, MachineState>,
    active_connections: usize,
    pending_commands: usize,
}

impl GatewayRegistry {
    pub fn new(limits: RegistryLimits) -> Self {
        Self {
            limits,
            draining: false,
            machines: HashMap::new(),
            active_connections: 0,
            pending_commands: 0,
        }
    }

    pub fn set_draining(&mut self, draining: bool) {
        self.draining = draining;
    }

    pub fn register(
        &mut self,
        machine_id: &str,
        connection_id: String,
        sender: mpsc::Sender<GatewayMessage>,
        last_acked_sequence: u64,
        now_ms: u64,
    ) -> Result<RegisterOutcome> {
        if self.draining {
            bail!("gateway_draining");
        }
        let has_live_connection = self
            .machines
            .get(machine_id)
            .and_then(|state| state.connection.as_ref())
            .is_some();
        if !has_live_connection && self.active_connections >= self.limits.max_connections {
            bail!("gateway_connection_capacity");
        }

        self.prune_expired(machine_id, now_ms);
        let state = self.machines.entry(machine_id.to_owned()).or_default();
        let replaced_sender = state.connection.take().map(|connection| connection.sender);
        if replaced_sender.is_none() {
            self.active_connections += 1;
        }
        state.phase = MachinePhase::Draining;
        state.highest_sequence_seen = state.highest_sequence_seen.max(last_acked_sequence);
        state.connection = Some(ConnectionState {
            connection_id,
            sender,
            last_acked_sequence,
        });

        let removed = prune_acked(&mut state.journal, last_acked_sequence);
        self.pending_commands = self.pending_commands.saturating_sub(removed);
        let replay = state.journal.iter().cloned().collect();
        Ok(RegisterOutcome {
            replaced_sender,
            replay,
        })
    }

    pub fn unregister(&mut self, machine_id: &str, connection_id: &str) -> bool {
        let Some(state) = self.machines.get_mut(machine_id) else {
            return false;
        };
        let matches = state
            .connection
            .as_ref()
            .is_some_and(|connection| connection.connection_id == connection_id);
        if !matches {
            return false;
        }
        state.connection = None;
        state.phase = MachinePhase::Draining;
        self.active_connections = self.active_connections.saturating_sub(1);
        true
    }

    pub fn dispatch(&mut self, command: CommandEnvelope, now_ms: u64) -> Result<DispatchOutcome> {
        command.validate(now_ms)?;
        self.prune_expired(&command.machine_id, now_ms);
        let state = self.machines.entry(command.machine_id.clone()).or_default();

        if let Some(existing) = state
            .journal
            .iter()
            .find(|existing| existing.command_id == command.command_id)
        {
            if existing == &command {
                return Ok(DispatchOutcome {
                    status: DispatchStatus::Existing,
                });
            }
            bail!("command_id_conflict");
        }
        if command.sequence <= state.highest_sequence_seen {
            bail!("command_sequence_not_monotonic");
        }
        if state.journal.len() >= self.limits.max_pending_commands_per_machine {
            bail!("command_journal_capacity");
        }

        state.highest_sequence_seen = command.sequence;
        state.journal.push_back(command.clone());
        self.pending_commands += 1;

        let status = match state.connection.as_ref() {
            None => DispatchStatus::QueuedDisconnected,
            Some(connection) => match connection.sender.try_send(GatewayMessage::Command { command }) {
                Ok(()) => DispatchStatus::Delivered,
                Err(mpsc::error::TrySendError::Full(_)) => DispatchStatus::QueuedBackpressure,
                Err(mpsc::error::TrySendError::Closed(_)) => DispatchStatus::QueuedDisconnected,
            },
        };
        Ok(DispatchOutcome { status })
    }

    pub fn acknowledge(
        &mut self,
        machine_id: &str,
        command_id: &str,
        sequence: u64,
        status: CommandAckStatus,
    ) -> Result<AckOutcome> {
        let state = self
            .machines
            .get_mut(machine_id)
            .ok_or_else(|| anyhow::anyhow!("unknown_machine_command_journal"))?;

        if state
            .connection
            .as_ref()
            .is_some_and(|connection| sequence <= connection.last_acked_sequence)
            && !state.journal.iter().any(|entry| entry.sequence == sequence)
        {
            return Ok(AckOutcome::DuplicateTerminal);
        }

        let entry = state
            .journal
            .iter()
            .find(|entry| entry.command_id == command_id)
            .ok_or_else(|| anyhow::anyhow!("unknown_command_ack"))?;
        if entry.sequence != sequence {
            bail!("command_ack_sequence_mismatch");
        }

        if matches!(status, CommandAckStatus::Accepted) {
            return Ok(AckOutcome::Recorded);
        }

        let front_sequence = state
            .journal
            .front()
            .map(|entry| entry.sequence)
            .ok_or_else(|| anyhow::anyhow!("unknown_command_ack"))?;
        if sequence != front_sequence {
            bail!("terminal_command_ack_out_of_order");
        }

        state.journal.pop_front();
        self.pending_commands = self.pending_commands.saturating_sub(1);
        if let Some(connection) = state.connection.as_mut() {
            connection.last_acked_sequence = connection.last_acked_sequence.max(sequence);
        }
        Ok(AckOutcome::TerminalRecorded)
    }

    pub fn set_phase(&mut self, machine_id: &str, phase: MachinePhase) -> Result<()> {
        let state = self
            .machines
            .get_mut(machine_id)
            .ok_or_else(|| anyhow::anyhow!("machine_not_connected"))?;
        if state.connection.is_none() {
            bail!("machine_not_connected");
        }
        state.phase = phase;
        Ok(())
    }

    pub fn phase(&self, machine_id: &str) -> Option<MachinePhase> {
        self.machines.get(machine_id).map(|state| state.phase)
    }

    pub fn stats(&self) -> RegistryStats {
        RegistryStats {
            active_connections: self.active_connections,
            pending_commands: self.pending_commands,
            machine_slots: self.machines.len(),
            draining: self.draining,
        }
    }

    fn prune_expired(&mut self, machine_id: &str, now_ms: u64) {
        let Some(state) = self.machines.get_mut(machine_id) else {
            return;
        };
        let before = state.journal.len();
        state.journal.retain(|entry| {
            now_ms < entry.expires_at_ms
                && now_ms.saturating_sub(entry.issued_at_ms) <= self.limits.command_retention_ms
        });
        let removed = before.saturating_sub(state.journal.len());
        self.pending_commands = self.pending_commands.saturating_sub(removed);
    }
}

fn prune_acked(journal: &mut VecDeque<CommandEnvelope>, last_acked_sequence: u64) -> usize {
    let before = journal.len();
    while journal
        .front()
        .is_some_and(|entry| entry.sequence <= last_acked_sequence)
    {
        journal.pop_front();
    }
    before.saturating_sub(journal.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{protocol::{CommandKind, LeaseBinding}, CONTROL_GATEWAY_PROTOCOL_VERSION};
    use serde_json::json;

    fn command(id: &str, sequence: u64) -> CommandEnvelope {
        CommandEnvelope {
            protocol_version: CONTROL_GATEWAY_PROTOCOL_VERSION,
            command_id: id.into(),
            machine_id: "machine_00000001".into(),
            sequence,
            kind: CommandKind::PrepareRental,
            issued_at_ms: 1_000,
            expires_at_ms: 60_000,
            lease: Some(LeaseBinding {
                resource_id: "resource_00000001".into(),
                holder_id: "booking_00000001".into(),
                lease_id: "lease_000000001".into(),
                fencing_token: "7".into(),
            }),
            payload: json!({"workspace":"developer"}),
        }
    }

    fn registry() -> GatewayRegistry {
        GatewayRegistry::new(RegistryLimits {
            max_connections: 2,
            max_pending_commands_per_machine: 4,
            command_retention_ms: 300_000,
        })
    }

    #[test]
    fn newer_connection_replaces_old_without_consuming_extra_capacity() {
        let mut registry = registry();
        let (tx1, _rx1) = mpsc::channel(2);
        registry
            .register("machine_00000001", "conn_00000001".into(), tx1, 0, 1_000)
            .unwrap();
        let (tx2, _rx2) = mpsc::channel(2);
        let outcome = registry
            .register("machine_00000001", "conn_00000002".into(), tx2, 0, 1_001)
            .unwrap();
        assert!(outcome.replaced_sender.is_some());
        assert_eq!(registry.stats().active_connections, 1);
    }

    #[test]
    fn disconnected_commands_are_journaled_and_replayed_after_resume() {
        let mut registry = registry();
        assert_eq!(
            registry.dispatch(command("command_00000001", 1), 2_000).unwrap().status,
            DispatchStatus::QueuedDisconnected
        );
        let (tx, _rx) = mpsc::channel(2);
        let outcome = registry
            .register("machine_00000001", "conn_00000001".into(), tx, 0, 2_001)
            .unwrap();
        assert_eq!(outcome.replay.len(), 1);
        assert_eq!(outcome.replay[0].sequence, 1);
    }

    #[test]
    fn terminal_acks_are_ordered_and_prune_only_completed_commands() {
        let mut registry = registry();
        registry.dispatch(command("command_00000001", 1), 2_000).unwrap();
        registry.dispatch(command("command_00000002", 2), 2_001).unwrap();
        assert!(registry
            .acknowledge(
                "machine_00000001",
                "command_00000002",
                2,
                CommandAckStatus::Succeeded,
            )
            .is_err());
        assert_eq!(
            registry
                .acknowledge(
                    "machine_00000001",
                    "command_00000001",
                    1,
                    CommandAckStatus::Accepted,
                )
                .unwrap(),
            AckOutcome::Recorded
        );
        assert_eq!(registry.stats().pending_commands, 2);
        registry
            .acknowledge(
                "machine_00000001",
                "command_00000001",
                1,
                CommandAckStatus::Succeeded,
            )
            .unwrap();
        assert_eq!(registry.stats().pending_commands, 1);
    }
}
