use crate::approved_miner_manifest::{approved_miner_release, validate_release_metadata};
use crate::mining_configuration::MiningLaunchSpec;
use crate::secure_launcher;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const APPROVED_MINER_DIRECTORY_ENV: &str = "GPUBNB_APPROVED_MINER_DIR";
const MAX_ARGUMENT_LEN: usize = 512;
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(25);
const STDOUT_LOG_NAME: &str = "miner-stdout.log";
const STDERR_LOG_NAME: &str = "miner-stderr.log";

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
    log_threads: Vec<JoinHandle<()>>,
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
            log_threads: Vec::new(),
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
        let (stdout_log, stderr_log) = self.prepare_logs()?;
        let mut child = Command::new(&executable)
            .args(&arguments)
            .current_dir(&self.approved_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "miner_process_spawn_failed")?;

        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("miner_stdout_capture_failed");
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("miner_stderr_capture_failed");
        };
        self.log_threads = vec![
            spawn_log_drain(stdout, stdout_log),
            spawn_log_drain(stderr, stderr_log),
        ];

        self.profile_id = Some(spec.miner_profile_id.clone());
        self.last_exit_code = None;
        self.child = Some(child);
        Ok(self.snapshot())
    }

    pub fn stop(&mut self) -> Result<MinerProcessSnapshot, &'static str> {
        let Some(mut child) = self.child.take() else {
            return Ok(self.snapshot());
        };

        match child.try_wait() {
            Ok(Some(status)) => {
                self.finish_log_threads();
                self.last_exit_code = status.code();
                self.profile_id = None;
                return Ok(self.snapshot());
            }
            Ok(None) => {}
            Err(_) => {
                self.child = Some(child);
                return Err("miner_process_wait_failed");
            }
        }

        if let Err(error) = child.kill() {
            self.child = Some(child);
            return Err(if error.kind() == io::ErrorKind::InvalidInput {
                "miner_process_stop_invalid"
            } else {
                "miner_process_stop_failed"
            });
        }
        let status = match wait_for_exit(&mut child, STOP_TIMEOUT) {
            Ok(Some(status)) => status,
            Ok(None) => {
                self.child = Some(child);
                return Err("miner_process_stop_timeout");
            }
            Err(error) => {
                self.child = Some(child);
                return Err(error);
            }
        };
        self.finish_log_threads();
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
            self.finish_log_threads();
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

    fn prepare_logs(&self) -> Result<(File, File), &'static str> {
        let log_root = self.approved_root.join("logs");
        fs::create_dir_all(&log_root).map_err(|_| "miner_log_directory_failed")?;
        let stdout_path = log_root.join(STDOUT_LOG_NAME);
        let stderr_path = log_root.join(STDERR_LOG_NAME);
        rotate_log(&stdout_path, MAX_LOG_BYTES)?;
        rotate_log(&stderr_path, MAX_LOG_BYTES)?;
        Ok((
            open_private_log(&stdout_path)?,
            open_private_log(&stderr_path)?,
        ))
    }

    fn finish_log_threads(&mut self) {
        for thread in self.log_threads.drain(..) {
            let _ = thread.join();
        }
    }
}

impl Drop for MinerProcessManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.finish_log_threads();
    }
}

fn open_private_log(path: &Path) -> Result<File, &'static str> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path).map_err(|_| "miner_log_open_failed")?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "miner_log_permissions_failed")?;
    Ok(file)
}

fn rotate_log(path: &Path, max_bytes: u64) -> Result<(), &'static str> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < max_bytes {
        return Ok(());
    }
    let backup = path.with_extension("log.1");
    if backup.exists() {
        fs::remove_file(&backup).map_err(|_| "miner_log_rotation_failed")?;
    }
    fs::rename(path, backup).map_err(|_| "miner_log_rotation_failed")
}

fn spawn_log_drain<R>(reader: R, log: File) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let _ = drain_to_capped_log(reader, log, MAX_LOG_BYTES);
    })
}

fn drain_to_capped_log<R: Read>(mut reader: R, mut log: File, max_bytes: u64) -> io::Result<()> {
    let mut written = log
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or(max_bytes);
    let mut log_writable = written < max_bytes;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return if log_writable { log.flush() } else { Ok(()) };
        }
        let remaining = max_bytes.saturating_sub(written) as usize;
        let accepted = read.min(remaining);
        if log_writable && accepted > 0 {
            if log.write_all(&buffer[..accepted]).is_ok() {
                written += accepted as u64;
                log_writable = written < max_bytes;
            } else {
                log_writable = false;
            }
        }
    }
}

fn wait_for_exit(
    child: &mut Child,
    timeout: Duration,
) -> Result<Option<std::process::ExitStatus>, &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|_| "miner_process_wait_failed")? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(STOP_POLL_INTERVAL);
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

    #[test]
    fn log_writer_drains_input_and_enforces_the_hard_cap() {
        let root = std::env::temp_dir().join(format!("gpubnb-capped-log-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("miner.log");
        let log = open_private_log(&path).unwrap();

        drain_to_capped_log(io::Cursor::new(b"0123456789"), log, 4).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"0123");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_log_is_rotated_before_the_next_launch() {
        let root = std::env::temp_dir().join(format!("gpubnb-rotated-log-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("miner.log");
        std::fs::write(&path, b"12345").unwrap();

        rotate_log(&path, 4).unwrap();

        assert!(!path.exists());
        assert_eq!(
            std::fs::read(path.with_extension("log.1")).unwrap(),
            b"12345"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
