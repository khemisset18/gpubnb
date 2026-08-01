use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u32 = 1;
const FILE_NAME: &str = "installation-identity.json";
const INSTALLATION_PREFIX: &str = "install_";
const MACHINE_PREFIX: &str = "machine_";
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationIdentity {
    pub schema_version: u32,
    pub installation_id: String,
    pub local_machine_id: String,
    pub created_at_unix_seconds: u64,
}

impl InstallationIdentity {
    pub fn generate() -> Result<Self, &'static str> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system_clock_invalid")?;
        let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let entropy = format!(
            "{:016x}{:08x}{:016x}",
            now.as_nanos() as u64,
            std::process::id(),
            sequence
        );
        let identity = Self {
            schema_version: SCHEMA_VERSION,
            installation_id: format!("{INSTALLATION_PREFIX}{entropy}"),
            local_machine_id: format!("{MACHINE_PREFIX}{entropy}"),
            created_at_unix_seconds: now.as_secs(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != SCHEMA_VERSION {
            return Err("installation_identity_schema_unsupported");
        }
        validate_id(&self.installation_id, INSTALLATION_PREFIX)?;
        validate_id(&self.local_machine_id, MACHINE_PREFIX)?;
        if self.installation_id == "unpaired_installation"
            || self.local_machine_id == "unpaired_machine"
        {
            return Err("installation_identity_placeholder_forbidden");
        }
        if self.created_at_unix_seconds == 0 {
            return Err("installation_identity_timestamp_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct InstallationIdentityStore {
    path: PathBuf,
}

impl InstallationIdentityStore {
    pub fn from_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn from_default_location() -> Result<Self, &'static str> {
        Ok(Self::from_path(default_data_directory()?.join(FILE_NAME)))
    }

    pub fn load_or_create(&self) -> Result<InstallationIdentity, &'static str> {
        if self.path.exists() {
            return self.load();
        }
        let identity = InstallationIdentity::generate()?;
        self.save(&identity)?;
        Ok(identity)
    }

    pub fn load(&self) -> Result<InstallationIdentity, &'static str> {
        let content =
            fs::read_to_string(&self.path).map_err(|_| "installation_identity_read_failed")?;
        let identity: InstallationIdentity =
            serde_json::from_str(&content).map_err(|_| "installation_identity_decode_failed")?;
        identity.validate()?;
        Ok(identity)
    }

    pub fn save(&self, identity: &InstallationIdentity) -> Result<(), &'static str> {
        identity.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or("installation_identity_parent_missing")?;
        fs::create_dir_all(parent).map_err(|_| "installation_identity_directory_failed")?;
        let content = serde_json::to_vec_pretty(identity)
            .map_err(|_| "installation_identity_encode_failed")?;
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", std::process::id()));

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "installation_identity_temp_open_failed")?;
        file.write_all(&content)
            .map_err(|_| "installation_identity_write_failed")?;
        file.sync_all()
            .map_err(|_| "installation_identity_sync_failed")?;
        drop(file);

        if fs::rename(&temporary, &self.path).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("installation_identity_commit_failed");
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_id(value: &str, prefix: &str) -> Result<(), &'static str> {
    let suffix = value
        .strip_prefix(prefix)
        .ok_or("installation_identity_prefix_invalid")?;
    if suffix.len() != 40 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("installation_identity_format_invalid");
    }
    Ok(())
}

fn default_data_directory() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("GPUBNB_DATA_DIR") {
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("APPDATA"));
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library").join("Application Support"))
        .map(|path| path.into_os_string());
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_STATE_HOME").or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local").join("state"))
            .map(|path| path.into_os_string())
    });

    base.map(PathBuf::from)
        .map(|path| path.join("GPUbnb").join("Host"))
        .ok_or("gpubnb_data_directory_unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "gpubnb-{name}-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn generated_identity_is_valid_and_never_uses_placeholders() {
        let identity = InstallationIdentity::generate().unwrap();
        assert!(identity.validate().is_ok());
        assert_ne!(identity.installation_id, "unpaired_installation");
        assert_ne!(identity.local_machine_id, "unpaired_machine");
    }

    #[test]
    fn identity_is_stable_across_loads() {
        let path = unique_path("identity-stable");
        let store = InstallationIdentityStore::from_path(path.clone());
        let created = store.load_or_create().unwrap();
        let loaded = store.load_or_create().unwrap();
        assert_eq!(created, loaded);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn invalid_identity_is_rejected_fail_closed() {
        let path = unique_path("identity-invalid");
        fs::write(
            &path,
            r#"{"schemaVersion":1,"installationId":"unpaired_installation","localMachineId":"unpaired_machine","createdAtUnixSeconds":1}"#,
        )
        .unwrap();
        let store = InstallationIdentityStore::from_path(path.clone());
        assert!(store.load_or_create().is_err());
        let _ = fs::remove_file(path);
    }
}
