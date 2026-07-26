use serde::Serialize;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_COMMAND_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_GPU_COUNT: usize = 32;
const MAX_VRAM_MIB: u64 = 2_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationBackend {
    HyperV,
    VirtualizationFramework,
    Kvm,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub index: u32,
    pub uuid: String,
    pub model: String,
    pub driver_version: String,
    pub vram_mib: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProbeEvidence {
    gpus: Vec<GpuDevice>,
    docker_installed: bool,
    docker_reachable: bool,
    nvidia_runtime_available: bool,
    isolation_available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnostic {
    pub platform_supported: bool,
    pub architecture_supported: bool,
    pub isolation_backend: IsolationBackend,
    pub requires_administrator: bool,
    pub can_host: bool,
    pub reason: &'static str,
    pub gpus: Vec<GpuDevice>,
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }

                let output = child.wait_with_output().ok()?;
                if output.stdout.len() > MAX_COMMAND_OUTPUT_BYTES {
                    return None;
                }

                return String::from_utf8(output.stdout)
                    .ok()
                    .map(|value| value.trim().to_owned());
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn parse_gpu_line(line: &str) -> Option<GpuDevice> {
    let fields: Vec<&str> = line.split(',').map(str::trim).collect();
    if fields.len() != 5 || fields.iter().any(|field| field.is_empty()) {
        return None;
    }

    let vram_mib = fields[3].parse::<u64>().ok()?;
    let index = fields[4].parse::<u32>().ok()?;
    if vram_mib == 0 || vram_mib > MAX_VRAM_MIB {
        return None;
    }

    let uuid = fields[0];
    if !uuid.starts_with("GPU-") || uuid.len() > 128 {
        return None;
    }

    let model: String = fields[1].chars().take(160).collect();
    let driver_version: String = fields[2].chars().take(64).collect();
    if model.is_empty() || driver_version.is_empty() {
        return None;
    }

    Some(GpuDevice {
        index,
        uuid: uuid.to_owned(),
        model,
        driver_version,
        vram_mib,
    })
}

fn parse_gpu_inventory(value: &str) -> Vec<GpuDevice> {
    let mut seen_uuids = HashSet::new();
    let mut seen_indexes = HashSet::new();

    value
        .lines()
        .filter_map(parse_gpu_line)
        .filter(|gpu| seen_uuids.insert(gpu.uuid.clone()))
        .filter(|gpu| seen_indexes.insert(gpu.index))
        .take(MAX_GPU_COUNT)
        .collect()
}

fn gpu_inventory() -> Vec<GpuDevice> {
    command_output(
        "nvidia-smi",
        &[
            "--query-gpu=uuid,name,driver_version,memory.total,index",
            "--format=csv,noheader,nounits",
        ],
    )
    .map(|value| parse_gpu_inventory(&value))
    .unwrap_or_default()
}

fn docker_evidence() -> (bool, bool, bool) {
    let installed = command_output("docker", &["--version"]).is_some();
    if !installed {
        return (false, false, false);
    }

    let runtimes = command_output("docker", &["info", "--format", "{{json .Runtimes}}"];);
    let reachable = runtimes.as_ref().is_some_and(|value| !value.is_empty());
    let nvidia = runtimes
        .as_ref()
        .is_some_and(|value| value.contains("nvidia"));
    (installed, reachable, nvidia)
}

fn kvm_accessible(path: &Path) -> bool {
    OpenOptions::new().read(true).write(true).open(path).is_ok()
}

fn isolation_available(os: &str) -> bool {
    match os {
        "linux" => kvm_accessible(Path::new("/dev/kvm")),
        "windows" => command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent",
            ],
        )
        .is_some_and(|value| value.eq_ignore_ascii_case("true")),
        "macos" => command_output("sysctl", &["-n", "kern.hv_support"])
            .is_some_and(|value| value == "1"),
        _ => false,
    }
}

pub fn collect_native_diagnostic() -> NativeDiagnostic {
    let (docker_installed, docker_reachable, nvidia_runtime_available) = docker_evidence();
    let evidence = ProbeEvidence {
        gpus: gpu_inventory(),
        docker_installed,
        docker_reachable,
        nvidia_runtime_available,
        isolation_available: isolation_available(std::env::consts::OS),
    };

    evaluate(std::env::consts::OS, std::env::consts::ARCH, evidence)
}

fn evaluate(os: &str, architecture: &str, evidence: ProbeEvidence) -> NativeDiagnostic {
    let platform_supported = matches!(os, "windows" | "macos" | "linux");
    let architecture_supported = matches!(architecture, "x86_64" | "aarch64");
    let isolation_backend = match os {
        "windows" => IsolationBackend::HyperV,
        "macos" => IsolationBackend::VirtualizationFramework,
        "linux" => IsolationBackend::Kvm,
        _ => IsolationBackend::Unsupported,
    };

    let reason = if !platform_supported {
        "operating_system_not_supported"
    } else if !architecture_supported {
        "architecture_not_supported"
    } else if evidence.gpus.is_empty() {
        "nvidia_gpu_not_detected"
    } else if !evidence.docker_installed {
        "docker_not_installed"
    } else if !evidence.docker_reachable {
        "docker_daemon_unreachable"
    } else if !evidence.nvidia_runtime_available {
        "nvidia_container_runtime_missing"
    } else if !evidence.isolation_available {
        "hardware_isolation_unavailable"
    } else {
        "native_prerequisites_ready"
    };

    NativeDiagnostic {
        platform_supported,
        architecture_supported,
        isolation_backend,
        requires_administrator: matches!(os, "windows" | "linux"),
        can_host: reason == "native_prerequisites_ready",
        reason,
        gpus: evidence.gpus,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(index: u32) -> GpuDevice {
        GpuDevice {
            index,
            uuid: format!("GPU-test-{index}"),
            model: "NVIDIA Test GPU".into(),
            driver_version: "999.1".into(),
            vram_mib: 24_576,
        }
    }

    fn ready_evidence() -> ProbeEvidence {
        ProbeEvidence {
            gpus: vec![gpu(0)],
            docker_installed: true,
            docker_reachable: true,
            nvidia_runtime_available: true,
            isolation_available: true,
        }
    }

    #[test]
    fn parses_multiple_bounded_gpu_devices() {
        let inventory = parse_gpu_inventory(
            "GPU-1, NVIDIA RTX 4090, 560.1, 24576, 0\n\
             GPU-2, NVIDIA RTX 3090, 560.1, 24576, 1",
        );

        assert_eq!(inventory.len(), 2);
        assert_eq!(inventory[0].index, 0);
        assert_eq!(inventory[1].model, "NVIDIA RTX 3090");
        assert!(parse_gpu_inventory("broken").is_empty());
    }

    #[test]
    fn duplicate_gpu_identity_is_ignored() {
        let inventory = parse_gpu_inventory(
            "GPU-1, NVIDIA RTX, 560.1, 24576, 0\n\
             GPU-1, NVIDIA RTX, 560.1, 24576, 1\n\
             GPU-2, NVIDIA RTX, 560.1, 24576, 0",
        );

        assert_eq!(inventory.len(), 1);
    }

    #[test]
    fn malformed_or_unbounded_gpu_data_is_rejected() {
        assert!(parse_gpu_inventory("broken").is_empty());
        assert!(parse_gpu_inventory("GPU-1, RTX, driver, 0, 0").is_empty());
        assert!(parse_gpu_inventory("GPU-1, RTX, driver, 2000001, 0").is_empty());
        assert!(
            parse_gpu_inventory("not-a-gpu, RTX, driver, 24576, 0").is_empty()
        );
    }

    #[test]
    fn inaccessible_kvm_device_fails_closed() {
        let missing = std::env::temp_dir().join("gpubnb-kvm-device-that-does-not-exist");
        assert!(!kvm_accessible(&missing));
    }

    #[test]
    fn ready_machine_receives_certificate() {
        let diagnostic = evaluate("linux", "x86_64", ready_evidence());

        assert!(diagnostic.can_host);
        assert_eq!(diagnostic.reason, "native_prerequisites_ready");
        assert_eq!(diagnostic.gpus, vec![gpu(0)]);
    }

    #[test]
    fn every_missing_control_fails_closed() {
        let mut evidence = ready_evidence();
        evidence.nvidia_runtime_available = false;
        let diagnostic = evaluate("linux", "x86_64", evidence);

        assert!(!diagnostic.can_host);
        assert_eq!(diagnostic.reason, "nvidia_container_runtime_missing");
    }

    #[test]
    fn unknown_platform_and_architecture_fail_closed() {
        let platform = evaluate("unknown", "x86_64", ready_evidence());
        assert!(!platform.can_host);
        assert_eq!(platform.isolation_backend, IsolationBackend::Unsupported);

        let architecture = evaluate("linux", "mips", ready_evidence());
        assert!(!architecture.can_host);
        assert_eq!(architecture.reason, "architecture_not_supported");
    }

    #[test]
    fn serialized_snapshot_contains_the_collected_inventory() {
        let diagnostic = evaluate("linux", "x86_64", ready_evidence());
        let serialized = serde_json::to_value(diagnostic).expect("diagnostic must serialize");

        assert_eq!(serialized["gpus"][0]["uuid"], "GPU-test-0");
        assert_eq!(serialized["gpus"][0]["vramMib"], 24_576);
    }
}
