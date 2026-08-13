use anyhow::{anyhow, bail, Context, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use gpubnb_edge_core::{SessionBinding, PROTOCOL_VERSION};

const MAX_AUTHORITY_BYTES: usize = 16 * 1024;
const MAX_AUTHORITY_TTL_MS: u64 = 60_000;
const AUTHORITY_NONCE_HEX_LEN: usize = 64;
const MAX_IDENTIFIER_BYTES: usize = 160;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthorityRole {
    Host,
    Renter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WireSessionBinding {
    pub protocol_version: u16,
    pub session_id: String,
    pub machine_id: String,
    pub booking_id: String,
    pub renter_user_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthorityEnvelope {
    pub edge_id: String,
    pub role: AuthorityRole,
    pub binding: WireSessionBinding,
    pub signature_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityClaims<'a> {
    edge_id: &'a str,
    role: AuthorityRole,
    binding: &'a WireSessionBinding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAuthority {
    pub role: AuthorityRole,
    pub binding: SessionBinding,
}

impl From<WireSessionBinding> for SessionBinding {
    fn from(value: WireSessionBinding) -> Self {
        Self {
            protocol_version: value.protocol_version,
            session_id: value.session_id,
            machine_id: value.machine_id,
            booking_id: value.booking_id,
            renter_user_id: value.renter_user_id,
            issued_at_ms: value.issued_at_ms,
            expires_at_ms: value.expires_at_ms,
            nonce: value.nonce,
        }
    }
}

pub fn parse_verifying_key_hex(raw: &str) -> Result<VerifyingKey> {
    let decoded = hex::decode(raw.trim()).context("invalid Ed25519 public-key hex")?;
    let bytes: [u8; 32] = decoded
        .try_into()
        .map_err(|_| anyhow!("Ed25519 public key must be exactly 32 bytes"))?;
    VerifyingKey::from_bytes(&bytes).context("invalid Ed25519 public key")
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn validate_edge_id(edge_id: &str) -> Result<()> {
    if !valid_identifier(edge_id) {
        bail!("edge id must contain only ASCII alphanumeric, underscore or hyphen characters");
    }
    Ok(())
}

pub fn canonical_authority_claims_bytes(
    edge_id: &str,
    role: AuthorityRole,
    binding: &WireSessionBinding,
) -> Result<Vec<u8>> {
    serde_json::to_vec(&AuthorityClaims {
        edge_id,
        role,
        binding,
    })
    .context("failed to canonicalize authority claims")
}

fn validate_authority_contract(edge_id: &str, binding: &WireSessionBinding) -> Result<()> {
    validate_edge_id(edge_id)?;
    if binding.protocol_version != PROTOCOL_VERSION {
        bail!("authority protocol version mismatch");
    }
    for (name, value) in [
        ("session", binding.session_id.as_str()),
        ("machine", binding.machine_id.as_str()),
        ("booking", binding.booking_id.as_str()),
        ("renter", binding.renter_user_id.as_str()),
    ] {
        if !valid_identifier(value) {
            bail!("authority {name} identifier invalid");
        }
    }
    if binding.expires_at_ms <= binding.issued_at_ms {
        bail!("authority expiry must be after issuance");
    }
    if binding.expires_at_ms - binding.issued_at_ms > MAX_AUTHORITY_TTL_MS {
        bail!("authority lifetime exceeds protocol maximum");
    }
    if binding.nonce.len() != AUTHORITY_NONCE_HEX_LEN
        || !binding.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("authority nonce must be exactly 32 bytes encoded as hexadecimal");
    }
    Ok(())
}

pub fn verify_authority(
    raw: &[u8],
    key: &VerifyingKey,
    expected_edge_id: &str,
    now_ms: u64,
) -> Result<VerifiedAuthority> {
    if raw.is_empty() || raw.len() > MAX_AUTHORITY_BYTES {
        bail!("authority envelope size invalid");
    }
    validate_edge_id(expected_edge_id).context("configured Edge id invalid")?;

    let envelope: AuthorityEnvelope =
        serde_json::from_slice(raw).context("invalid authority envelope JSON")?;
    validate_authority_contract(&envelope.edge_id, &envelope.binding)?;
    if envelope.edge_id != expected_edge_id {
        bail!("authority is scoped to a different Edge");
    }

    let signature_bytes =
        hex::decode(&envelope.signature_hex).context("invalid authority signature hex")?;
    let signature =
        Signature::from_slice(&signature_bytes).context("invalid authority signature")?;
    let message = canonical_authority_claims_bytes(
        &envelope.edge_id,
        envelope.role,
        &envelope.binding,
    )?;
    key.verify(&message, &signature)
        .context("authority signature verification failed")?;

    if now_ms < envelope.binding.issued_at_ms.saturating_sub(30_000)
        || now_ms >= envelope.binding.expires_at_ms
    {
        bail!("authority is not current");
    }

    Ok(VerifiedAuthority {
        role: envelope.role,
        binding: envelope.binding.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const EDGE_ID: &str = "edge_paris_1";

    fn binding() -> WireSessionBinding {
        WireSessionBinding {
            protocol_version: PROTOCOL_VERSION,
            session_id: "session_1".into(),
            machine_id: "machine_1".into(),
            booking_id: "booking_1".into(),
            renter_user_id: "user_1".into(),
            issued_at_ms: 1_000_000,
            expires_at_ms: 1_060_000,
            nonce: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        }
    }

    fn signed_envelope(
        signing: &SigningKey,
        edge_id: &str,
        role: AuthorityRole,
        binding: WireSessionBinding,
    ) -> Vec<u8> {
        let message = canonical_authority_claims_bytes(edge_id, role, &binding).unwrap();
        let signature = signing.sign(&message);
        serde_json::to_vec(&AuthorityEnvelope {
            edge_id: edge_id.into(),
            role,
            binding,
            signature_hex: hex::encode(signature.to_bytes()),
        })
        .unwrap()
    }

    #[test]
    fn valid_authority_verifies_and_preserves_scope_and_role() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let raw = signed_envelope(&signing, EDGE_ID, AuthorityRole::Renter, binding());
        let verified =
            verify_authority(&raw, &signing.verifying_key(), EDGE_ID, 1_020_000).unwrap();
        assert_eq!(verified.role, AuthorityRole::Renter);
        assert_eq!(verified.binding.session_id, "session_1");
        assert_eq!(verified.binding.machine_id, "machine_1");
        assert_eq!(verified.binding.booking_id, "booking_1");
        assert_eq!(verified.binding.renter_user_id, "user_1");
    }

    #[test]
    fn authority_for_another_edge_is_rejected_even_with_a_valid_signature() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let raw = signed_envelope(&signing, EDGE_ID, AuthorityRole::Renter, binding());
        assert!(
            verify_authority(&raw, &signing.verifying_key(), "edge_london_1", 1_020_000).is_err()
        );
    }

    #[test]
    fn tampering_edge_role_or_binding_invalidates_the_signature() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let raw = signed_envelope(&signing, EDGE_ID, AuthorityRole::Renter, binding());
        let mut envelope: AuthorityEnvelope = serde_json::from_slice(&raw).unwrap();
        envelope.binding.machine_id = "machine_attacker".into();
        let tampered = serde_json::to_vec(&envelope).unwrap();
        assert!(verify_authority(&tampered, &signing.verifying_key(), EDGE_ID, 1_020_000).is_err());

        let mut envelope: AuthorityEnvelope = serde_json::from_slice(&raw).unwrap();
        envelope.edge_id = "edge_london_1".into();
        let tampered = serde_json::to_vec(&envelope).unwrap();
        assert!(verify_authority(
            &tampered,
            &signing.verifying_key(),
            "edge_london_1",
            1_020_000
        )
        .is_err());

        let mut envelope: AuthorityEnvelope = serde_json::from_slice(&raw).unwrap();
        envelope.role = AuthorityRole::Host;
        let tampered = serde_json::to_vec(&envelope).unwrap();
        assert!(verify_authority(&tampered, &signing.verifying_key(), EDGE_ID, 1_020_000).is_err());
    }

    #[test]
    fn expired_authority_is_rejected_even_with_a_valid_signature() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let raw = signed_envelope(&signing, EDGE_ID, AuthorityRole::Renter, binding());
        assert!(verify_authority(&raw, &signing.verifying_key(), EDGE_ID, 1_060_000).is_err());
    }

    #[test]
    fn oversized_authority_lifetime_is_rejected_even_when_signed() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let mut long_lived = binding();
        long_lived.expires_at_ms = long_lived.issued_at_ms + MAX_AUTHORITY_TTL_MS + 1;
        let raw = signed_envelope(
            &signing,
            EDGE_ID,
            AuthorityRole::Renter,
            long_lived,
        );
        assert!(verify_authority(&raw, &signing.verifying_key(), EDGE_ID, 1_020_000).is_err());
    }

    #[test]
    fn nonce_contract_matches_control_plane_exactly() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        for nonce in [
            "abcd",
            "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
        ] {
            let mut invalid = binding();
            invalid.nonce = nonce.into();
            let raw = signed_envelope(
                &signing,
                EDGE_ID,
                AuthorityRole::Renter,
                invalid,
            );
            assert!(verify_authority(&raw, &signing.verifying_key(), EDGE_ID, 1_020_000).is_err());
        }
    }

    #[test]
    fn unknown_fields_are_rejected_instead_of_being_ignored() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let raw = signed_envelope(&signing, EDGE_ID, AuthorityRole::Renter, binding());
        let mut value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("admin".into(), true.into());
        assert!(verify_authority(
            &serde_json::to_vec(&value).unwrap(),
            &signing.verifying_key(),
            EDGE_ID,
            1_020_000
        )
        .is_err());
    }

    #[test]
    fn canonical_claim_order_matches_control_plane_contract() {
        let raw = String::from_utf8(
            canonical_authority_claims_bytes(EDGE_ID, AuthorityRole::Renter, &binding()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            raw,
            "{\"edgeId\":\"edge_paris_1\",\"role\":\"RENTER\",\"binding\":{\"protocolVersion\":1,\"sessionId\":\"session_1\",\"machineId\":\"machine_1\",\"bookingId\":\"booking_1\",\"renterUserId\":\"user_1\",\"issuedAtMs\":1000000,\"expiresAtMs\":1060000,\"nonce\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}}"
        );
    }
}
