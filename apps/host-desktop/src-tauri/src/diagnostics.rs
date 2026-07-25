use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_COMMAND_OUTPUT_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationBackend {
    HyperV,
    VirtualizationFramework,
    Kvm,
    Unsupported,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProbeEvidence {
    gpu_detected: bool,
    gpu_model: Option<String>,
    gpu_uuid: Option<String>,
    vram_mib: Option<u64>,
    driver_version: Option<String>,
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
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn parse_gpu_evidence(value: &str) -> ProbeEvidence {
    let Some(line) = value.lines().next() else {
        return ProbeEvidence::default();
    };
    let fields: Vec<&str> = line.split(',').map(str::trim).collect();
    if fields.len() != 5 || fields.iter().any(|field| field.is_empty()) {
        return ProbeEvidence::default();
    }
    let Ok(vram_mib) = fields[3].parse::<u64>() else {
        return ProbeEvidence::default();
    };
    if vram_mib == 0 || vram_mib > 2_000_000 {
        return ProbeEvidence::default();
    }
    ProbeEvidence {
        gpu_detected: true,
        gpu_uuid: Some(fields[0].to_owned()),
        gpu_model: Some(fields[1].to_owned()),
        driver_version: Some(fields[2].to_owned()),
        vram_mib: Some(vram_mib),
        ..ProbeEvidence::default()
    }
}

fn gpu_evidence() -> ProbeEvidence {
    command_output(
        "nvidia-smi",
        &[
            "--query-gpu=uuid,name,driver_version,memory.total,index",
            "--format=csv,noheader,nounits",
            "--id=0",
        ],
    )
    .map(|value| parse_gpu_evidence(&value))
    .unwrap_or_default()
}

fn docker_evidence() -> (bool, bool, bool) {
    let installed = command_output("docker", &["--version"]).is_some();
    if !installed {
        return (false, false, false);
    }
    let runtimes = command_output("docker", &["info", "--format", "{{json .Runtimes}}"]);
    let reachable = runtimes.as_ref().is_some_and(|value| !value.is_empty());
    let nvidia = runtimes.as_ref().is_some_and(|value| value.contains("nvidia"));
    (installed, reachable, nvidia)
}

fn isolation_available(os: &str) -> bool {
    match os {
        "linux" => Path::new("/dev/kvm").exists(),
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
    let mut evidence = gpu_evidence();
    let (docker_installed, docker_reachable, nvidia_runtime_available) = docker_evidence();
    evidence.docker_installed = docker_installed;
    evidence.docker_reachable = docker_reachable;
    evidence.nvidia_runtime_available = nvidia_runtime_available;
    evidence.isolation_available = isolation_available(std::env::consts::OS);
    evaluate(std::env::consts::OS, std::env::consts::ARCH, &evidence)
}

fn evaluate(os: &str, architecture: &str, evidence: &ProbeEvidence) -> NativeDiagnostic {
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
    } else if !evidence.gpu_detected {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_evidence() -> ProbeEvidence {
        ProbeEvidence {
            gpu_detected: true,
            gpu_model: Some("NVIDIA Test GPU".into()),
            gpu_uuid: Some("GPU-test".into()),
            vram_mib: Some(24_576),
            driver_version: Some("999.1".into()),
            docker_installed: true,
            docker_reachable: true,
            nvidia_runtime_available: true,
            isolation_available: true,
        }
    }

    #[test]
    fn parses_bounded_gpu_evidence() {
        let evidence = parse_gpu_evidence("GPU-1, NVIDIA RTX, 560.1, 24576, 0");
        assert!(evidence.gpu_detected);
        assert_eq!(evidence.vram_mib, Some(24_576));
        assert_eq!(evidence.gpu_model.as_deref(), Some("NVIDIA RTX"));
        assert!(!parse_gpu_evidence("broken").gpu_detected);
    }

    #[test]
    fn ready_machine_receives_certificate() {
        let evidence = ready_evidence();
        let diagnostic = evaluate("linux", "x86_64", &evidence);
        assert!(diagnostic.can_host);
        assert_eq!(diagnostic.reason, "native_prerequisites_ready");
    }

    #[test]
    fn every_missing_control_fails_closed() {
        let mut evidence = ready_evidence();
        evidence.nvidia_runtime_available = false;
        let diagnostic = evaluate("linux", "x86_64", &evidence);
        assert!(!diagnostic.can_host);
        assert_eq!(diagnostic.reason, "nvidia_container_runtime_missing");
    }

    #[test]
    fn unknown_platform_and_architecture_fail_closed() {
        let evidence = ready_evidence();
        let platform = evaluate("unknown", "x86_64", &evidence);
        assert!(!platform.can_host);
        assert_eq!(platform.isolation_backend, IsolationBackend::Unsupported);
        assert_eq!(platform.reason, "operating_system_not_supported");

        let architecture = evaluate("linux", "mips", &evidence);
        assert!(!architecture.can_host);
        assert_eq!(architecture.reason, "architecture_not_supported");
    }
}