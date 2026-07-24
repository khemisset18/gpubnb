use serde::Serialize;

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
    let can_host = platform_supported
        && architecture_supported
        && isolation_backend != IsolationBackend::Unsupported;
    let reason = if !platform_supported {
        "operating_system_not_supported"
    } else if !architecture_supported {
        "architecture_not_supported"
    } else {
        "native_checks_pending"
    };

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
