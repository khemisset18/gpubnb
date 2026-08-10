//! Reconciles the in-memory mining/rental state with what is *actually* running on the
//! machine before that state is trusted.
//!
//! `RentalMiningCoordinator` and `MinerProcessManager` both reset to a clean slate
//! (`Idle`, no process handle) on every process start, because their state lives only in
//! memory. If the host crashes — or is simply killed by a power cut — while a miner or a
//! rental workspace was running, the next launch has no memory of that and will happily
//! report `Idle`/`Available` while a real XMRig/lolMiner process, or a real rental
//! container, is still alive on the machine. This module is what stands between "the
//! process just started" and "it's safe to say Idle".
//!
//! `RealSystemInspector`, `approved_binary_paths`, and the production entry point are
//! only ever driven by `MiningRuntimeController::reconciled_at_startup`, which the real
//! desktop app calls but the package's plain `cargo test` (built without the
//! `desktop-runtime` feature, per every integration test binary in this crate) does not
//! exercise — hence the blanket allow below, matching the same convention already used
//! crate-wide in `lib.rs`.
#![cfg_attr(not(feature = "desktop-runtime"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use crate::rental_mining_coordinator::RentalMiningCoordinator;

// Deliberately specific, not a bare "gpubnb-" prefix: this machine also runs unrelated
// local dev infrastructure under that same loose prefix (docker-compose's default
// "<project>-<service>-<n>" naming produces containers like "gpubnb-postgres-1" and
// "gpubnb-redis-1" for the API's dev database). A broad prefix would quarantine the
// host every time those happened to be running. These are the exact container-name
// prefixes the agent's runner.py actually uses today (diagnostic/proof/protection-probe
// containers); extend this list if a real long-lived rental workspace container gets
// its own naming scheme.
const GPUBNB_CONTAINER_PREFIXES: [&str; 3] = [
    "gpubnb-diagnostic-",
    "gpubnb-proof-",
    "gpubnb-protection-probe-",
];
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINATION_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// A real, currently-running process whose executable resolves to one of our own
/// verified, approved miner binaries — never a guess based on process name alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrphanedMinerProcess {
    pub pid: u32,
    pub profile_id: String,
    pub executable_path: PathBuf,
}

/// Read-only view of the machine, plus the one privileged action (terminating a process
/// this module has already positively identified as ours). Kept as a trait so the
/// reconciliation policy below can be tested without touching the real OS or Docker.
pub trait SystemInspector {
    /// Every process currently running on the machine, as (pid, executable path).
    /// Must fail rather than return a partial list: a partial list would let a real
    /// orphan slip past undetected.
    fn running_processes(&self) -> Result<Vec<(u32, PathBuf)>, &'static str>;
    /// Names of GPUbnb-owned containers currently running (workspace or otherwise).
    fn gpubnb_containers(&self) -> Result<Vec<String>, &'static str>;
    fn terminate_pid(&self, pid: u32) -> Result<(), &'static str>;
    fn pid_is_running(&self, pid: u32) -> Result<bool, &'static str>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReconciliationOutcome {
    /// Nothing of ours was found running. Safe to start from `Idle`.
    Clean,
    /// Miner process(es) survived a crash with no rental in sight. They have already
    /// been stopped and their disappearance verified. Mining does not resume on its
    /// own: it stays `Idle` until something (the owner, or a rental) explicitly
    /// requests it again, which is what proves no reservation raced this reboot.
    RecoveredOrphanedMiners(Vec<OrphanedMinerProcess>),
    /// Either a rental/workspace container survived (we cannot prove locally whether
    /// its reservation is still legitimate) or an orphaned miner could not be
    /// conclusively verified dead. Fail closed: quarantined until a human or the
    /// backend-authoritative caller resolves it.
    Quarantined {
        reason: &'static str,
        orphaned_miners: Vec<OrphanedMinerProcess>,
        orphaned_containers: Vec<String>,
    },
}

/// Pure reconciliation policy: given what the inspector reports and the set of
/// binaries we know to be genuinely ours (already hash-verified by the caller),
/// decide what actually happened and land the coordinator in the right state.
pub fn reconcile(
    inspector: &dyn SystemInspector,
    approved_binaries: &[(String, PathBuf)],
) -> (RentalMiningCoordinator, ReconciliationOutcome) {
    let processes = match inspector.running_processes() {
        Ok(processes) => processes,
        Err(_) => return quarantined_outcome("reconciliation_process_inspection_failed"),
    };
    let containers = match inspector.gpubnb_containers() {
        Ok(containers) => containers,
        Err(_) => return quarantined_outcome("reconciliation_container_inspection_failed"),
    };

    let orphaned_miners: Vec<OrphanedMinerProcess> = processes
        .into_iter()
        .filter_map(|(pid, observed_path)| {
            approved_binaries
                .iter()
                .find(|(_, approved_path)| paths_match(approved_path, &observed_path))
                .map(|(profile_id, approved_path)| OrphanedMinerProcess {
                    pid,
                    profile_id: profile_id.clone(),
                    executable_path: approved_path.clone(),
                })
        })
        .collect();
    let orphaned_containers: Vec<String> = containers
        .into_iter()
        .filter(|name| {
            GPUBNB_CONTAINER_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix))
        })
        .collect();

    if orphaned_miners.is_empty() && orphaned_containers.is_empty() {
        return (
            RentalMiningCoordinator::default(),
            ReconciliationOutcome::Clean,
        );
    }

    // A miner must never keep running once we can't prove there is no conflicting
    // rental, so it is stopped first and unconditionally, regardless of what else
    // reconciliation finds.
    let mut termination_unverified = false;
    for orphan in &orphaned_miners {
        if stop_and_verify_gone(inspector, orphan.pid).is_err() {
            termination_unverified = true;
        }
    }

    if !termination_unverified && orphaned_containers.is_empty() {
        return (
            RentalMiningCoordinator::default(),
            ReconciliationOutcome::RecoveredOrphanedMiners(orphaned_miners),
        );
    }

    let reason = if termination_unverified {
        "reconciliation_orphan_termination_unverified"
    } else if orphaned_miners.is_empty() {
        "reconciliation_orphaned_rental_container"
    } else {
        "reconciliation_orphaned_miner_and_rental_container"
    };
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator.quarantine_from_reconciliation(reason);
    (
        coordinator,
        ReconciliationOutcome::Quarantined {
            reason,
            orphaned_miners,
            orphaned_containers,
        },
    )
}

fn quarantined_outcome(reason: &'static str) -> (RentalMiningCoordinator, ReconciliationOutcome) {
    let mut coordinator = RentalMiningCoordinator::default();
    coordinator.quarantine_from_reconciliation(reason);
    (
        coordinator,
        ReconciliationOutcome::Quarantined {
            reason,
            orphaned_miners: Vec::new(),
            orphaned_containers: Vec::new(),
        },
    )
}

fn stop_and_verify_gone(inspector: &dyn SystemInspector, pid: u32) -> Result<(), &'static str> {
    inspector.terminate_pid(pid)?;
    let deadline = Instant::now() + TERMINATION_TIMEOUT;
    loop {
        if !inspector.pid_is_running(pid)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("reconciliation_orphan_termination_unverified");
        }
        thread::sleep(TERMINATION_POLL_INTERVAL);
    }
}

/// Only ever matches an observed process against an approved binary when the
/// observed path can itself be canonicalized right now (i.e. the file it was
/// launched from still exists and resolves). A process we can't positively
/// resolve is left alone rather than guessed at — see module docs.
fn paths_match(approved: &Path, observed: &Path) -> bool {
    match observed.canonicalize() {
        Ok(canonical_observed) => canonical_observed == approved,
        Err(_) => false,
    }
}

/// Resolves the set of (profile_id, canonical_path) pairs for miner binaries that are
/// actually installed and hash-verified right now under `approved_root`. Profiles that
/// are not installed, or whose binary is missing or tampered, are silently skipped:
/// they cannot be the source of a running orphan if we cannot even verify them.
pub fn approved_binary_paths(approved_root: &Path) -> Vec<(String, PathBuf)> {
    const APPROVED_PROFILE_IDS: [&str; 4] = [
        "xmrig_randomx",
        "lolminer_blake3",
        "lolminer_etchash",
        "lolminer_octopus",
    ];
    APPROVED_PROFILE_IDS
        .iter()
        .filter_map(|profile_id| {
            let release =
                crate::approved_miner_manifest::approved_miner_release(profile_id).ok()?;
            let verified = crate::secure_launcher::verify_miner_binary(
                approved_root,
                &release.binary_manifest(),
            )
            .ok()?;
            Some((profile_id.to_string(), verified.canonical_path))
        })
        .collect()
}

#[derive(Default)]
pub struct RealSystemInspector;

#[cfg(target_os = "windows")]
impl SystemInspector for RealSystemInspector {
    fn running_processes(&self) -> Result<Vec<(u32, PathBuf)>, &'static str> {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
            ])
            .output()
            .map_err(|_| "process_enumeration_failed")?;
        if !output.status.success() {
            return Err("process_enumeration_failed");
        }
        let text =
            String::from_utf8(output.stdout).map_err(|_| "process_enumeration_invalid_output")?;
        parse_win32_processes(&text)
    }

    fn gpubnb_containers(&self) -> Result<Vec<String>, &'static str> {
        list_running_containers()
    }

    fn terminate_pid(&self, pid: u32) -> Result<(), &'static str> {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .status()
            .map_err(|_| "process_termination_failed")?;
        if status.success() {
            Ok(())
        } else {
            Err("process_termination_failed")
        }
    }

    fn pid_is_running(&self, pid: u32) -> Result<bool, &'static str> {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("[bool](Get-Process -Id {pid} -ErrorAction SilentlyContinue)"),
            ])
            .output()
            .map_err(|_| "process_liveness_check_failed")?;
        if !output.status.success() {
            return Err("process_liveness_check_failed");
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("true"))
    }
}

#[cfg(not(target_os = "windows"))]
impl SystemInspector for RealSystemInspector {
    fn running_processes(&self) -> Result<Vec<(u32, PathBuf)>, &'static str> {
        Err("system_inspection_not_supported_on_this_platform")
    }

    fn gpubnb_containers(&self) -> Result<Vec<String>, &'static str> {
        list_running_containers()
    }

    fn terminate_pid(&self, _pid: u32) -> Result<(), &'static str> {
        Err("system_inspection_not_supported_on_this_platform")
    }

    fn pid_is_running(&self, _pid: u32) -> Result<bool, &'static str> {
        Err("system_inspection_not_supported_on_this_platform")
    }
}

fn list_running_containers() -> Result<Vec<String>, &'static str> {
    let output = Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .output()
        .map_err(|_| "container_enumeration_failed")?;
    if !output.status.success() {
        return Err("container_enumeration_failed");
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

#[cfg(target_os = "windows")]
fn parse_win32_processes(json_text: &str) -> Result<Vec<(u32, PathBuf)>, &'static str> {
    let value: serde_json::Value =
        serde_json::from_str(json_text).map_err(|_| "process_enumeration_invalid_output")?;
    let entries: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(_) => vec![&value],
        _ => return Err("process_enumeration_invalid_output"),
    };
    Ok(entries
        .into_iter()
        .filter_map(|entry| {
            let pid = entry.get("ProcessId")?.as_u64()?;
            let path = entry.get("ExecutablePath")?.as_str()?;
            if path.is_empty() {
                return None;
            }
            Some((pid as u32, PathBuf::from(path)))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_binary(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gpubnb-reconciliation-test-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(name);
        fs::write(&path, b"fake approved binary").unwrap();
        path.canonicalize().unwrap()
    }

    struct FakeInspector {
        processes: Result<Vec<(u32, PathBuf)>, &'static str>,
        containers: Result<Vec<String>, &'static str>,
        terminated: Mutex<Vec<u32>>,
        alive_after_termination: HashMap<u32, bool>,
    }

    impl FakeInspector {
        fn new(processes: Vec<(u32, PathBuf)>, containers: Vec<String>) -> Self {
            Self {
                processes: Ok(processes),
                containers: Ok(containers),
                terminated: Mutex::new(Vec::new()),
                alive_after_termination: HashMap::new(),
            }
        }

        fn with_unverifiable_termination(mut self, pid: u32) -> Self {
            self.alive_after_termination.insert(pid, true);
            self
        }
    }

    impl SystemInspector for FakeInspector {
        fn running_processes(&self) -> Result<Vec<(u32, PathBuf)>, &'static str> {
            self.processes.clone()
        }

        fn gpubnb_containers(&self) -> Result<Vec<String>, &'static str> {
            self.containers.clone()
        }

        fn terminate_pid(&self, pid: u32) -> Result<(), &'static str> {
            self.terminated.lock().unwrap().push(pid);
            Ok(())
        }

        fn pid_is_running(&self, pid: u32) -> Result<bool, &'static str> {
            Ok(*self.alive_after_termination.get(&pid).unwrap_or(&false))
        }
    }

    #[test]
    fn clean_boot_reports_no_orphans_and_stays_idle() {
        let inspector = FakeInspector::new(Vec::new(), Vec::new());
        let (coordinator, outcome) = reconcile(&inspector, &[]);
        assert_eq!(outcome, ReconciliationOutcome::Clean);
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Idle
        );
    }

    #[test]
    fn unrelated_dev_infrastructure_sharing_the_gpubnb_prefix_is_not_a_workspace_orphan() {
        // Reproduces this exact machine's docker-compose dev database containers
        // (gpubnb-postgres-1, gpubnb-redis-1) — a bare "gpubnb-" prefix would have
        // quarantined the host every time those happened to be running.
        let inspector = FakeInspector::new(
            Vec::new(),
            vec!["gpubnb-postgres-1".into(), "gpubnb-redis-1".into()],
        );
        let (coordinator, outcome) = reconcile(&inspector, &[]);
        assert_eq!(outcome, ReconciliationOutcome::Clean);
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Idle
        );
    }

    #[test]
    fn unidentified_processes_are_never_touched() {
        let approved = temp_binary("xmrig");
        let unrelated = temp_binary("notepad.exe");
        let inspector = FakeInspector::new(vec![(999, unrelated)], Vec::new());
        let (_, outcome) = reconcile(&inspector, &[("xmrig_randomx".into(), approved)]);
        assert_eq!(outcome, ReconciliationOutcome::Clean);
        assert!(inspector.terminated.lock().unwrap().is_empty());
    }

    #[test]
    fn orphaned_miner_from_a_crash_during_mining_is_stopped_and_verified() {
        let approved = temp_binary("xmrig");
        let inspector = FakeInspector::new(vec![(4242, approved.clone())], Vec::new());
        let (coordinator, outcome) =
            reconcile(&inspector, &[("xmrig_randomx".into(), approved.clone())]);
        assert_eq!(inspector.terminated.lock().unwrap().as_slice(), &[4242]);
        assert_eq!(
            outcome,
            ReconciliationOutcome::RecoveredOrphanedMiners(vec![OrphanedMinerProcess {
                pid: 4242,
                profile_id: "xmrig_randomx".into(),
                executable_path: approved,
            }])
        );
        // Recovering from an orphan never resumes mining on its own: only an explicit,
        // later request (which is what proves no reservation raced this reboot) can.
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Idle
        );
        assert!(!coordinator.snapshot().should_start_mining);
    }

    #[test]
    fn orphaned_rental_container_from_a_crash_during_rental_quarantines() {
        let inspector = FakeInspector::new(Vec::new(), vec!["gpubnb-proof-abc123".into()]);
        let (coordinator, outcome) = reconcile(&inspector, &[]);
        assert_eq!(
            outcome,
            ReconciliationOutcome::Quarantined {
                reason: "reconciliation_orphaned_rental_container",
                orphaned_miners: Vec::new(),
                orphaned_containers: vec!["gpubnb-proof-abc123".into()],
            }
        );
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Quarantined
        );
    }

    #[test]
    fn simultaneous_miner_and_rental_container_stops_the_miner_and_still_quarantines() {
        let approved = temp_binary("xmrig");
        let inspector =
            FakeInspector::new(vec![(7, approved.clone())], vec!["gpubnb-proof-xyz".into()]);
        let (coordinator, outcome) = reconcile(&inspector, &[("xmrig_randomx".into(), approved)]);
        assert_eq!(inspector.terminated.lock().unwrap().as_slice(), &[7]);
        match outcome {
            ReconciliationOutcome::Quarantined {
                reason,
                orphaned_miners,
                orphaned_containers,
            } => {
                assert_eq!(reason, "reconciliation_orphaned_miner_and_rental_container");
                assert_eq!(orphaned_miners.len(), 1);
                assert_eq!(orphaned_containers, vec!["gpubnb-proof-xyz".to_string()]);
            }
            other => panic!("expected Quarantined, got {other:?}"),
        }
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Quarantined
        );
    }

    #[test]
    fn unverifiable_termination_quarantines_even_without_a_container() {
        let approved = temp_binary("xmrig");
        let inspector = FakeInspector::new(vec![(11, approved.clone())], Vec::new())
            .with_unverifiable_termination(11);
        let (coordinator, outcome) = reconcile(&inspector, &[("xmrig_randomx".into(), approved)]);
        match outcome {
            ReconciliationOutcome::Quarantined { reason, .. } => {
                assert_eq!(reason, "reconciliation_orphan_termination_unverified");
            }
            other => panic!("expected Quarantined, got {other:?}"),
        }
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Quarantined
        );
    }

    #[test]
    fn inconsistent_state_from_a_failed_inspection_fails_closed() {
        let mut inspector = FakeInspector::new(Vec::new(), Vec::new());
        inspector.processes = Err("wmi_unavailable");
        let (coordinator, outcome) = reconcile(&inspector, &[]);
        assert_eq!(
            outcome,
            ReconciliationOutcome::Quarantined {
                reason: "reconciliation_process_inspection_failed",
                orphaned_miners: Vec::new(),
                orphaned_containers: Vec::new(),
            }
        );
        assert_eq!(
            coordinator.snapshot().state,
            crate::rental_mining_coordinator::CoordinatedGpuState::Quarantined
        );
        assert!(inspector.terminated.lock().unwrap().is_empty());
    }

    #[test]
    fn container_inspection_failure_also_fails_closed_without_touching_processes() {
        let approved = temp_binary("xmrig");
        let mut inspector = FakeInspector::new(vec![(5, approved.clone())], Vec::new());
        inspector.containers = Err("docker_unavailable");
        let (_, outcome) = reconcile(&inspector, &[("xmrig_randomx".into(), approved)]);
        assert_eq!(
            outcome,
            ReconciliationOutcome::Quarantined {
                reason: "reconciliation_container_inspection_failed",
                orphaned_miners: Vec::new(),
                orphaned_containers: Vec::new(),
            }
        );
        assert!(inspector.terminated.lock().unwrap().is_empty());
    }
}
