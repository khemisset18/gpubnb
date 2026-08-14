use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::CONTROL_GATEWAY_PROTOCOL_VERSION;

pub const AUTH_DOMAIN: &str = "gpubnb-control-gateway-auth-v1";
pub const MAX_COMMAND_PAYLOAD_BYTES: usize = 48 * 1024;
pub const MAX_COMMAND_LIFETIME_MS: u64 = 15 * 60 * 1000;
pub const MAX_AGENT_CLOCK_SKEW_MS: u64 = 2 * 60 * 1000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MachinePhase {
    Available,
    Mining,
    Reserved,
    Preparing,
    Rented,
    Draining,
    Quarantined,
}

impl MachinePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "AVAILABLE",
            Self::Mining => "MINING",
            Self::Reserved => "RESERVED",
            Self::Preparing => "PREPARING",
            Self::Rented => "RENTED",
            Self::Draining => "DRAINING",
            Self::Quarantined => "QUARANTINED",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol_version: u16,
    pub machine_id: String,
    pub key_version: u32,
    pub issued_at_ms: u64,
    pub nonce: String,
    pub last_acked_command_sequence: u64,
    pub signature_hex: String,
}

impl ClientHello {
    pub fn validate(&self, now_ms: u64, allowed_skew_ms: u64) -> Result<()> {
        if self.protocol_version != CONTROL_GATEWAY_PROTOCOL_VERSION {
            bail!("unsupported control-gateway protocol version");
        }
        validate_id(&self.machine_id, "machine_id")?;
        if self.key_version == 0 {
            bail!("key_version must be positive");
        }
        validate_nonce(&self.nonce)?;
        if self.signature_hex.len() != 128
            || !self.signature_hex.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("signature_hex must be a 64-byte Ed25519 signature");
        }
        let delta = now_ms.abs_diff(self.issued_at_ms);
        if delta > allowed_skew_ms {
            bail!("client hello timestamp outside allowed clock skew");
        }
        Ok(())
    }

    pub fn signing_bytes(&self) -> Vec<u8> {
        format!(
            "{AUTH_DOMAIN}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.protocol_version,
            self.machine_id,
            self.key_version,
            self.issued_at_ms,
            self.nonce,
            self.last_acked_command_sequence,
        )
        .into_bytes()
    }

    pub fn verify(&self, key: &VerifyingKey) -> Result<()> {
        let raw = hex::decode(&self.signature_hex).context("invalid signature hex")?;
        let signature = Signature::from_slice(&raw).context("invalid Ed25519 signature bytes")?;
        key.verify(&self.signing_bytes(), &signature)
            .context("client hello signature verification failed")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServerHello {
    pub protocol_version: u16,
    pub gateway_id: String,
    pub region: String,
    pub connection_id: String,
    pub presence_ttl_seconds: u64,
    pub heartbeat_timeout_seconds: u64,
    pub resumed_after_command_sequence: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommandKind {
    PrepareRental,
    StartRental,
    StopRental,
    StartMining,
    StopMining,
    RefreshInventory,
    RunDiagnostic,
    Quarantine,
}

impl CommandKind {
    pub fn requires_active_lease(self) -> bool {
        matches!(self, Self::PrepareRental | Self::StartRental)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LeaseBinding {
    pub resource_id: String,
    pub holder_id: String,
    pub lease_id: String,
    pub fencing_token: String,
}

impl LeaseBinding {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.resource_id, "resource_id")?;
        validate_id(&self.holder_id, "holder_id")?;
        validate_id(&self.lease_id, "lease_id")?;
        validate_fencing_token(&self.fencing_token)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommandEnvelope {
    pub protocol_version: u16,
    pub command_id: String,
    pub machine_id: String,
    pub sequence: u64,
    pub kind: CommandKind,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeaseBinding>,
    pub payload: Value,
}

impl CommandEnvelope {
    pub fn validate(&self, now_ms: u64) -> Result<()> {
        if self.protocol_version != CONTROL_GATEWAY_PROTOCOL_VERSION {
            bail!("unsupported command protocol version");
        }
        validate_id(&self.command_id, "command_id")?;
        validate_id(&self.machine_id, "machine_id")?;
        if self.sequence == 0 {
            bail!("command sequence must be positive");
        }
        if self.expires_at_ms <= self.issued_at_ms {
            bail!("command expiry must be after issue time");
        }
        if self.expires_at_ms - self.issued_at_ms > MAX_COMMAND_LIFETIME_MS {
            bail!("command lifetime exceeds hard bound");
        }
        if self.issued_at_ms > now_ms.saturating_add(MAX_AGENT_CLOCK_SKEW_MS) {
            bail!("command issue time is too far in the future");
        }
        if now_ms >= self.expires_at_ms {
            bail!("command already expired");
        }
        let payload_size = serde_json::to_vec(&self.payload)
            .context("failed to encode command payload")?
            .len();
        if payload_size > MAX_COMMAND_PAYLOAD_BYTES {
            bail!("command payload exceeds hard bound");
        }
        if let Some(lease) = &self.lease {
            lease.validate()?;
        }
        if self.kind.requires_active_lease() && self.lease.is_none() {
            bail!("command kind requires an active resource lease");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommandAckStatus {
    Accepted,
    Succeeded,
    Failed,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentMessage {
    Heartbeat {
        sequence: u64,
        observed_at_ms: u64,
    },
    CommandAck {
        command_id: String,
        sequence: u64,
        status: CommandAckStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail_code: Option<String>,
    },
}

impl AgentMessage {
    pub fn validate(&self, now_ms: u64) -> Result<()> {
        match self {
            Self::Heartbeat {
                sequence,
                observed_at_ms,
            } => {
                if *sequence == 0 {
                    bail!("heartbeat sequence must be positive");
                }
                if now_ms.abs_diff(*observed_at_ms) > MAX_AGENT_CLOCK_SKEW_MS {
                    bail!("heartbeat timestamp outside allowed skew");
                }
            }
            Self::CommandAck {
                command_id,
                sequence,
                detail_code,
                ..
            } => {
                validate_id(command_id, "command_id")?;
                if *sequence == 0 {
                    bail!("command ack sequence must be positive");
                }
                if let Some(detail) = detail_code {
                    if detail.is_empty()
                        || detail.len() > 96
                        || !detail.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric()
                                || matches!(byte, b'_' | b'-' | b'.' | b':')
                        })
                    {
                        bail!("command ack detail_code invalid");
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FenceReason {
    ReplacedConnection,
    PresenceOwnershipLost,
    GatewayDraining,
    ProtocolViolation,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GatewayMessage {
    ServerHello { hello: ServerHello },
    Command { command: CommandEnvelope },
    AckReceipt { command_id: String, sequence: u64 },
    Fence { reason: FenceReason },
}

pub fn parse_agent_public_key_base58(value: &str) -> Result<VerifyingKey> {
    if !(32..=64).contains(&value.len()) {
        bail!("agent public key length invalid");
    }
    let decoded = bs58::decode(value)
        .into_vec()
        .context("agent public key is not valid base58")?;
    let bytes: [u8; 32] = decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("agent public key must decode to 32 bytes"))?;
    VerifyingKey::from_bytes(&bytes).context("agent public key is not a valid Ed25519 key")
}

pub fn validate_id(value: &str, field: &str) -> Result<()> {
    if !(8..=160).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':' | b'.'))
    {
        bail!("{field} invalid");
    }
    Ok(())
}

pub fn validate_region(value: &str) -> Result<()> {
    if !(2..=32).contains(&value.len())
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
    {
        bail!("region invalid");
    }
    Ok(())
}

pub fn validate_fencing_token(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        bail!("fencing token invalid");
    }
    let parsed = value.parse::<u64>().context("fencing token invalid")?;
    if parsed == 0 || parsed > i64::MAX as u64 {
        bail!("fencing token invalid");
    }
    Ok(())
}

fn validate_nonce(value: &str) -> Result<()> {
    if !(32..=128).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("nonce invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn hello_signature_is_domain_separated_and_bound_to_resume_sequence() {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let mut hello = ClientHello {
            protocol_version: CONTROL_GATEWAY_PROTOCOL_VERSION,
            machine_id: "machine_00000001".into(),
            key_version: 1,
            issued_at_ms: 1_000_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
            last_acked_command_sequence: 41,
            signature_hex: String::new(),
        };
        hello.signature_hex = hex::encode(signing.sign(&hello.signing_bytes()).to_bytes());
        hello.validate(1_000_010, 30_000).unwrap();
        hello.verify(&signing.verifying_key()).unwrap();

        hello.last_acked_command_sequence = 42;
        assert!(hello.verify(&signing.verifying_key()).is_err());
    }

    #[test]
    fn mutable_rental_commands_require_a_fenced_lease() {
        let command = CommandEnvelope {
            protocol_version: CONTROL_GATEWAY_PROTOCOL_VERSION,
            command_id: "command_00000001".into(),
            machine_id: "machine_00000001".into(),
            sequence: 1,
            kind: CommandKind::PrepareRental,
            issued_at_ms: 10_000,
            expires_at_ms: 20_000,
            lease: None,
            payload: Value::Null,
        };
        assert!(command.validate(11_000).is_err());
    }

    #[test]
    fn fencing_tokens_are_exact_integers_not_floats() {
        assert!(validate_fencing_token("9223372036854775807").is_ok());
        assert!(validate_fencing_token("9223372036854775808").is_err());
        assert!(validate_fencing_token("01").is_err());
        assert!(validate_fencing_token("1e3").is_err());
    }
}
