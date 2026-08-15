use std::{collections::BTreeSet, net::SocketAddr};

use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::protocol::{validate_fencing_token, validate_id};

pub const P2P_RENDEZVOUS_VERSION: u16 = 1;
pub const P2P_TICKET_DOMAIN: &str = "gpubnb-p2p-rendezvous-v1";
pub const MAX_P2P_TICKET_LIFETIME_MS: u64 = 2 * 60 * 1000;
pub const MAX_P2P_CLOCK_SKEW_MS: u64 = 30 * 1000;
pub const MAX_P2P_CANDIDATES_PER_PEER: usize = 12;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CandidateKind {
    Host,
    ServerReflexive,
    Relay,
}

impl CandidateKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Host => "HOST",
            Self::ServerReflexive => "SERVER_REFLEXIVE",
            Self::Relay => "RELAY",
        }
    }

    fn path_rank(self) -> u8 {
        match self {
            Self::Host => 0,
            Self::ServerReflexive => 1,
            Self::Relay => 2,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct P2pCandidate {
    pub kind: CandidateKind,
    pub endpoint: String,
    pub priority: u32,
}

impl P2pCandidate {
    pub fn validate(&self) -> Result<()> {
        if self.priority == 0 {
            bail!("P2P candidate priority must be positive");
        }
        let address: SocketAddr = self
            .endpoint
            .parse()
            .with_context(|| format!("invalid P2P candidate endpoint {}", self.endpoint))?;
        if address.port() == 0 || address.ip().is_unspecified() {
            bail!("P2P candidate endpoint must be routable enough to attempt");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RelayPolicy {
    DirectOnly,
    FallbackOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RendezvousTicketClaims {
    pub protocol_version: u16,
    pub session_id: String,
    pub machine_id: String,
    pub lease_id: String,
    pub fencing_token: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub nonce: String,
    pub host_ephemeral_key_base58: String,
    pub renter_ephemeral_key_base58: String,
    pub host_candidates: Vec<P2pCandidate>,
    #[serde(default)]
    pub renter_candidates: Vec<P2pCandidate>,
    pub relay_policy: RelayPolicy,
}

impl RendezvousTicketClaims {
    pub fn validate(&self, now_ms: u64) -> Result<()> {
        if self.protocol_version != P2P_RENDEZVOUS_VERSION {
            bail!("unsupported P2P rendezvous protocol version");
        }
        validate_id(&self.session_id, "session_id")?;
        validate_id(&self.machine_id, "machine_id")?;
        validate_id(&self.lease_id, "lease_id")?;
        validate_fencing_token(&self.fencing_token)?;
        validate_nonce(&self.nonce)?;
        validate_ephemeral_key(&self.host_ephemeral_key_base58, "host ephemeral key")?;
        validate_ephemeral_key(&self.renter_ephemeral_key_base58, "renter ephemeral key")?;

        if self.expires_at_ms <= self.issued_at_ms {
            bail!("P2P rendezvous ticket expiry must be after issue time");
        }
        if self.expires_at_ms - self.issued_at_ms > MAX_P2P_TICKET_LIFETIME_MS {
            bail!("P2P rendezvous ticket lifetime exceeds hard bound");
        }
        if self.issued_at_ms > now_ms.saturating_add(MAX_P2P_CLOCK_SKEW_MS) {
            bail!("P2P rendezvous ticket issue time is too far in the future");
        }
        if now_ms >= self.expires_at_ms {
            bail!("P2P rendezvous ticket expired");
        }

        validate_candidates(&self.host_candidates, "host")?;
        validate_candidates(&self.renter_candidates, "renter")?;
        if self.host_candidates.is_empty() {
            bail!("P2P rendezvous ticket requires at least one host candidate");
        }
        if !self
            .host_candidates
            .iter()
            .any(|candidate| candidate.kind != CandidateKind::Relay)
        {
            bail!("relay cannot be the only advertised host path");
        }

        let contains_relay = self
            .host_candidates
            .iter()
            .chain(self.renter_candidates.iter())
            .any(|candidate| candidate.kind == CandidateKind::Relay);
        if contains_relay && self.relay_policy == RelayPolicy::DirectOnly {
            bail!("relay candidate forbidden by DIRECT_ONLY policy");
        }
        Ok(())
    }

    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut encoded = format!(
            "{P2P_TICKET_DOMAIN}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
            self.protocol_version,
            self.session_id,
            self.machine_id,
            self.lease_id,
            self.fencing_token,
            self.issued_at_ms,
            self.expires_at_ms,
            self.nonce,
            self.host_ephemeral_key_base58,
            self.renter_ephemeral_key_base58,
            match self.relay_policy {
                RelayPolicy::DirectOnly => "DIRECT_ONLY",
                RelayPolicy::FallbackOnly => "FALLBACK_ONLY",
            },
        )
        .into_bytes();
        append_candidates(&mut encoded, "host", &self.host_candidates);
        append_candidates(&mut encoded, "renter", &self.renter_candidates);
        encoded
    }

    pub fn ordered_host_attempts(&self) -> Vec<P2pCandidate> {
        let mut candidates = self.host_candidates.clone();
        candidates.sort_by(|left, right| {
            left.kind
                .path_rank()
                .cmp(&right.kind.path_rank())
                .then_with(|| right.priority.cmp(&left.priority))
                .then_with(|| left.endpoint.cmp(&right.endpoint))
        });
        candidates
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SignedRendezvousTicket {
    pub claims: RendezvousTicketClaims,
    pub signature_hex: String,
}

impl SignedRendezvousTicket {
    pub fn issue(
        claims: RendezvousTicketClaims,
        signing_key: &SigningKey,
        now_ms: u64,
    ) -> Result<Self> {
        claims.validate(now_ms)?;
        let signature_hex = hex::encode(signing_key.sign(&claims.signing_bytes()).to_bytes());
        Ok(Self {
            claims,
            signature_hex,
        })
    }

    pub fn verify(&self, verifying_key: &VerifyingKey, now_ms: u64) -> Result<()> {
        self.claims.validate(now_ms)?;
        if self.signature_hex.len() != 128
            || !self.signature_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("P2P rendezvous signature must be a 64-byte Ed25519 signature");
        }
        let raw = hex::decode(&self.signature_hex).context("invalid rendezvous signature hex")?;
        let signature =
            Signature::from_slice(&raw).context("invalid rendezvous Ed25519 signature bytes")?;
        verifying_key
            .verify(&self.claims.signing_bytes(), &signature)
            .context("P2P rendezvous ticket signature verification failed")
    }
}

fn append_candidates(output: &mut Vec<u8>, peer: &str, candidates: &[P2pCandidate]) {
    output.extend_from_slice(format!("{peer}:{}\n", candidates.len()).as_bytes());
    for candidate in candidates {
        output.extend_from_slice(
            format!(
                "{}|{}|{}\n",
                candidate.kind.as_str(),
                candidate.endpoint,
                candidate.priority
            )
            .as_bytes(),
        );
    }
}

fn validate_candidates(candidates: &[P2pCandidate], peer: &str) -> Result<()> {
    if candidates.len() > MAX_P2P_CANDIDATES_PER_PEER {
        bail!("{peer} P2P candidate count exceeds hard bound");
    }
    let mut unique = BTreeSet::new();
    for candidate in candidates {
        candidate.validate()?;
        let identity = format!("{}|{}", candidate.kind.as_str(), candidate.endpoint);
        if !unique.insert(identity) {
            bail!("duplicate {peer} P2P candidate");
        }
    }
    Ok(())
}

fn validate_nonce(value: &str) -> Result<()> {
    if !(32..=128).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("P2P rendezvous nonce invalid");
    }
    Ok(())
}

fn validate_ephemeral_key(value: &str, field: &str) -> Result<()> {
    if !(32..=64).contains(&value.len()) {
        bail!("{field} length invalid");
    }
    let decoded = bs58::decode(value)
        .into_vec()
        .with_context(|| format!("{field} is not valid base58"))?;
    if decoded.len() != 32 {
        bail!("{field} must decode to 32 bytes");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(kind: CandidateKind, endpoint: &str, priority: u32) -> P2pCandidate {
        P2pCandidate {
            kind,
            endpoint: endpoint.into(),
            priority,
        }
    }

    fn claims() -> RendezvousTicketClaims {
        RendezvousTicketClaims {
            protocol_version: P2P_RENDEZVOUS_VERSION,
            session_id: "session_00000001".into(),
            machine_id: "machine_00000001".into(),
            lease_id: "lease_00000001".into(),
            fencing_token: "42".into(),
            issued_at_ms: 1_000_000,
            expires_at_ms: 1_060_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
            host_ephemeral_key_base58: bs58::encode([11_u8; 32]).into_string(),
            renter_ephemeral_key_base58: bs58::encode([12_u8; 32]).into_string(),
            host_candidates: vec![
                candidate(CandidateKind::Relay, "203.0.113.20:4433", 65_535),
                candidate(CandidateKind::ServerReflexive, "198.51.100.10:42000", 50),
                candidate(CandidateKind::Host, "192.168.1.10:42000", 10),
            ],
            renter_candidates: vec![candidate(
                CandidateKind::ServerReflexive,
                "198.51.100.30:43000",
                10,
            )],
            relay_policy: RelayPolicy::FallbackOnly,
        }
    }

    #[test]
    fn signed_ticket_is_bound_to_current_fenced_lease() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut ticket =
            SignedRendezvousTicket::issue(claims(), &signing_key, 1_000_010).unwrap();
        ticket
            .verify(&signing_key.verifying_key(), 1_000_020)
            .unwrap();

        ticket.claims.fencing_token = "43".into();
        assert!(ticket
            .verify(&signing_key.verifying_key(), 1_000_020)
            .is_err());
    }

    #[test]
    fn direct_paths_are_always_attempted_before_relay() {
        let attempts = claims().ordered_host_attempts();
        assert_eq!(attempts[0].kind, CandidateKind::Host);
        assert_eq!(attempts[1].kind, CandidateKind::ServerReflexive);
        assert_eq!(attempts[2].kind, CandidateKind::Relay);
    }

    #[test]
    fn expired_and_overlong_tickets_are_rejected() {
        let mut expired = claims();
        assert!(expired.validate(expired.expires_at_ms).is_err());

        expired.expires_at_ms = expired.issued_at_ms + MAX_P2P_TICKET_LIFETIME_MS + 1;
        assert!(expired.validate(expired.issued_at_ms + 1).is_err());
    }

    #[test]
    fn relay_is_only_a_fallback_and_never_the_only_host_path() {
        let mut relay_only = claims();
        relay_only.host_candidates = vec![candidate(
            CandidateKind::Relay,
            "203.0.113.20:4433",
            100,
        )];
        assert!(relay_only.validate(1_000_010).is_err());

        let mut direct_only = claims();
        direct_only.relay_policy = RelayPolicy::DirectOnly;
        assert!(direct_only.validate(1_000_010).is_err());
    }

    #[test]
    fn serialized_ticket_contract_contains_no_product_pii_fields() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let ticket =
            SignedRendezvousTicket::issue(claims(), &signing_key, 1_000_010).unwrap();
        let encoded = serde_json::to_string(&ticket).unwrap();
        for forbidden in ["email", "ownerId", "payment", "card", "billing"] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn candidate_sets_are_bounded_and_deduplicated() {
        let mut duplicated = claims();
        duplicated.host_candidates.push(duplicated.host_candidates[0].clone());
        assert!(duplicated.validate(1_000_010).is_err());

        let mut oversized = claims();
        oversized.renter_candidates = (0..=MAX_P2P_CANDIDATES_PER_PEER)
            .map(|index| {
                candidate(
                    CandidateKind::Host,
                    &format!("10.0.0.1:{}", 10_000 + index),
                    1,
                )
            })
            .collect();
        assert!(oversized.validate(1_000_010).is_err());
    }
}
