//! Qualification-only helpers for issuing real rendezvous tickets.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::process::Command;

use anyhow::{bail, Context, Result};
use ed25519_dalek::SigningKey;
use rand::RngCore;
use serde::Deserialize;

use crate::p2p::{
    P2pCandidate, RelayPolicy, RendezvousTicketClaims, SignedRendezvousTicket,
    MAX_P2P_TICKET_LIFETIME_MS, P2P_RENDEZVOUS_VERSION,
};

pub const DEFAULT_QUALIFICATION_TTL_MS: u64 = 60_000;
const MAX_CANDIDATE_FILE_BYTES: u64 = 32 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateFile {
    candidates: Vec<P2pCandidate>,
}

#[derive(Debug)]
pub struct IssueRequest {
    pub host_candidates: PathBuf,
    pub renter_candidates: PathBuf,
    pub host_ephemeral_public_key: String,
    pub renter_ephemeral_public_key: String,
    pub session_id: String,
    pub machine_id: String,
    pub lease_id: String,
    pub fencing_token: String,
    pub relay_policy: RelayPolicy,
    pub signing_key_file: PathBuf,
    pub output: PathBuf,
    pub ttl_ms: u64,
}

pub fn now_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis()
        .try_into()
        .context("system clock value exceeds u64")?)
}

pub fn issue_to_file(request: &IssueRequest, issued_at_ms: u64) -> Result<SignedRendezvousTicket> {
    if request.ttl_ms == 0 || request.ttl_ms > MAX_P2P_TICKET_LIFETIME_MS {
        bail!("qualification ticket TTL must be between 1 and 120000 milliseconds");
    }
    let signing_key = load_protected_signing_key(&request.signing_key_file)?;
    let claims = RendezvousTicketClaims {
        protocol_version: P2P_RENDEZVOUS_VERSION,
        session_id: request.session_id.clone(),
        machine_id: request.machine_id.clone(),
        lease_id: request.lease_id.clone(),
        fencing_token: request.fencing_token.clone(),
        issued_at_ms,
        expires_at_ms: issued_at_ms
            .checked_add(request.ttl_ms)
            .context("qualification ticket expiry overflow")?,
        nonce: random_hex(32),
        host_ephemeral_key_base58: request.host_ephemeral_public_key.clone(),
        renter_ephemeral_key_base58: request.renter_ephemeral_public_key.clone(),
        host_candidates: read_candidates(&request.host_candidates, "host")?,
        renter_candidates: read_candidates(&request.renter_candidates, "renter")?,
        relay_policy: request.relay_policy,
    };
    let ticket = SignedRendezvousTicket::issue(claims, &signing_key, issued_at_ms)?;
    write_new_private_json(&request.output, &ticket)?;
    Ok(ticket)
}

pub fn generate_qualification_key(private_path: &Path, public_path: &Path) -> Result<String> {
    if private_path.exists() || public_path.exists() {
        bail!("qualification key output already exists");
    }
    let mut raw = [0_u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let signing_key = SigningKey::from_bytes(&raw);
    write_new_private_bytes(private_path, signing_key.as_bytes())?;
    protect_windows_file(private_path)?;
    validate_private_permissions(private_path)?;
    let public = bs58::encode(signing_key.verifying_key().as_bytes()).into_string();
    write_new_public_text(public_path, &public)?;
    Ok(public)
}

fn read_candidates(path: &Path, peer: &str) -> Result<Vec<P2pCandidate>> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("{peer} candidate file is missing or unreadable"))?;
    if !metadata.is_file() || metadata.len() > MAX_CANDIDATE_FILE_BYTES {
        bail!("{peer} candidate file is not a bounded regular file");
    }
    let bytes = fs::read(path).with_context(|| format!("failed to read {peer} candidate file"))?;
    let value: CandidateFile =
        serde_json::from_slice(&bytes).with_context(|| format!("invalid {peer} candidate file"))?;
    Ok(value.candidates)
}

fn load_protected_signing_key(path: &Path) -> Result<SigningKey> {
    validate_private_permissions(path)?;
    let raw = fs::read(path).context("qualification signing key is missing or unreadable")?;
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| anyhow::anyhow!("qualification signing key must contain exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn validate_private_permissions(path: &Path) -> Result<()> {
    let metadata =
        fs::metadata(path).context("qualification signing key is missing or unreadable")?;
    if !metadata.is_file() {
        bail!("qualification signing key must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!(
                "qualification signing key permissions are unsafe; require mode 0600 or stricter"
            );
        }
    }
    #[cfg(windows)]
    validate_windows_acl(path)?;
    Ok(())
}

#[cfg(windows)]
fn validate_windows_acl(path: &Path) -> Result<()> {
    let output = Command::new("icacls")
        .arg(path)
        .output()
        .context("failed to inspect qualification signing key ACL")?;
    if !output.status.success() {
        bail!("failed to inspect qualification signing key ACL");
    }
    let acl = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    for broad in [
        "everyone:",
        "builtin\\users:",
        "authenticated users:",
        "utilisateurs authentifiés:",
    ] {
        if acl.contains(broad) {
            bail!("qualification signing key permissions are unsafe; remove broad ACL entries");
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn protect_windows_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn protect_windows_file(path: &Path) -> Result<()> {
    let user = std::env::var("USERNAME").context("USERNAME is unavailable")?;
    let status = Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{user}:F"))
        .status()
        .context("failed to protect qualification signing key ACL")?;
    if !status.success() {
        bail!("failed to protect qualification signing key ACL");
    }
    Ok(())
}

fn random_hex(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn write_new_private_json(path: &Path, value: &SignedRendezvousTicket) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_new_private_bytes(path, &bytes)
}

fn write_new_private_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .context("failed to create protected output file")?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_new_public_text(path: &Path, value: &str) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .context("failed to create public-key output file")?;
    writeln!(file, "{value}")?;
    file.sync_all()?;
    Ok(())
}

pub fn parse_options(
    arguments: impl IntoIterator<Item = String>,
) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    let mut arguments = arguments.into_iter();
    while let Some(flag) = arguments.next() {
        if !flag.starts_with("--") {
            bail!("unexpected positional argument");
        }
        let value = arguments
            .next()
            .with_context(|| format!("missing value for {flag}"))?;
        if value.starts_with("--") || values.insert(flag.clone(), value).is_some() {
            bail!("invalid or duplicate option {flag}");
        }
    }
    Ok(values)
}

pub fn take_required(values: &mut BTreeMap<String, String>, name: &str) -> Result<String> {
    values
        .remove(name)
        .with_context(|| format!("missing required option {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::p2p::CandidateKind;

    fn temporary(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("gpubnb-{name}-{}", random_hex(8)))
    }

    fn candidate_file(path: &Path, count: usize) {
        let candidates: Vec<_> = (0..count)
            .map(|index| P2pCandidate {
                kind: CandidateKind::Host,
                endpoint: format!("10.0.0.1:{}", 20_000 + index),
                priority: 100,
            })
            .collect();
        fs::write(
            path,
            serde_json::json!({"candidates": candidates}).to_string(),
        )
        .unwrap();
    }

    fn request(directory: &Path) -> (IssueRequest, SigningKey) {
        fs::create_dir(directory).unwrap();
        let private = directory.join("signing.key");
        let public = directory.join("signing.pub");
        generate_qualification_key(&private, &public).unwrap();
        let raw: [u8; 32] = fs::read(&private).unwrap().try_into().unwrap();
        let signing = SigningKey::from_bytes(&raw);
        let host = directory.join("host.json");
        let renter = directory.join("renter.json");
        candidate_file(&host, 1);
        candidate_file(&renter, 1);
        (
            IssueRequest {
                host_candidates: host,
                renter_candidates: renter,
                host_ephemeral_public_key: bs58::encode([11_u8; 32]).into_string(),
                renter_ephemeral_public_key: bs58::encode([12_u8; 32]).into_string(),
                session_id: "session_qualification_01".into(),
                machine_id: "machine_qualification_01".into(),
                lease_id: "lease_qualification_01".into(),
                fencing_token: "42".into(),
                relay_policy: RelayPolicy::DirectOnly,
                signing_key_file: private,
                output: directory.join("ticket.json"),
                ttl_ms: DEFAULT_QUALIFICATION_TTL_MS,
            },
            signing,
        )
    }

    #[test]
    fn valid_candidate_files_issue_verifiable_ticket() {
        let directory = temporary("valid-ticket");
        let (request, signing) = request(&directory);
        let ticket = issue_to_file(&request, 1_000_000).unwrap();
        ticket.verify(&signing.verifying_key(), 1_000_001).unwrap();
        assert_eq!(ticket.claims.host_candidates.len(), 1);
        assert_eq!(ticket.claims.renter_candidates.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn mutations_wrong_fencing_expiry_and_wrong_key_are_rejected() {
        let directory = temporary("ticket-rejections");
        let (request, signing) = request(&directory);
        let ticket = issue_to_file(&request, 1_000_000).unwrap();
        let mut changed = ticket.clone();
        changed.claims.host_candidates[0].priority += 1;
        assert!(changed.verify(&signing.verifying_key(), 1_000_001).is_err());
        let mut fencing = ticket.clone();
        fencing.claims.fencing_token = "43".into();
        assert!(fencing.verify(&signing.verifying_key(), 1_000_001).is_err());
        assert!(ticket.verify(&signing.verifying_key(), 1_060_000).is_err());
        assert!(ticket
            .verify(
                &SigningKey::from_bytes(&[99; 32]).verifying_key(),
                1_000_001
            )
            .is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_unsafe_key_and_candidate_limit_are_rejected() {
        let directory = temporary("input-rejections");
        let (mut request, _) = request(&directory);
        request.signing_key_file = directory.join("missing.key");
        assert!(issue_to_file(&request, 1_000_000)
            .unwrap_err()
            .to_string()
            .contains("missing"));
        request.signing_key_file = directory.join("signing.key");
        candidate_file(&request.host_candidates, 13);
        assert!(issue_to_file(&request, 1_000_000).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            candidate_file(&request.host_candidates, 1);
            fs::set_permissions(&request.signing_key_file, fs::Permissions::from_mode(0o644))
                .unwrap();
            assert!(issue_to_file(&request, 1_000_000)
                .unwrap_err()
                .to_string()
                .contains("unsafe"));
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
