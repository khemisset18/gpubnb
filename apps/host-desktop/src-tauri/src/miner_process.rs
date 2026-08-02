#[path = "approved_miner_manifest.rs"]
mod approved_miner_manifest;
#[path = "mining_catalog/secure_launcher.rs"]
mod secure_launcher;

use crate::mining_configuration::MiningLaunchSpec;
use approved_miner_manifest::{approved_miner_release, validate_release_metadata};
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

const APPROVED_MINER_DIRECTORY_ENV: &str = "GPUBNB_APPROVED_MINER_DIR";
const MAX_ARGUMENT_LEN: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MinerProcessStatus {
    Stopped,
    Running,
    Exited,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerProcessSnapshot {
    pub status: MinerProcessStatus,
    pub pid: Option<u32>,
    pub profile_id: Option<String>,
    pub last_exit_code: Option<i32>,
}

#[derive(Debug)]
pub struct MinerProcessManager {
    approved_root: PathBuf,
    child: Option<Child>,
    profile_id: Option<String>,
    last_exit_code: Option<i32>,
}

impl MinerProcessManager {
    pub fn from_environment() -> Result<Self, &'static str> {
        let root = std::env::var_os(APPROVED_MINER_DIRECTORY_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or("approved_miner_directory_not_configured")?;
        Self::from_approved_root(root)
    }

    pub fn from_approved_root(root: PathBuf) -> Result<Self, &'static str> {
        let root = root
            .canonicalize()
            .map_err(|_| "approved_miner_directory_unavailable")?;
        if !root.is_dir() {
            return Err("approved_miner_directory_invalid");
        }
        Ok(Self {
            approved_root: root,
            child: None,
            profile_id: None,
            last_exit_code: None,
        })
    }

    pub fn start(&mut self, spec: &MiningLaunchSpec) -> Result<MinerProcessSnapshot, &'static str> {
        self.refresh()?;
        if self.child.is_some() {
            return Err("miner_already_running");
        }

        let executable = self.resolve_approved_executable(&spec.miner_profile_id)?;
        let arguments = build_approved_arguments(spec)?;
        let child = Command::new(&executable)
            .args(&arguments)
            .current_dir(&self.approved_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "miner_process_spawn_failed")?;

        self.profile_id = Some(spec.miner_profile_id.clone());
        self.last_exit_code = None;
        self.child = Some(child);
        Ok(self.snapshot())
    }

    pub fn stop(&mut self) -> Result<MinerProcessSnapshot, &'static str> {
        let Some(mut child) = self.child.take() else {
            return Ok(self.snapshot());
        };

        child.kill().map_err(|_| "miner_process_stop_failed")?;
        let status = child.wait().map_err(|_| "miner_process_wait_failed")?;
        self.last_exit_code = status.code();
        self.profile_id = None;
        Ok(self.snapshot())
    }

    pub fn refresh(&mut self) -> Result<MinerProcessSnapshot, &'static str> {
        let Some(child) = self.child.as_mut() else {
            return Ok(self.snapshot());
        };
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "miner_process_status_failed")?
        {
            self.last_exit_code = status.code();
            self.child = None;
            self.profile_id = None;
        }
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> MinerProcessSnapshot {
        MinerProcessSnapshot {
            status: if self.child.is_some() {
                MinerProcessStatus::Running
            } else if self.last_exit_code.is_some() {
                MinerProcessStatus::Exited
            } else {
                MinerProcessStatus::Stopped
            },
            pid: self.child.as_ref().map(Child::id),
            profile_id: self.profile_id.clone(),
            last_exit_code: self.last_exit_code,
        }
    }

    fn resolve_approved_executable(&self, profile_id: &str) -> Result<PathBuf, &'static str> {
        let release = approved_miner_release(profile_id)?;
        validate_release_metadata(&release)?;
        secure_launcher::verify_miner_binary(&self.approved_root, &release.binary_manifest())
            .map(|verified| verified.canonical_path)
    }
}

impl Drop for MinerProcessManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn build_approved_arguments(spec: &MiningLaunchSpec) -> Result<Vec<String>, &'static str> {
    validate_argument(&spec.pool_url)?;
    validate_argument(&spec.wallet_address)?;
    validate_argument(&spec.worker_name)?;
    if spec.pool_credential_ref.is_some() {
        return Err("miner_secret_resolution_required");
    }

    let user = format!("{}.{}", spec.wallet_address, spec.worker_name);
    validate_argument(&user)?;
    match spec.miner_profile_id.as_str() {
        "lolminer_kaspa" => Ok(vec![
            "--algo".into(),
            "KASPA".into(),
            "--pool".into(),
            spec.pool_url.clone(),
            "--user".into(),
            user,
        ]),
        "lolminer_etchash" => Ok(vec![
            "--algo".into(),
            "ETCHASH".into(),
            "--pool".into(),
            spec.pool_url.clone(),
            "--user".into(),
            user,
        ]),
        "lolminer_autolykos" => Ok(vec![
            "--algo".into(),
            "AUTOLYKOS2".into(),
            "--pool".into(),
            spec.pool_url.clone(),
            "--user".into(),
            user,
        ]),
        "trex_kawpow" => Ok(vec![
            "-a".into(),
            "kawpow".into(),
            "-o".into(),
            spec.pool_url.clone(),
            "-u".into(),
            user,
        ]),
        "xmrig_randomx" => Ok(vec![
            "--algo=randomx".into(),
            format!("--url={}", spec.pool_url),
            format!("--user={user}"),
        ]),
        _ => Err("mining_profile_not_approved"),
    }
}

fn validate_argument(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_ARGUMENT_LEN
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("miner_argument_invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(profile: &str) -> MiningLaunchSpec {
        MiningLaunchSpec {
            cryptocurrency: "KAS".into(),
            miner_profile_id: profile.into(),
            pool_url: "stratum+tcp://pool.example.com:3333".into(),
            wallet_address: "wallet123".into(),
            worker_name: "worker01".into(),
            pool_credential_ref: None,
        }
    }

    #[test]
    fn only_allowlisted_profiles_resolve_to_executables() {
        assert!(approved_miner_release("xmrig_randomx").is_ok());
        assert_eq!(
            approved_miner_release("powershell"),
            Err("approved_miner_manifest_missing")
        );
    }

    #[test]
    fn arguments_are_structured_without_shell_fragments() {
        let args = build_approved_arguments(&spec("lolminer_kaspa")).unwrap();
        assert_eq!(args[0], "--algo");
        assert!(args.contains(&"stratum+tcp://pool.example.com:3333".to_owned()));
        assert!(!args.iter().any(|argument| argument.contains("&&")));
    }

    #[test]
    fn unresolved_secret_never_reaches_process_arguments() {
        let mut launch = spec("lolminer_kaspa");
        launch.pool_credential_ref = Some("secret_pool_001".into());
        assert_eq!(
            build_approved_arguments(&launch),
            Err("miner_secret_resolution_required")
        );
    }

    #[test]
    fn unavailable_root_fails_closed() {
        let missing = std::env::temp_dir().join("gpubnb-missing-approved-miner-root");
        assert!(matches!(
            MinerProcessManager::from_approved_root(missing),
            Err("approved_miner_directory_unavailable")
        ));
    }

    #[test]
    fn tampered_approved_binary_is_rejected_before_spawn() {
        let root =
            std::env::temp_dir().join(format!("gpubnb-tampered-miner-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let manager = MinerProcessManager::from_approved_root(root.clone()).unwrap();
        let release = approved_miner_release("xmrig_randomx").unwrap();
        std::fs::write(root.join(release.binary_file_name), b"tampered miner").unwrap();

        assert_eq!(
            manager.resolve_approved_executable("xmrig_randomx"),
            Err("miner_binary_hash_mismatch")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
