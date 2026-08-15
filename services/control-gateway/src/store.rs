use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use ed25519_dalek::VerifyingKey;
use redis::{aio::MultiplexedConnection, AsyncCommands, Script};

use crate::protocol::{
    parse_agent_public_key_base58, validate_fencing_token, validate_id, CommandAckStatus,
    LeaseBinding, MachinePhase,
};

const DEFAULT_ACK_TTL_SECONDS: u64 = 24 * 60 * 60;

const CLAIM_PRESENCE_SCRIPT: &str = r#"
local previousFence = redis.call('HGET', KEYS[2], 'token') or '0'
local previousPhaseSequence = redis.call('HGET', KEYS[2], 'sequence') or '0'
redis.call('HSET', KEYS[1],
  'connectionId', ARGV[1],
  'gatewayId', ARGV[2],
  'region', ARGV[3],
  'sequence', '0',
  'phase', 'DRAINING',
  'phaseFenceToken', previousFence,
  'phaseSequence', previousPhaseSequence,
  'lastSeenAtMs', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
"#;

const TOUCH_PRESENCE_SCRIPT: &str = r#"
local currentConnection = redis.call('HGET', KEYS[1], 'connectionId')
if not currentConnection then
  return {0, 'MISSING', ''}
end
if currentConnection ~= ARGV[1] then
  local currentSequence = redis.call('HGET', KEYS[1], 'sequence') or ''
  return {0, 'STALE_CONNECTION', currentSequence}
end
local currentSequence = tonumber(redis.call('HGET', KEYS[1], 'sequence') or '0')
local nextSequence = tonumber(ARGV[2])
if not nextSequence or nextSequence <= currentSequence then
  return {0, 'STALE_SEQUENCE', tostring(currentSequence)}
end
redis.call('HSET', KEYS[1], 'sequence', ARGV[2], 'lastSeenAtMs', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return {1, 'OK', ARGV[2]}
"#;

const RELEASE_PRESENCE_SCRIPT: &str = r#"
local currentConnection = redis.call('HGET', KEYS[1], 'connectionId')
if not currentConnection or currentConnection ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
"#;

const SET_PHASE_SCRIPT: &str = r#"
local function cmpuint(a, b)
  a = string.gsub(a, '^0+', '')
  b = string.gsub(b, '^0+', '')
  if a == '' then a = '0' end
  if b == '' then b = '0' end
  if string.len(a) < string.len(b) then return -1 end
  if string.len(a) > string.len(b) then return 1 end
  if a < b then return -1 end
  if a > b then return 1 end
  return 0
end

local currentConnection = redis.call('HGET', KEYS[1], 'connectionId')
if not currentConnection then return {0, 'MISSING'} end
if currentConnection ~= ARGV[1] then return {0, 'STALE_CONNECTION'} end

local currentToken = redis.call('HGET', KEYS[2], 'token') or '0'
local currentSequence = redis.call('HGET', KEYS[2], 'sequence') or '0'
local currentPhase = redis.call('HGET', KEYS[2], 'phase') or ''
local tokenCmp = cmpuint(ARGV[2], currentToken)
if tokenCmp < 0 then return {0, 'STALE_FENCE'} end
if tokenCmp == 0 then
  local newSequence = tonumber(ARGV[3])
  local oldSequence = tonumber(currentSequence)
  if not newSequence or not oldSequence then return {0, 'INVALID_SEQUENCE'} end
  if newSequence < oldSequence then return {0, 'STALE_PHASE_SEQUENCE'} end
  if newSequence == oldSequence then
    if currentPhase == ARGV[4] then
      redis.call('HSET', KEYS[1],
        'phase', ARGV[4],
        'phaseFenceToken', ARGV[2],
        'phaseSequence', ARGV[3])
      return {2, 'EXISTING'}
    end
    return {0, 'PHASE_SEQUENCE_CONFLICT'}
  end
end

redis.call('HSET', KEYS[2], 'token', ARGV[2], 'sequence', ARGV[3], 'phase', ARGV[4])
redis.call('HSET', KEYS[1], 'phase', ARGV[4], 'phaseFenceToken', ARGV[2], 'phaseSequence', ARGV[3])
return {1, 'UPDATED'}
"#;

const RECORD_ACK_SCRIPT: &str = r#"
local currentConnection = redis.call('HGET', KEYS[1], 'connectionId')
if not currentConnection then
  return {0, 'MISSING_PRESENCE'}
end
if currentConnection ~= ARGV[1] then
  return {0, 'STALE_CONNECTION'}
end

local machineId = redis.call('HGET', KEYS[2], 'machineId')
local currentStatus = redis.call('HGET', KEYS[2], 'status') or ''
if machineId then
  local sequence = redis.call('HGET', KEYS[2], 'sequence') or ''
  if machineId ~= ARGV[2] or sequence ~= ARGV[3] then
    return {0, 'ACK_IDENTITY_CONFLICT'}
  end
  if currentStatus == ARGV[4] then
    redis.call('EXPIRE', KEYS[2], ARGV[7])
    return {2, 'EXISTING'}
  end
  if currentStatus ~= '' and currentStatus ~= 'ACCEPTED' then
    if ARGV[4] == 'ACCEPTED' then
      redis.call('EXPIRE', KEYS[2], ARGV[7])
      return {2, 'TERMINAL_EXISTS'}
    end
    return {0, 'ACK_TERMINAL_CONFLICT'}
  end
end
redis.call('HSET', KEYS[2],
  'machineId', ARGV[2],
  'sequence', ARGV[3],
  'status', ARGV[4],
  'detailCode', ARGV[5],
  'acknowledgedAtMs', ARGV[6])
redis.call('EXPIRE', KEYS[2], ARGV[7])
return {1, 'OK'}
"#;

#[derive(Clone)]
pub struct RedisStore {
    connection: MultiplexedConnection,
}

#[derive(Clone, Debug)]
pub struct PresenceLease {
    pub connection_id: String,
}

#[derive(Clone, Copy, Debug)]
pub struct CommandAckRecord<'a> {
    pub machine_id: &'a str,
    pub connection_id: &'a str,
    pub command_id: &'a str,
    pub sequence: u64,
    pub status: CommandAckStatus,
    pub detail_code: Option<&'a str>,
    pub acknowledged_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TouchOutcome {
    Accepted {
        sequence: u64,
    },
    Rejected {
        reason: String,
        current_sequence: Option<u64>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PhaseUpdateOutcome {
    Updated,
    Existing,
    Rejected(String),
}

impl RedisStore {
    pub async fn connect(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url).context("invalid control-gateway Redis URL")?;
        let connection = client
            .get_multiplexed_async_connection()
            .await
            .context("failed to connect control gateway to Redis")?;
        Ok(Self { connection })
    }

    pub async fn ping(&self) -> Result<()> {
        let mut connection = self.connection.clone();
        let pong: String = redis::cmd("PING")
            .query_async(&mut connection)
            .await
            .context("Redis PING failed")?;
        if pong != "PONG" {
            bail!("Redis returned unexpected PING response");
        }
        Ok(())
    }

    pub async fn resolve_machine_key(
        &self,
        machine_id: &str,
        key_version: u32,
    ) -> Result<VerifyingKey> {
        validate_id(machine_id, "machine_id")?;
        if key_version == 0 {
            bail!("key_version must be positive");
        }
        let mut connection = self.connection.clone();
        let fields: HashMap<String, String> = connection
            .hgetall(machine_auth_key(machine_id))
            .await
            .context("failed to read machine auth cache")?;
        if fields.is_empty() {
            bail!("machine auth cache miss");
        }
        if fields.get("status").map(String::as_str) != Some("ACTIVE") {
            bail!("machine auth cache is not active");
        }
        let cached_version = fields
            .get("keyVersion")
            .context("machine auth cache missing keyVersion")?
            .parse::<u32>()
            .context("machine auth keyVersion invalid")?;
        if cached_version != key_version {
            bail!("machine auth key version mismatch");
        }
        let public_key = fields
            .get("agentPublicKey")
            .context("machine auth cache missing agentPublicKey")?;
        parse_agent_public_key_base58(public_key)
    }

    pub async fn claim_presence(
        &self,
        machine_id: &str,
        gateway_id: &str,
        region: &str,
        now_ms: u64,
        ttl_seconds: u64,
    ) -> Result<PresenceLease> {
        validate_id(machine_id, "machine_id")?;
        validate_id(gateway_id, "gateway_id")?;
        let random: [u8; 18] = rand::random();
        let connection_id = format!("conn_{}", hex::encode(random));
        let mut connection = self.connection.clone();
        let result: i64 = Script::new(CLAIM_PRESENCE_SCRIPT)
            .key(machine_presence_key(machine_id))
            .key(machine_phase_fence_key(machine_id))
            .arg(&connection_id)
            .arg(gateway_id)
            .arg(region)
            .arg(now_ms.to_string())
            .arg(ttl_seconds.saturating_mul(1000).to_string())
            .invoke_async(&mut connection)
            .await
            .context("failed to claim machine presence")?;
        if result != 1 {
            bail!("Redis rejected machine presence claim");
        }
        Ok(PresenceLease { connection_id })
    }

    pub async fn touch_presence(
        &self,
        machine_id: &str,
        connection_id: &str,
        sequence: u64,
        now_ms: u64,
        ttl_seconds: u64,
    ) -> Result<TouchOutcome> {
        validate_id(machine_id, "machine_id")?;
        validate_id(connection_id, "connection_id")?;
        if sequence == 0 {
            bail!("heartbeat sequence must be positive");
        }
        let mut connection = self.connection.clone();
        let result: (i64, String, String) = Script::new(TOUCH_PRESENCE_SCRIPT)
            .key(machine_presence_key(machine_id))
            .arg(connection_id)
            .arg(sequence.to_string())
            .arg(now_ms.to_string())
            .arg(ttl_seconds.saturating_mul(1000).to_string())
            .invoke_async(&mut connection)
            .await
            .context("failed to touch machine presence")?;
        if result.0 == 1 {
            let accepted_sequence = result
                .2
                .parse::<u64>()
                .context("Redis returned invalid presence sequence")?;
            return Ok(TouchOutcome::Accepted {
                sequence: accepted_sequence,
            });
        }
        let current_sequence = if result.2.is_empty() {
            None
        } else {
            Some(
                result
                    .2
                    .parse::<u64>()
                    .context("Redis returned invalid current presence sequence")?,
            )
        };
        Ok(TouchOutcome::Rejected {
            reason: result.1,
            current_sequence,
        })
    }

    pub async fn release_presence(&self, machine_id: &str, connection_id: &str) -> Result<bool> {
        validate_id(machine_id, "machine_id")?;
        validate_id(connection_id, "connection_id")?;
        let mut connection = self.connection.clone();
        let deleted: i64 = Script::new(RELEASE_PRESENCE_SCRIPT)
            .key(machine_presence_key(machine_id))
            .arg(connection_id)
            .invoke_async(&mut connection)
            .await
            .context("failed to release machine presence")?;
        Ok(deleted == 1)
    }

    pub async fn set_authoritative_phase(
        &self,
        machine_id: &str,
        connection_id: &str,
        fencing_token: &str,
        phase_sequence: u64,
        phase: MachinePhase,
    ) -> Result<PhaseUpdateOutcome> {
        validate_id(machine_id, "machine_id")?;
        validate_id(connection_id, "connection_id")?;
        validate_fencing_token(fencing_token)?;
        if phase_sequence == 0 {
            bail!("phase sequence must be positive");
        }
        let mut connection = self.connection.clone();
        let result: (i64, String) = Script::new(SET_PHASE_SCRIPT)
            .key(machine_presence_key(machine_id))
            .key(machine_phase_fence_key(machine_id))
            .arg(connection_id)
            .arg(fencing_token)
            .arg(phase_sequence.to_string())
            .arg(phase.as_str())
            .invoke_async(&mut connection)
            .await
            .context("failed to update authoritative machine phase")?;
        match result.0 {
            1 => Ok(PhaseUpdateOutcome::Updated),
            2 => Ok(PhaseUpdateOutcome::Existing),
            _ => Ok(PhaseUpdateOutcome::Rejected(result.1)),
        }
    }

    pub async fn assert_active_lease(&self, lease: &LeaseBinding) -> Result<()> {
        lease.validate()?;
        let mut connection = self.connection.clone();
        let key = resource_lease_key(&lease.resource_id);
        let fields: HashMap<String, String> = connection
            .hgetall(&key)
            .await
            .context("failed to read active resource lease")?;
        let ttl_ms: i64 = connection
            .pttl(&key)
            .await
            .context("failed to read resource lease TTL")?;
        if ttl_ms <= 0 {
            bail!("resource lease missing or expired");
        }
        if fields.get("leaseId") != Some(&lease.lease_id)
            || fields.get("holderId") != Some(&lease.holder_id)
            || fields.get("fencingToken") != Some(&lease.fencing_token)
        {
            bail!("resource lease identity/fence mismatch");
        }
        Ok(())
    }

    pub async fn record_command_ack(&self, record: CommandAckRecord<'_>) -> Result<()> {
        validate_id(record.machine_id, "machine_id")?;
        validate_id(record.connection_id, "connection_id")?;
        validate_id(record.command_id, "command_id")?;
        if record.sequence == 0 {
            bail!("command ack sequence must be positive");
        }
        let status = format!("{:?}", record.status).to_ascii_uppercase();
        let detail_code = record.detail_code.unwrap_or("");
        let mut connection = self.connection.clone();
        let result: (i64, String) = Script::new(RECORD_ACK_SCRIPT)
            .key(machine_presence_key(record.machine_id))
            .key(command_ack_key(record.machine_id, record.command_id))
            .arg(record.connection_id)
            .arg(record.machine_id)
            .arg(record.sequence.to_string())
            .arg(status)
            .arg(detail_code)
            .arg(record.acknowledged_at_ms.to_string())
            .arg(DEFAULT_ACK_TTL_SECONDS.to_string())
            .invoke_async(&mut connection)
            .await
            .context("failed to persist command acknowledgement")?;
        if result.0 != 1 && result.0 != 2 {
            bail!("command acknowledgement rejected: {}", result.1);
        }
        Ok(())
    }
}

pub fn machine_presence_key(machine_id: &str) -> String {
    format!("gpubnb:machine-presence:{{{machine_id}}}:v1")
}

pub fn machine_phase_fence_key(machine_id: &str) -> String {
    format!("gpubnb:machine-phase-fence:{{{machine_id}}}:v1")
}

pub fn machine_auth_key(machine_id: &str) -> String {
    format!("gpubnb:machine-auth:{{{machine_id}}}:v1")
}

pub fn resource_lease_key(resource_id: &str) -> String {
    format!("gpubnb:resource-lease:{{{resource_id}}}:v1")
}

pub fn command_ack_key(machine_id: &str, command_id: &str) -> String {
    format!("gpubnb:command-ack:{{{machine_id}}}:{command_id}:v1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_multi_key_machine_scripts_are_cluster_slot_safe() {
        assert_eq!(
            hash_tag(&machine_presence_key("machine_00000001")),
            Some("machine_00000001")
        );
        assert_eq!(
            hash_tag(&machine_phase_fence_key("machine_00000001")),
            Some("machine_00000001")
        );
        assert_eq!(
            hash_tag(&command_ack_key("machine_00000001", "command_00000001")),
            Some("machine_00000001")
        );
    }

    #[test]
    fn ack_keys_are_isolated_per_command_and_machine() {
        assert_ne!(
            command_ack_key("machine_00000001", "command_00000001"),
            command_ack_key("machine_00000001", "command_00000002")
        );
        assert_ne!(
            command_ack_key("machine_00000001", "command_00000001"),
            command_ack_key("machine_00000002", "command_00000001")
        );
    }

    fn hash_tag(key: &str) -> Option<&str> {
        let start = key.find('{')? + 1;
        let end = key[start..].find('}')? + start;
        Some(&key[start..end])
    }
}
