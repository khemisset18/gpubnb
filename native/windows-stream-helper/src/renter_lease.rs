//! Fail-closed lease describing the pre-provisioned Windows renter session.
//!
//! Windows client editions do not expose a supported API that lets the GPUbnb
//! service manufacture an independent interactive WTS session on demand. Stage 3
//! therefore adopts an explicitly pre-provisioned renter session and verifies it
//! again through WTSQueryUserToken before any graphics resource is created.
//!
//! The lease contains identity only; it contains no password, token or credential.
//! It lives under the already ACL-protected GPUbnb ProgramData directory.

#[cfg(any(target_os = "windows", test))]
use gpubnb_windows_platform::gpu_identity::parse_nvidia_gpu_uuid;
#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::path::Path;
use std::path::PathBuf;

const DEFAULT_LEASE_PATH: &str = r"C:\ProgramData\GPUbnb\windows-renter-lease.txt";
#[cfg(any(target_os = "windows", test))]
const MAX_LEASE_BYTES: u64 = 4096;
#[cfg(any(target_os = "windows", test))]
const MAX_SID_TEXT: usize = 184;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenterSessionLease {
    pub windows_session_id: u32,
    pub renter_user_sid: String,
    pub provider_user_sid: String,
    pub gpu_uuid: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenterLeaseError {
    WindowsRequired,
    Missing,
    InvalidFile,
    TooLarge,
    InvalidEncoding,
    InvalidFormat,
    InvalidSessionId,
    InvalidSid,
    IdentityCollision,
    RenterSystemIdentityForbidden,
    InvalidGpuUuid,
}

#[cfg(any(target_os = "windows", test))]
fn numeric_sid(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_SID_TEXT || !value.starts_with("S-1-") {
        return false;
    }
    let mut fields = 0usize;
    for component in value.split('-') {
        if component.is_empty() {
            return false;
        }
        if fields >= 2 && !component.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        fields += 1;
    }
    fields >= 4
}

#[cfg(any(target_os = "windows", test))]
fn parse_lease_text(value: &str) -> Result<RenterSessionLease, RenterLeaseError> {
    if value.is_empty()
        || value.len() > MAX_LEASE_BYTES as usize
        || value
            .chars()
            .any(|ch| ch.is_control() && ch != '\r' && ch != '\n')
    {
        return Err(RenterLeaseError::InvalidFormat);
    }

    let mut schema = None;
    let mut windows_session_id = None;
    let mut renter_user_sid = None;
    let mut provider_user_sid = None;
    let mut gpu_uuid = None;

    for raw_line in value.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        let (key, raw) = line
            .split_once('=')
            .ok_or(RenterLeaseError::InvalidFormat)?;
        if key.is_empty() || raw.is_empty() || key != key.trim() || raw != raw.trim() {
            return Err(RenterLeaseError::InvalidFormat);
        }
        match key {
            "schema" if schema.is_none() => schema = Some(raw.to_owned()),
            "windows_session_id" if windows_session_id.is_none() => {
                windows_session_id = Some(
                    raw.parse::<u32>()
                        .map_err(|_| RenterLeaseError::InvalidSessionId)?,
                );
            }
            "renter_user_sid" if renter_user_sid.is_none() => {
                renter_user_sid = Some(raw.to_owned())
            }
            "provider_user_sid" if provider_user_sid.is_none() => {
                provider_user_sid = Some(raw.to_owned())
            }
            "gpu_uuid" if gpu_uuid.is_none() => gpu_uuid = Some(raw.to_owned()),
            _ => return Err(RenterLeaseError::InvalidFormat),
        }
    }

    if schema.as_deref() != Some("1") {
        return Err(RenterLeaseError::InvalidFormat);
    }
    let windows_session_id =
        windows_session_id.ok_or(RenterLeaseError::InvalidSessionId)?;
    if windows_session_id == 0 {
        return Err(RenterLeaseError::InvalidSessionId);
    }

    let renter_user_sid = renter_user_sid.ok_or(RenterLeaseError::InvalidSid)?;
    let provider_user_sid = provider_user_sid.ok_or(RenterLeaseError::InvalidSid)?;
    if !numeric_sid(&renter_user_sid) || !numeric_sid(&provider_user_sid) {
        return Err(RenterLeaseError::InvalidSid);
    }
    if renter_user_sid.eq_ignore_ascii_case(&provider_user_sid) {
        return Err(RenterLeaseError::IdentityCollision);
    }
    if ["S-1-5-18", "S-1-5-19", "S-1-5-20"]
        .iter()
        .any(|sid| sid.eq_ignore_ascii_case(&renter_user_sid))
    {
        return Err(RenterLeaseError::RenterSystemIdentityForbidden);
    }

    let gpu_uuid = gpu_uuid.ok_or(RenterLeaseError::InvalidGpuUuid)?;
    parse_nvidia_gpu_uuid(&gpu_uuid).map_err(|_| RenterLeaseError::InvalidGpuUuid)?;

    Ok(RenterSessionLease {
        windows_session_id,
        renter_user_sid,
        provider_user_sid,
        gpu_uuid,
    })
}

#[cfg(target_os = "windows")]
fn read_lease(path: &Path) -> Result<RenterSessionLease, RenterLeaseError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| RenterLeaseError::Missing)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(RenterLeaseError::InvalidFile);
    }
    if metadata.len() == 0 || metadata.len() > MAX_LEASE_BYTES {
        return Err(RenterLeaseError::TooLarge);
    }
    let bytes = fs::read(path).map_err(|_| RenterLeaseError::InvalidFile)?;
    let text = String::from_utf8(bytes).map_err(|_| RenterLeaseError::InvalidEncoding)?;
    parse_lease_text(&text)
}

pub fn renter_lease_path() -> PathBuf {
    PathBuf::from(DEFAULT_LEASE_PATH)
}

pub fn load_renter_session_lease() -> Result<RenterSessionLease, RenterLeaseError> {
    #[cfg(target_os = "windows")]
    {
        read_lease(&renter_lease_path())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(RenterLeaseError::WindowsRequired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = concat!(
        "schema=1\n",
        "windows_session_id=42\n",
        "renter_user_sid=S-1-5-21-111-222-333-1002\n",
        "provider_user_sid=S-1-5-21-111-222-333-1001\n",
        "gpu_uuid=GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a\n",
    );

    #[test]
    fn strict_lease_parses() {
        let lease = parse_lease_text(GOOD).expect("lease");
        assert_eq!(lease.windows_session_id, 42);
        assert_eq!(
            lease.gpu_uuid,
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
        );
    }

    #[test]
    fn lease_rejects_duplicates_unknowns_and_missing_fields() {
        for invalid in [
            GOOD.replace("schema=1\n", ""),
            format!("{GOOD}unexpected=true\n"),
            format!("{GOOD}schema=1\n"),
        ] {
            assert!(parse_lease_text(&invalid).is_err());
        }
    }

    #[test]
    fn lease_rejects_provider_identity_and_system_renter() {
        let same = GOOD.replace(
            "renter_user_sid=S-1-5-21-111-222-333-1002",
            "renter_user_sid=S-1-5-21-111-222-333-1001",
        );
        assert_eq!(
            parse_lease_text(&same),
            Err(RenterLeaseError::IdentityCollision)
        );

        let system = GOOD.replace(
            "renter_user_sid=S-1-5-21-111-222-333-1002",
            "renter_user_sid=S-1-5-18",
        );
        assert_eq!(
            parse_lease_text(&system),
            Err(RenterLeaseError::RenterSystemIdentityForbidden)
        );
    }

    #[test]
    fn lease_rejects_invalid_gpu_and_session() {
        assert_eq!(
            parse_lease_text(&GOOD.replace("windows_session_id=42", "windows_session_id=0")),
            Err(RenterLeaseError::InvalidSessionId)
        );
        assert_eq!(
            parse_lease_text(&GOOD.replace(
                "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
                "GPU-EXACT"
            )),
            Err(RenterLeaseError::InvalidGpuUuid)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn production_loader_fails_closed_off_windows() {
        assert_eq!(
            load_renter_session_lease(),
            Err(RenterLeaseError::WindowsRequired)
        );
    }
}
