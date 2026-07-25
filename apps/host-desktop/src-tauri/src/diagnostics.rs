use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};

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
    pub name: String,
    pub uuid: String,
    pub memory_total_mib: u64,
    pub driver_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnostic {
    pub platform_supported: bool,
    pub architecture_supported: bool,
    pub isolation_backend: IsolationBackend,
    pub isolation_available: bool,
    pub requires_administrator: bool,
    pub docker_available: bool,
    pub docker_daemon_reachable: bool,
    pub nvidia_runtime_available: bool,
    pub gpu: Option<GpuDevice>,
    pub can_host: bool,
    pub reason: String,
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok().map(|value| value.trim().to_owned())
}

fn detect_gpu() -> Option<GpuDevice> {
    let output = command_output(
        "nvidia-smi",
        &[
            "--query-gpu=name,uuid,memory.total,driver_version",
            "--format=csv,noheader,nounits",
            "--id=0",
        ],
    )?;
    let line = output.lines().next()?.trim();
    let mut fields = line.split(',').map(str::trim);
    let name = fields.next()?.to_owned();
    let uuid = fields.next()?.to_owned();
    let memory_total_mib = fields.next()?.parse::<u64>().ok()?;
    let driver_version = fields.next()?.to_owned();
    if name.is_empty() || uuid.is_empty() || driver_version.is_empty() || memory_total_mib == 0 {
        return None;
    }
    Some(GpuDevice { name, uuid, memory_total_mib, driver_version })
}

fn docker_status() -> (bool, bool, bool) {
    let docker_available = command_output("docker", &["--version"]).is_some();
    if !docker_available {
        return (false, false, false);
    }
    let daemon = command_output("docker", &["info", "--format", "{{json .Runtimes}}"]).unwrap_or_default();
    let daemon_reachable = !daemon.is_empty();
    let nvidia_runtime_available = daemon.contains("nvidia");
    (docker_available, daemon_reachable, nvidia_runtime_available)
}

fn isolation_available(os: &str) -> bool {
    match os {
        "linux" => Path::new("/dev/kvm").exists(),
        "windows" => command_output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent"],
        )
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false),
        "macos" => command_output("sysctl", &["-n", "kern.hv_support"])
            .map(|value| value == "1")
            .unwrap_or(false),
        _ => false,
    }
}

pub fn collect_native_diagnostic() -> NativeDiagnostic {
    collect_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn collect_for(os: &str, architecture: &str) -> NativeDiagnostic {
    let platform_supported = matches!(os, "windows" | "macos" | "linux");
    let architecture_supported = matches!(architecture, "x86_64" | "aarch64");
    let isolation_backend = match os {
        "windows" => IsolationBackend::HyperV,
        "macos" => IsolationBackend::VirtualizationFramework,
        "linux" => IsolationBackend::Kvm,
        _ => IsolationBackend::Unsupported,
    };
    let isolation_available = platform_supported && isolation_available(os);
    let (docker_available, docker_daemon_reachable, nvidia_runtime_available) = docker_status();
    let gpu = detect_gpu();

    let reason = if !platform_supported {
        "operating_system_not_supported"
    } else if !architecture_supported {
        "architecture_not_supported"
    } else if gpu.is_none() {
        "nvidia_gpu_not_detected"
    } else if !docker_available {
        "docker_not_installed"
    } else if !docker_daemon_reachable {
        "docker_daemon_unreachable"
    } else if !nvidia_runtime_available {
        "nvidia_container_runtime_missing"
    } else if !isolation_available {
        "hardware_isolation_unavailable"
    } else {
        "native_prerequisites_ready"
    }
    .to_owned();

    let can_host = platform_supported
        && architecture_supported
        && gpu.is_some()
        && docker_available
        && docker_daemon_reachable
        && nvidia_runtime_available
        && isolation_available;

    NativeDiagnostic {
        platform_supported,
        architecture_supported,
        isolation_backend,
        isolation_available,
        requires_administrator: matches!(os, "windows" | "linux"),
        docker_available,
        docker_daemon_reachable,
        nvidia_runtime_available,
        gpu,
        can_host,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_platforms_select_an_isolation_backend() {
        assert_eq!(collect_for("windows", "x86_64").isolation_backend, IsolationBackend::HyperV);
        assert_eq!(collect_for("macos", "aarch64").isolation_backend, IsolationBackend::VirtualizationFramework);
        assert_eq!(collect_for("linux", "x86_64").isolation_backend, IsolationBackend::Kvm);
    }

    #[test]
    fn unknown_platform_fails_closed() {
        let diagnostic = collect_for("unknown", "x86_64");
        assert!(!diagnostic.can_host);
        assert_eq!(diagnostic.isolation_backend, IsolationBackend::Unsupported);
        assert_eq!(diagnostic.reason, "operating_system_not_supported");
    }

    #[test]
    fn unknown_architecture_fails_closed() {
        let diagnostic = collect_for("linux", "mips");
        assert!(!diagnostic.can_host);
        assert_eq!(diagnostic.reason, "architecture_not_supported");
    }
}