use crate::mining_configuration::{MiningConfiguration, PoolConnectionEvidence};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u32 = 1;
const FILE_NAME: &str = "mining-configuration.json";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistentMiningConfiguration {
    pub schema_version: u32,
    pub configuration: Option<MiningConfiguration>,
    pub connection_evidence: Option<PoolConnectionEvidence>,
    pub revision: u64,
}

impl PersistentMiningConfiguration {
    pub fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            configuration: None,
            connection_evidence: None,
            revision: 0,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != SCHEMA_VERSION {
            return Err("mining_persistence_schema_unsupported");
        }
        match (&self.configuration, &self.connection_evidence) {
            (None, None) => Ok(()),
            (None, Some(_)) => Err("mining_persistence_orphan_evidence"),
            (Some(configuration), evidence) => {
                configuration.validate()?;
                if let Some(evidence) = evidence {
                    configuration.status(Some(evidence), evidence.verified_at_unix_seconds, 0)?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct MiningConfigurationPersistence {
    path: PathBuf,
}

impl MiningConfigurationPersistence {
    pub fn from_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn from_default_location() -> Result<Self, &'static str> {
        Ok(Self::from_path(default_data_directory()?.join(FILE_NAME)))
    }

    pub fn load_or_quarantine(&self) -> PersistentMiningConfiguration {
        match self.load() {
            Ok(state) => state,
            Err(_) => {
                let _ = self.quarantine();
                PersistentMiningConfiguration::empty()
            }
        }
    }

    pub fn load(&self) -> Result<PersistentMiningConfiguration, &'static str> {
        if !self.path.exists() {
            return Ok(PersistentMiningConfiguration::empty());
        }
        let content =
            fs::read_to_string(&self.path).map_err(|_| "mining_persistence_read_failed")?;
        let state: PersistentMiningConfiguration =
            serde_json::from_str(&content).map_err(|_| "mining_persistence_decode_failed")?;
        state.validate()?;
        Ok(state)
    }

    pub fn save(&self, state: &PersistentMiningConfiguration) -> Result<(), &'static str> {
        state.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or("mining_persistence_parent_missing")?;
        fs::create_dir_all(parent).map_err(|_| "mining_persistence_directory_failed")?;

        let content =
            serde_json::to_vec_pretty(state).map_err(|_| "mining_persistence_encode_failed")?;
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", std::process::id()));
        let backup = self.path.with_extension("bak");

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "mining_persistence_temp_open_failed")?;
        file.write_all(&content)
            .map_err(|_| "mining_persistence_write_failed")?;
        file.sync_all()
            .map_err(|_| "mining_persistence_sync_failed")?;
        drop(file);

        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| "mining_persistence_backup_cleanup_failed")?;
        }
        if self.path.exists() {
            fs::rename(&self.path, &backup).map_err(|_| "mining_persistence_backup_failed")?;
        }
        if fs::rename(&temporary, &self.path).is_err() {
            if backup.exists() {
                let _ = fs::rename(&backup, &self.path);
            }
            let _ = fs::remove_file(&temporary);
            return Err("mining_persistence_commit_failed");
        }
        if backup.exists() {
            fs::remove_file(&backup).map_err(|_| "mining_persistence_backup_cleanup_failed")?;
        }
        Ok(())
    }

    fn quarantine(&self) -> Result<(), &'static str> {
        if !self.path.exists() {
            return Ok(());
        }
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system_clock_invalid")?
            .as_secs();
        let quarantined = self.path.with_extension(format!("corrupt-{suffix}"));
        fs::rename(&self.path, quarantined).map_err(|_| "mining_persistence_quarantine_failed")
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
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
    use crate::mining_configuration::PoolMode;

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

    fn configuration() -> MiningConfiguration {
        MiningConfiguration {
            enabled: true,
            auto_mine_when_idle: true,
            cryptocurrency: "KAS".into(),
            miner_profile_id: "lolminer_kaspa".into(),
            pool_mode: PoolMode::Custom,
            custom_pool_url: Some("stratum+tcp://pool.example.com:3333".into()),
            wallet_address: "kaspa:qownerwallet".into(),
            worker_name: "host_001".into(),
            pool_credential_ref: Some("secret_pool_001".into()),
        }
    }

    #[test]
    fn round_trip_preserves_configuration_without_raw_secret() {
        let path = unique_path("persistence-round-trip");
        let persistence = MiningConfigurationPersistence::from_path(path.clone());
        let state = PersistentMiningConfiguration {
            schema_version: SCHEMA_VERSION,
            configuration: Some(configuration()),
            connection_evidence: None,
            revision: 4,
        };
        persistence.save(&state).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("secret_pool_001"));
        assert!(!raw.contains("password"));
        assert_eq!(persistence.load().unwrap(), state);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn corrupted_file_is_quarantined_and_defaults_fail_closed() {
        let path = unique_path("persistence-corrupt");
        fs::write(&path, "{not-json").unwrap();
        let persistence = MiningConfigurationPersistence::from_path(path.clone());
        let loaded = persistence.load_or_quarantine();
        assert_eq!(loaded, PersistentMiningConfiguration::empty());
        assert!(!path.exists());
        let parent = path.parent().unwrap();
        let prefix = path.file_stem().unwrap().to_string_lossy();
        assert!(fs::read_dir(parent).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(prefix.as_ref())
                && entry.file_name().to_string_lossy().contains("corrupt-")
        }));
    }
}
