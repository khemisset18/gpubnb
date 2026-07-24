mod diagnostics;

use diagnostics::{collect_native_diagnostic, NativeDiagnostic};
use serde::Serialize;
use std::sync::Mutex;

const TOTAL_SETUP_STEPS: usize = 6;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum HostLifecycle {
    #[default]
    SetupRequired,
    Ready,
    Online,
    EmergencyStopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SetupAction {
    Account,
    Agent,
    Isolation,
    Storage,
    Network,
}

impl SetupAction {
    const fn id(self) -> &'static str {
        match self {
            Self::Account => "account",
            Self::Agent => "agent",
            Self::Isolation => "isolation",
            Self::Storage => "storage",
            Self::Network => "network",
        }
    }
}

impl TryFrom<&str> for SetupAction {
    type Error = &'static str;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "account" => Ok(Self::Account),
            "agent" => Ok(Self::Agent),
            "isolation" => Ok(Self::Isolation),
            "storage" => Ok(Self::Storage),
            "network" => Ok(Self::Network),
            _ => Err("unknown_setup_action"),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Readiness {
    account_linked: bool,
    service_installed: bool,
    isolation_certified: bool,
    storage_protected: bool,
    network_filtered: bool,
}

impl Readiness {
    fn is_ready(&self, diagnostic: &NativeDiagnostic) -> bool {
        diagnostic.can_host
            && self.account_linked
            && self.service_installed
            && self.isolation_certified
            && self.storage_protected
            && self.network_filtered
    }

    fn next_action(&self) -> Option<SetupAction> {
        if !self.account_linked {
            Some(SetupAction::Account)
        } else if !self.service_installed {
            Some(SetupAction::Agent)
        } else if !self.isolation_certified {
            Some(SetupAction::Isolation)
        } else if !self.storage_protected {
            Some(SetupAction::Storage)
        } else if !self.network_filtered {
            Some(SetupAction::Network)
        } else {
            None
        }
    }
}

#[derive(Default)]
struct AppState {
    readiness: Readiness,
    lifecycle: HostLifecycle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    id: &'static str,
    label: &'static str,
    ok: bool,
    blocking: bool,
    detail: String,
    action_label: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    platform: &'static str,
    architecture: &'static str,
    ready: bool,
    lifecycle: HostLifecycle,
    completed_steps: usize,
    total_steps: usize,
    progress: u8,
    blocking_count: usize,
    summary: String,
    next_action_id: Option<&'static str>,
    diagnostic: NativeDiagnostic,
    checks: Vec<Check>,
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        _ => "Non pris en charge",
    }
}

fn build_status(state: &AppState) -> HostStatus {
    let diagnostic = collect_native_diagnostic();
    let readiness = &state.readiness;
    let checks = vec![
        Check {
            id: "platform",
            label: "Ordinateur compatible",
            ok: diagnostic.can_host,
            blocking: true,
            detail: if diagnostic.can_host {
                format!(
                    "{} et {} sont pris en charge",
                    platform_name(),
                    std::env::consts::ARCH
                )
            } else {
                "Ce système ne peut pas héberger une location sécurisée".into()
            },
            action_label: None,
        },
        Check {
            id: "account",
            label: "Compte GPUbnb connecté",
            ok: readiness.account_linked,
            blocking: true,
            detail: "L'association utilise un code court à usage unique".into(),
            action_label: (!readiness.account_linked).then_some("Se connecter"),
        },
        Check {
            id: "agent",
            label: "Service GPUbnb installé",
            ok: readiness.service_installed,
            blocking: true,
            detail: "Le service signé fonctionne séparément de l'interface".into(),
            action_label: (!readiness.service_installed).then_some("Installer automatiquement"),
        },
        Check {
            id: "isolation",
            label: "Espace locataire isolé",
            ok: readiness.isolation_certified,
            blocking: true,
            detail: "Le locataire ne peut jamais voir votre session personnelle".into(),
            action_label: (!readiness.isolation_certified).then_some("Configurer la protection"),
        },
        Check {
            id: "storage",
            label: "Fichiers personnels protégés",
            ok: readiness.storage_protected,
            blocking: true,
            detail: "Les dossiers personnels sont exclus par défaut".into(),
            action_label: (!readiness.storage_protected).then_some("Vérifier"),
        },
        Check {
            id: "network",
            label: "Connexion locataire filtrée",
            ok: readiness.network_filtered,
            blocking: true,
            detail: "Le pare-feu de session applique une politique restrictive".into(),
            action_label: (!readiness.network_filtered).then_some("Configurer"),
        },
    ];

    let ready = readiness.is_ready(&diagnostic);
    let lifecycle = match state.lifecycle {
        HostLifecycle::EmergencyStopped => HostLifecycle::EmergencyStopped,
        HostLifecycle::Online if ready => HostLifecycle::Online,
        _ if ready => HostLifecycle::Ready,
        _ => HostLifecycle::SetupRequired,
    };
    let completed_steps = checks.iter().filter(|check| check.ok).count();
    let blocking_count = checks
        .iter()
        .filter(|check| check.blocking && !check.ok)
        .count();
    let progress = ((completed_steps * 100) / TOTAL_SETUP_STEPS) as u8;
    let summary = match lifecycle {
        HostLifecycle::EmergencyStopped => "Arrêt d'urgence actif".to_owned(),
        HostLifecycle::Online => "Votre GPU est en ligne".to_owned(),
        HostLifecycle::Ready => "Toutes les protections sont prêtes".to_owned(),
        HostLifecycle::SetupRequired => {
            if blocking_count == 1 {
                "Une protection reste à configurer".to_owned()
            } else {
                format!("{blocking_count} protections restent à configurer")
            }
        }
    };

    HostStatus {
        platform: platform_name(),
        architecture: std::env::consts::ARCH,
        ready,
        lifecycle,
        completed_steps,
        total_steps: TOTAL_SETUP_STEPS,
        progress,
        blocking_count,
        summary,
        next_action_id: readiness.next_action().map(SetupAction::id),
        diagnostic,
        checks,
    }
}

#[tauri::command]
fn host_status(state: tauri::State<'_, Mutex<AppState>>) -> Result<HostStatus, &'static str> {
    let state = state.lock().map_err(|_| "state_unavailable")?;
    Ok(build_status(&state))
}

#[tauri::command]
fn request_publish(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), &'static str> {
    let mut state = state.lock().map_err(|_| "state_unavailable")?;
    if state.lifecycle == HostLifecycle::EmergencyStopped {
        return Err("emergency_stop_requires_review");
    }

    let diagnostic = collect_native_diagnostic();
    if !state.readiness.is_ready(&diagnostic) {
        return Err("host_not_certified");
    }

    state.lifecycle = HostLifecycle::Online;
    Ok(())
}

#[tauri::command]
fn emergency_stop(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), &'static str> {
    let mut state = state.lock().map_err(|_| "state_unavailable")?;
    state.lifecycle = HostLifecycle::EmergencyStopped;
    Ok(())
}

#[tauri::command]
fn run_setup_action(action_id: String) -> Result<String, &'static str> {
    if action_id.len() > 32 || !action_id.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err("invalid_setup_action");
    }

    match SetupAction::try_from(action_id.as_str())? {
        SetupAction::Account => Ok("account_link_pending".into()),
        SetupAction::Agent
        | SetupAction::Isolation
        | SetupAction::Storage
        | SetupAction::Network => Ok("automatic_setup_pending".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            host_status,
            request_publish,
            emergency_stop,
            run_setup_action
        ])
        .run(tauri::generate_context!())
        .expect("failed to run GPUbnb Host");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supported_diagnostic() -> NativeDiagnostic {
        NativeDiagnostic {
            platform_supported: true,
            architecture_supported: true,
            isolation_backend: diagnostics::IsolationBackend::Kvm,
            requires_administrator: true,
            can_host: true,
            reason: "native_checks_pending",
        }
    }

    fn fully_ready() -> Readiness {
        Readiness {
            account_linked: true,
            service_installed: true,
            isolation_certified: true,
            storage_protected: true,
            network_filtered: true,
        }
    }

    #[test]
    fn readiness_is_fail_closed() {
        assert!(!Readiness::default().is_ready(&supported_diagnostic()));
    }

    #[test]
    fn readiness_requires_every_protection() {
        let mut readiness = fully_ready();
        assert!(readiness.is_ready(&supported_diagnostic()));
        readiness.network_filtered = false;
        assert!(!readiness.is_ready(&supported_diagnostic()));
    }

    #[test]
    fn unsupported_native_environment_blocks_readiness() {
        let mut diagnostic = supported_diagnostic();
        diagnostic.can_host = false;
        assert!(!fully_ready().is_ready(&diagnostic));
    }

    #[test]
    fn next_action_is_deterministic() {
        let mut readiness = Readiness::default();
        assert_eq!(readiness.next_action(), Some(SetupAction::Account));
        readiness.account_linked = true;
        assert_eq!(readiness.next_action(), Some(SetupAction::Agent));
    }

    #[test]
    fn setup_actions_are_allowlisted() {
        assert_eq!(SetupAction::try_from("account"), Ok(SetupAction::Account));
        assert_eq!(SetupAction::try_from("shell"), Err("unknown_setup_action"));
    }

    #[test]
    fn status_never_claims_ready_by_default() {
        let status = build_status(&AppState::default());
        assert!(!status.ready);
        assert_eq!(status.total_steps, TOTAL_SETUP_STEPS);
        assert_eq!(status.next_action_id, Some("account"));
    }
}
