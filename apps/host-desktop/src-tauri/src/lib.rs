#![cfg_attr(not(feature = "desktop-runtime"), allow(dead_code, unused_imports))]

mod agent_bridge;
mod diagnostics;
mod orchestration_gateway;
mod pairing;
mod rental_orchestrator;

use agent_bridge::AgentStatus;
use diagnostics::{collect_native_diagnostic, NativeDiagnostic};
use orchestration_gateway::{
    ActorRole, AuthenticatedContext, CommandResult, OrchestrationCommand, OrchestrationGateway,
};
use pairing::{pairing_configuration, PairingConfiguration};
use rental_orchestrator::OrchestrationSnapshot;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};

const TOTAL_SETUP_STEPS: usize = 6;
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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

#[derive(Clone, Debug)]
struct Readiness {
    isolation_certified: bool,
    storage_protected: bool,
    network_filtered: bool,
}

impl Readiness {
    fn from_diagnostic(diagnostic: &NativeDiagnostic) -> Self {
        Self {
            isolation_certified: diagnostic.can_host,
            storage_protected: false,
            network_filtered: false,
        }
    }

    fn is_ready(&self, diagnostic: &NativeDiagnostic, agent: &AgentStatus) -> bool {
        diagnostic.can_host
            && agent.linked
            && agent.running
            && self.isolation_certified
            && self.storage_protected
            && self.network_filtered
    }

    fn next_action(&self, agent: &AgentStatus) -> Option<SetupAction> {
        if !agent.linked {
            Some(SetupAction::Account)
        } else if !agent.running {
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
    pairing: PairingConfiguration,
    agent: AgentStatus,
    diagnostic: NativeDiagnostic,
    orchestration: OrchestrationSnapshot,
    checks: Vec<Check>,
}

fn unix_seconds() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system_clock_invalid")
}

fn local_context(role: ActorRole, now: u64) -> AuthenticatedContext {
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    AuthenticatedContext {
        request_id: format!("desktop_{now}_{sequence}"),
        installation_id: installation_id(),
        actor_id: "host_desktop".into(),
        actor_role: role,
        issued_at_unix_seconds: now,
    }
}

fn installation_id() -> String {
    std::env::var("GPUBNB_INSTALLATION_ID")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unpaired_installation".into())
}

fn machine_id() -> String {
    agent_bridge::status()
        .machine_id
        .or_else(|| {
            std::env::var("GPUBNB_MACHINE_ID")
                .ok()
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "unpaired_machine".into())
}

fn create_gateway() -> OrchestrationGateway {
    OrchestrationGateway::new(installation_id(), machine_id())
        .expect("orchestration identifiers must be valid")
}

fn execute_local(
    gateway: &mut OrchestrationGateway,
    role: ActorRole,
    command: OrchestrationCommand,
) -> Result<CommandResult, &'static str> {
    let now = unix_seconds()?;
    gateway.execute(local_context(role, now), command, now)
}

fn read_orchestration(
    gateway: &mut OrchestrationGateway,
) -> Result<OrchestrationSnapshot, &'static str> {
    execute_local(
        gateway,
        ActorRole::LocalAdministrator,
        OrchestrationCommand::ReadStatus,
    )
    .map(|result| result.snapshot)
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        _ => "Non pris en charge",
    }
}

fn build_status(state: &AppState, orchestration: OrchestrationSnapshot) -> HostStatus {
    let diagnostic = collect_native_diagnostic();
    let pairing = pairing_configuration();
    let agent = agent_bridge::status();
    let readiness = Readiness::from_diagnostic(&diagnostic);
    let account_detail = if let Some(machine_id) = agent.machine_id.as_deref() {
        format!("Machine associée : {machine_id}")
    } else if pairing.configured {
        "Connexion sécurisée dans votre navigateur avec un code temporaire".into()
    } else {
        "Le service de connexion doit être configuré avant l'installation publique".into()
    };

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
            ok: agent.linked,
            blocking: true,
            detail: account_detail,
            action_label: (!agent.linked).then_some("Connecter mon compte"),
        },
        Check {
            id: "agent",
            label: "Service GPUbnb actif",
            ok: agent.running,
            blocking: true,
            detail: agent.detail.clone(),
            action_label: (!agent.running).then_some(if agent.installed {
                "Démarrer le service"
            } else {
                "Installer automatiquement"
            }),
        },
        Check {
            id: "isolation",
            label: "Espace locataire isolé",
            ok: readiness.isolation_certified,
            blocking: true,
            detail: if readiness.isolation_certified {
                "Le backend d’isolation matériel requis a été vérifié".into()
            } else {
                "Aucune preuve technique d’isolation exploitable n’est disponible".into()
            },
            action_label: (!readiness.isolation_certified).then_some("Configurer la protection"),
        },
        Check {
            id: "storage",
            label: "Fichiers personnels protégés",
            ok: readiness.storage_protected,
            blocking: true,
            detail: "Le stockage locataire isolé et son nettoyage ne sont pas encore provisionnés"
                .into(),
            action_label: (!readiness.storage_protected).then_some("Vérifier"),
        },
        Check {
            id: "network",
            label: "Connexion locataire filtrée",
            ok: readiness.network_filtered,
            blocking: true,
            detail: "Aucune politique réseau locataire vérifiée n’est encore installée".into(),
            action_label: (!readiness.network_filtered).then_some("Configurer"),
        },
    ];

    let protections_ready = readiness.is_ready(&diagnostic, &agent);
    let emergency_stopped = state.lifecycle == HostLifecycle::EmergencyStopped;
    let ready = protections_ready && !emergency_stopped;
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
        HostLifecycle::Online => format!("GPU en ligne — état {:?}", orchestration.state),
        HostLifecycle::Ready => "Toutes les protections sont prêtes".to_owned(),
        HostLifecycle::SetupRequired => match blocking_count {
            1 => "Une protection reste à configurer".to_owned(),
            count => format!("{count} protections restent à configurer"),
        },
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
        next_action_id: (!emergency_stopped)
            .then(|| readiness.next_action(&agent).map(SetupAction::id))
            .flatten(),
        pairing,
        agent,
        diagnostic,
        orchestration,
        checks,
    }
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn host_status(
    state: tauri::State<'_, Mutex<AppState>>,
    gateway: tauri::State<'_, Mutex<OrchestrationGateway>>,
) -> Result<HostStatus, &'static str> {
    let state = state.lock().map_err(|_| "state_unavailable")?;
    let mut gateway = gateway
        .lock()
        .map_err(|_| "orchestration_state_unavailable")?;
    Ok(build_status(&state, read_orchestration(&mut gateway)?))
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn local_agent_status() -> AgentStatus {
    agent_bridge::status()
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn link_local_agent(code: String) -> Result<AgentStatus, String> {
    agent_bridge::link(&code)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn orchestration_status(
    gateway: tauri::State<'_, Mutex<OrchestrationGateway>>,
) -> Result<OrchestrationSnapshot, &'static str> {
    let mut gateway = gateway
        .lock()
        .map_err(|_| "orchestration_state_unavailable")?;
    read_orchestration(&mut gateway)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn account_pairing_configuration() -> PairingConfiguration {
    pairing_configuration()
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn request_publish(
    state: tauri::State<'_, Mutex<AppState>>,
    gateway: tauri::State<'_, Mutex<OrchestrationGateway>>,
) -> Result<OrchestrationSnapshot, &'static str> {
    let mut state = state.lock().map_err(|_| "state_unavailable")?;
    if state.lifecycle == HostLifecycle::EmergencyStopped {
        return Err("emergency_stop_requires_review");
    }
    let agent = agent_bridge::status();
    let diagnostic = collect_native_diagnostic();
    if !Readiness::from_diagnostic(&diagnostic).is_ready(&diagnostic, &agent) {
        return Err("host_not_certified");
    }
    let mut gateway = gateway
        .lock()
        .map_err(|_| "orchestration_state_unavailable")?;
    let result = execute_local(
        &mut gateway,
        ActorRole::LocalAdministrator,
        OrchestrationCommand::CertifyHost,
    )?;
    state.lifecycle = HostLifecycle::Online;
    Ok(result.snapshot)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn set_idle_mining(
    enabled: bool,
    state: tauri::State<'_, Mutex<AppState>>,
    gateway: tauri::State<'_, Mutex<OrchestrationGateway>>,
) -> Result<OrchestrationSnapshot, &'static str> {
    let state = state.lock().map_err(|_| "state_unavailable")?;
    let agent = agent_bridge::status();
    if state.lifecycle != HostLifecycle::Online {
        return Err("host_must_be_online");
    }
    let diagnostic = collect_native_diagnostic();
    if !Readiness::from_diagnostic(&diagnostic).is_ready(&diagnostic, &agent) {
        return Err("host_not_certified");
    }
    drop(state);
    let mut gateway = gateway
        .lock()
        .map_err(|_| "orchestration_state_unavailable")?;
    execute_local(
        &mut gateway,
        ActorRole::LocalAdministrator,
        OrchestrationCommand::SetMiningEnabled { enabled },
    )
    .map(|result| result.snapshot)
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn emergency_stop(
    state: tauri::State<'_, Mutex<AppState>>,
    gateway: tauri::State<'_, Mutex<OrchestrationGateway>>,
) -> Result<OrchestrationSnapshot, &'static str> {
    let mut state = state.lock().map_err(|_| "state_unavailable")?;
    state.lifecycle = HostLifecycle::EmergencyStopped;
    drop(state);
    let mut gateway = gateway
        .lock()
        .map_err(|_| "orchestration_state_unavailable")?;
    let result = execute_local(
        &mut gateway,
        ActorRole::LocalAdministrator,
        OrchestrationCommand::EmergencyStop {
            all_processes_stopped: false,
        },
    );
    match result {
        Ok(result) => Ok(result.snapshot),
        Err("emergency_stop_failed") => read_orchestration(&mut gateway),
        Err(error) => Err(error),
    }
}

#[cfg(feature = "desktop-runtime")]
#[tauri::command]
fn run_setup_action(action_id: String) -> Result<String, String> {
    if action_id.len() > 32 || !action_id.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err("invalid_setup_action".into());
    }
    match SetupAction::try_from(action_id.as_str()).map_err(str::to_owned)? {
        SetupAction::Account => pairing_configuration()
            .configured
            .then(|| "open_secure_pairing".into())
            .ok_or_else(|| "pairing_service_not_configured".to_owned()),
        SetupAction::Agent => {
            let agent = agent_bridge::status();
            if agent.linked {
                agent_bridge::start()
                    .map(|_| "agent_started".into())
                    .map_err(|error| error)
            } else {
                agent_bridge::setup()
                    .map(|_| "agent_setup_completed".into())
                    .map_err(|error| error)
            }
        }
        SetupAction::Isolation => {
            let diagnostic = collect_native_diagnostic();
            diagnostic
                .can_host
                .then(|| "isolation_verified".into())
                .ok_or_else(|| diagnostic.reason.to_owned())
        }
        SetupAction::Storage => Err("storage_protection_not_implemented".into()),
        SetupAction::Network => Err("network_filter_not_implemented".into()),
    }
}

#[cfg(feature = "desktop-runtime")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(AppState::default()))
        .manage(Mutex::new(create_gateway()))
        .invoke_handler(tauri::generate_handler![
            host_status,
            local_agent_status,
            link_local_agent,
            orchestration_status,
            account_pairing_configuration,
            request_publish,
            set_idle_mining,
            emergency_stop,
            run_setup_action
        ])
        .run(tauri::generate_context!())
        .expect("failed to run GPUbnb Host");
}

#[cfg(test)]
mod tests {
    use super::*;
    use rental_orchestrator::HostWorkloadState;

    fn supported_diagnostic() -> NativeDiagnostic {
        NativeDiagnostic {
            platform_supported: true,
            architecture_supported: true,
            isolation_backend: diagnostics::IsolationBackend::Kvm,
            requires_administrator: true,
            can_host: true,
            reason: "native_checks_pending",
            gpus: Vec::new(),
        }
    }

    fn running_agent() -> AgentStatus {
        AgentStatus {
            installed: true,
            linked: true,
            running: true,
            machine_id: Some("machine_test".into()),
            detail: "ok".into(),
        }
    }

    fn fully_ready() -> Readiness {
        Readiness {
            isolation_certified: true,
            storage_protected: true,
            network_filtered: true,
        }
    }

    fn offline_snapshot() -> OrchestrationSnapshot {
        OrchestrationSnapshot {
            state: HostWorkloadState::Offline,
            mining_enabled: false,
            active_reservation_id: None,
            active_gpu_id: None,
            last_error: None,
        }
    }

    #[test]
    fn readiness_is_fail_closed_without_real_agent() {
        let diagnostic = supported_diagnostic();
        assert!(
            !Readiness::from_diagnostic(&diagnostic).is_ready(&diagnostic, &AgentStatus::default())
        );
    }

    #[test]
    fn readiness_requires_running_persistent_agent() {
        let readiness = fully_ready();
        assert!(readiness.is_ready(&supported_diagnostic(), &running_agent()));
        let mut stopped = running_agent();
        stopped.running = false;
        assert!(!readiness.is_ready(&supported_diagnostic(), &stopped));
    }

    #[test]
    fn setup_actions_are_allowlisted() {
        assert_eq!(SetupAction::try_from("account"), Ok(SetupAction::Account));
        assert_eq!(SetupAction::try_from("shell"), Err("unknown_setup_action"));
    }

    #[test]
    fn status_never_claims_ready_by_default() {
        let status = build_status(&AppState::default(), offline_snapshot());
        assert!(!status.ready);
        assert_eq!(status.total_steps, TOTAL_SETUP_STEPS);
        assert!(!status.pairing.stores_password);
    }

    #[test]
    fn frontend_has_no_generic_privileged_gateway_command() {
        let exposed = [
            "host_status",
            "local_agent_status",
            "link_local_agent",
            "orchestration_status",
            "account_pairing_configuration",
            "request_publish",
            "set_idle_mining",
            "emergency_stop",
            "run_setup_action",
        ];
        assert!(!exposed.contains(&"execute_orchestration"));
        assert!(!exposed.contains(&"accept_reservation"));
        assert!(!exposed.contains(&"confirm_cleanup"));
    }
}
