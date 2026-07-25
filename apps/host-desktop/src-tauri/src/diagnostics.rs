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
pub struct NativeDiagnostic {
    pub platform_supported: bool,
    pub architecture_supported: bool,
    pub isolation_backend: IsolationBackend,
    pub requires_administrator: bool,
    pub can_host: bool,
    pub reason: &'static str,
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

fn nvidia_gpu_available() -> bool {
    command_output(
        "nvidia-smi",
        &["--query-gpu=uuid", "--format=csv,noheader", "--id=0"],
    )
    .map(|value| !value.is_empty())
    .unwrap_or(false)
}

fn docker_status() -> (bool, bool, bool) {
    let installed = command_output("docker", &["--version"]).is_some();
    if !installed {
        return (false, false, false);
    }
    let runtimes = command_output("docker", &["info", "--format", "{{json .Runtimes}}"]).unwrap_or_default();
    (!runtimes.is_empty()).then_some(());
    (installed, !runtimes.is_empty(), runtimes.contains("nvidia"))
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

    let (docker_installed, docker_reachable, nvidia_runtime) = docker_status();
    let gpu_available = nvidia_gpu_available();
    let isolation_ready = platform_supported && isolation_available(os);

    let reason = if !platform_supported {
        "operating_system_not_supported"
    } else if !architecture_supported {
        "architecture_not_supported"
    } else if !gpu_available {
        "nvidia_gpu_not_detected"
    } else if !docker_installed {
        "docker_not_installed"
    } else if !docker_reachable {
        "docker_daemon_unreachable"
    } else if !nvidia_runtime {
        "nvidia_container_runtime_missing"
    } else if !isolation_ready {
        "hardware_isolation_unavailable"
    } else {
        "native_prerequisites_ready"
    };

    let can_host = platform_supported
        && architecture_supported
        && gpu_available
        && docker_installed
        && docker_reachable
        && nvidia_runtime
        && isolation_ready;

    NativeDiagnostic {
        platform_supported,
        architecture_supported,
        isolation_backend,
        requires_administrator: matches!(os, "windows" | "linux"),
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
    fn supported_platform_fails_closed_when_runtime_is_not_certified() {
        let diagnostic = collect_for("linux", "x86_64");
        if !diagnostic.can_host {
            assert_ne!(diagnostic.reason, "native_prerequisites_ready");
        }
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