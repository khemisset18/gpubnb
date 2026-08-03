#[path = "approved_miner_manifest.rs"]
mod approved_miner_manifest;
#[path = "mining_catalog/secure_launcher.rs"]
mod secure_launcher;

use approved_miner_manifest::{
    approved_miner_release, validate_release_metadata, ApprovedMinerRelease,
};
use flate2::read::{DeflateDecoder, GzDecoder};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const APPROVED_MINER_DIRECTORY_ENV: &str = "GPUBNB_APPROVED_MINER_DIR";
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BINARY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerInstallationSnapshot {
    pub profile_id: String,
    pub version: String,
    pub executable_path: String,
    pub archive_sha256: String,
    pub binary_sha256: String,
}

pub fn install_approved_miner_archive(
    profile_id: &str,
    archive_path: &Path,
    consent_confirmed: bool,
) -> Result<MinerInstallationSnapshot, &'static str> {
    if !consent_confirmed {
        return Err("miner_installation_consent_required");
    }
    let release = approved_miner_release(profile_id)?;
    validate_release_metadata(&release)?;
    validate_archive_path(archive_path, &release)?;

    let actual_archive_hash = secure_launcher::sha256_file(archive_path)
        .map_err(|_| "miner_archive_hash_failed")?;
    if !secure_launcher::constant_time_hex_eq(&actual_archive_hash, release.archive_sha256) {
        return Err("miner_archive_hash_mismatch");
    }

    let binary = extract_pinned_binary(archive_path, &release)?;
    let binary_hash = hex_digest(&binary);
    if !secure_launcher::constant_time_hex_eq(&binary_hash, release.binary_sha256) {
        return Err("miner_archive_binary_hash_mismatch");
    }

    let root = approved_root()?;
    let executable = commit_binary(&root, &release, &binary)?;
    let verified = secure_launcher::verify_miner_binary(&root, &release.binary_manifest())?;
    if verified.canonical_path
        != executable
            .canonicalize()
            .map_err(|_| "miner_install_commit_unverified")?
    {
        return Err("miner_install_commit_unverified");
    }

    Ok(MinerInstallationSnapshot {
        profile_id: release.profile_id.into(),
        version: release.version.into(),
        executable_path: verified.canonical_path.to_string_lossy().into_owned(),
        archive_sha256: actual_archive_hash,
        binary_sha256: verified.sha256,
    })
}

fn validate_archive_path(path: &Path, release: &ApprovedMinerRelease) -> Result<(), &'static str> {
    let metadata = path.metadata().map_err(|_| "miner_archive_unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("miner_archive_invalid");
    }
    if path.file_name().and_then(|name| name.to_str()) != Some(release.archive_name) {
        return Err("miner_archive_name_mismatch");
    }
    Ok(())
}

fn approved_root() -> Result<PathBuf, &'static str> {
    let root = std::env::var_os(APPROVED_MINER_DIRECTORY_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or("approved_miner_directory_not_configured")?;
    fs::create_dir_all(&root).map_err(|_| "approved_miner_directory_create_failed")?;
    let root = root.canonicalize().map_err(|_| "approved_miner_directory_unavailable")?;
    if !root.is_dir() {
        return Err("approved_miner_directory_invalid");
    }
    Ok(root)
}

fn extract_pinned_binary(
    archive_path: &Path,
    release: &ApprovedMinerRelease,
) -> Result<Vec<u8>, &'static str> {
    if release.archive_name.ends_with(".tar.gz") {
        extract_from_tar_gz(archive_path, release.binary_file_name)
    } else if release.archive_name.ends_with(".zip") {
        extract_from_zip(archive_path, release.binary_file_name)
    } else {
        Err("miner_archive_format_unsupported")
    }
}

fn extract_from_tar_gz(path: &Path, expected_name: &str) -> Result<Vec<u8>, &'static str> {
    let file = File::open(path).map_err(|_| "miner_archive_open_failed")?;
    let mut reader = GzDecoder::new(file);
    let mut found = None;
    loop {
        let mut header = [0_u8; 512];
        read_exact_or_eof(&mut reader, &mut header)?;
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        if &header[257..263] != b"ustar\0" && &header[257..263] != b"ustar " {
            return Err("miner_archive_tar_header_invalid");
        }
        let name = nul_terminated(&header[..100])?;
        let size = parse_tar_octal(&header[124..136])?;
        if size > MAX_BINARY_BYTES {
            return Err("miner_archive_entry_too_large");
        }
        let is_file = header[156] == 0 || header[156] == b'0';
        let matches = is_file && archive_basename(name) == Some(expected_name);
        if matches && found.is_some() {
            return Err("miner_archive_binary_ambiguous");
        }
        if matches {
            let mut bytes = vec![0_u8; size];
            reader.read_exact(&mut bytes).map_err(|_| "miner_archive_read_failed")?;
            found = Some(bytes);
        } else {
            copy_exact(&mut reader, size)?;
        }
        let padding = (512 - size % 512) % 512;
        copy_exact(&mut reader, padding)?;
    }
    found.ok_or("miner_archive_binary_missing")
}

fn extract_from_zip(path: &Path, expected_name: &str) -> Result<Vec<u8>, &'static str> {
    let mut archive = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut archive))
        .map_err(|_| "miner_archive_read_failed")?;
    let mut cursor = 0_usize;
    let mut found = None;
    while cursor + 4 <= archive.len() {
        let signature = le_u32(&archive[cursor..cursor + 4]);
        if signature == 0x0201_4b50 || signature == 0x0605_4b50 {
            break;
        }
        if signature != 0x0403_4b50 || cursor + 30 > archive.len() {
            return Err("miner_archive_zip_header_invalid");
        }
        let flags = le_u16(&archive[cursor + 6..cursor + 8]);
        let method = le_u16(&archive[cursor + 8..cursor + 10]);
        if flags & 0x0009 != 0 {
            return Err("miner_archive_zip_flags_unsupported");
        }
        let compressed_size = le_u32(&archive[cursor + 18..cursor + 22]) as usize;
        let uncompressed_size = le_u32(&archive[cursor + 22..cursor + 26]) as usize;
        let name_len = le_u16(&archive[cursor + 26..cursor + 28]) as usize;
        let extra_len = le_u16(&archive[cursor + 28..cursor + 30]) as usize;
        if uncompressed_size > MAX_BINARY_BYTES {
            return Err("miner_archive_entry_too_large");
        }
        let name_start = cursor + 30;
        let data_start = name_start
            .checked_add(name_len)
            .and_then(|value| value.checked_add(extra_len))
            .ok_or("miner_archive_zip_bounds_invalid")?;
        let data_end = data_start
            .checked_add(compressed_size)
            .ok_or("miner_archive_zip_bounds_invalid")?;
        if data_end > archive.len() {
            return Err("miner_archive_zip_bounds_invalid");
        }
        let name = std::str::from_utf8(&archive[name_start..name_start + name_len])
            .map_err(|_| "miner_archive_entry_name_invalid")?;
        if archive_basename(name) == Some(expected_name) {
            if found.is_some() {
                return Err("miner_archive_binary_ambiguous");
            }
            let mut bytes = Vec::with_capacity(uncompressed_size);
            match method {
                0 => {
                    bytes.extend_from_slice(&archive[data_start..data_end]);
                }
                8 => {
                    DeflateDecoder::new(&archive[data_start..data_end])
                        .read_to_end(&mut bytes)
                        .map_err(|_| "miner_archive_decompression_failed")?;
                }
                _ => return Err("miner_archive_compression_unsupported"),
            }
            if bytes.len() != uncompressed_size {
                return Err("miner_archive_entry_size_mismatch");
            }
            found = Some(bytes);
        }
        cursor = data_end;
    }
    found.ok_or("miner_archive_binary_missing")
}

fn commit_binary(
    root: &Path,
    release: &ApprovedMinerRelease,
    binary: &[u8],
) -> Result<PathBuf, &'static str> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system_clock_invalid")?
        .as_nanos();
    let temporary = root.join(format!(
        ".{}.install-{}-{nonce}",
        release.binary_file_name,
        std::process::id()
    ));
    let backup = root.join(format!(".{}.rollback", release.binary_file_name));
    let destination = root.join(release.binary_file_name);
    if backup.exists() {
        return Err("miner_install_rollback_pending");
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o700);
    let mut file = options
        .open(&temporary)
        .map_err(|_| "miner_install_temp_open_failed")?;
    let write_result = file.write_all(binary).and_then(|_| file.sync_all());
    drop(file);
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("miner_install_temp_write_failed");
    }
    #[cfg(unix)]
    if fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700)).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("miner_install_permissions_failed");
    }

    let had_previous = destination.exists();
    if had_previous && fs::rename(&destination, &backup).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("miner_install_backup_failed");
    }
    if fs::rename(&temporary, &destination).is_err() {
        let _ = fs::remove_file(&temporary);
        if had_previous {
            let _ = fs::rename(&backup, &destination);
        }
        return Err("miner_install_commit_failed");
    }
    if secure_launcher::verify_miner_binary(root, &release.binary_manifest()).is_err() {
        let _ = fs::remove_file(&destination);
        if had_previous {
            let _ = fs::rename(&backup, &destination);
        }
        return Err("miner_install_commit_unverified");
    }
    if had_previous && fs::remove_file(&backup).is_err() {
        return Err("miner_install_backup_cleanup_failed");
    }
    Ok(destination)
}

fn read_exact_or_eof(reader: &mut impl Read, buffer: &mut [u8]) -> Result<(), &'static str> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            "miner_archive_truncated"
        } else {
            "miner_archive_read_failed"
        }
    })
}

fn copy_exact(reader: &mut impl Read, bytes: usize) -> Result<(), &'static str> {
    let copied = io::copy(&mut reader.take(bytes as u64), &mut io::sink())
        .map_err(|_| "miner_archive_read_failed")?;
    if copied != bytes as u64 {
        return Err("miner_archive_truncated");
    }
    Ok(())
}

fn nul_terminated(bytes: &[u8]) -> Result<&str, &'static str> {
    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end]).map_err(|_| "miner_archive_entry_name_invalid")
}

fn parse_tar_octal(bytes: &[u8]) -> Result<usize, &'static str> {
    let text = nul_terminated(bytes)?.trim();
    usize::from_str_radix(text, 8).map_err(|_| "miner_archive_entry_size_invalid")
}

fn archive_basename(name: &str) -> Option<&str> {
    if name.contains('\\') || name.starts_with('/') || name.split('/').any(|part| part == "..") {
        return None;
    }
    name.rsplit('/').next().filter(|part| !part.is_empty())
}

fn le_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn le_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_installation_without_explicit_consent_before_reading_files() {
        assert_eq!(
            install_approved_miner_archive("xmrig_randomx", Path::new("missing"), false),
            Err("miner_installation_consent_required")
        );
    }

    #[test]
    fn rejects_traversal_entry_names() {
        assert_eq!(archive_basename("../xmrig"), None);
        assert_eq!(archive_basename("folder/../../xmrig"), None);
        assert_eq!(archive_basename("C:\\xmrig.exe"), None);
        assert_eq!(archive_basename("xmrig-6.26.0/xmrig"), Some("xmrig"));
    }

    #[test]
    fn extracts_only_the_expected_stored_zip_entry() {
        let payload = b"approved binary";
        let name = b"xmrig-6.26.0/xmrig.exe";
        let mut zip = Vec::new();
        zip.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
        zip.extend_from_slice(&20_u16.to_le_bytes());
        zip.extend_from_slice(&0_u16.to_le_bytes());
        zip.extend_from_slice(&0_u16.to_le_bytes());
        zip.extend_from_slice(&[0_u8; 8]);
        zip.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&0_u16.to_le_bytes());
        zip.extend_from_slice(name);
        zip.extend_from_slice(payload);
        zip.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        let root = std::env::temp_dir().join(format!("gpubnb-zip-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("archive.zip");
        fs::write(&path, zip).unwrap();
        assert_eq!(extract_from_zip(&path, "xmrig.exe").unwrap(), payload);
        fs::remove_dir_all(root).unwrap();
    }
}
