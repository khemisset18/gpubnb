use serde::Serialize;

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
    completed_steps: usize,
    total_steps: usize,
    checks: Vec<Check>,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") { "Windows" }
    else if cfg!(target_os = "macos") { "macOS" }
    else if cfg!(target_os = "linux") { "Linux" }
    else { "Non pris en charge" }
}

#[tauri::command]
fn host_status() -> HostStatus {
    let supported = cfg!(any(target_os = "windows", target_os = "macos", target_os = "linux"));
    let checks = vec![
        Check {
            id: "platform",
            label: "Ordinateur compatible",
            ok: supported,
            blocking: true,
            detail: if supported { format!("{} est pris en charge", platform_name()) } else { "Ce système ne peut pas héberger de location".into() },
            action_label: None,
        },
        Check {
            id: "account",
            label: "Compte GPUbnb connecté",
            ok: false,
            blocking: true,
            detail: "Connectez votre compte pour associer cet ordinateur".into(),
            action_label: Some("Se connecter"),
        },
        Check {
            id: "agent",
            label: "Service GPUbnb installé",
            ok: false,
            blocking: true,
            detail: "Le service sécurisé doit fonctionner en arrière-plan".into(),
            action_label: Some("Installer automatiquement"),
        },
        Check {
            id: "isolation",
            label: "Espace locataire isolé",
            ok: false,
            blocking: true,
            detail: "Le locataire ne doit jamais voir votre bureau ni vos documents".into(),
            action_label: Some("Configurer la protection"),
        },
        Check {
            id: "storage",
            label: "Fichiers personnels protégés",
            ok: false,
            blocking: true,
            detail: "Aucun dossier personnel ne sera monté dans la session".into(),
            action_label: Some("Vérifier"),
        },
        Check {
            id: "network",
            label: "Connexion locataire filtrée",
            ok: false,
            blocking: true,
            detail: "Le pare-feu temporaire doit être prêt avant toute location".into(),
            action_label: Some("Configurer"),
        },
    ];
    let completed_steps = checks.iter().filter(|check| check.ok).count();
    let total_steps = checks.len();
    let ready = checks.iter().filter(|check| check.blocking).all(|check| check.ok);
    HostStatus {
        platform: platform_name(),
        architecture: std::env::consts::ARCH,
        ready,
        completed_steps,
        total_steps,
        checks,
    }
}

#[tauri::command]
fn request_publish() -> Result<(), &'static str> {
    Err("host_not_certified")
}

#[tauri::command]
fn run_setup_action(action_id: String) -> Result<String, &'static str> {
    match action_id.as_str() {
        "account" => Ok("account_link_pending".into()),
        "agent" | "isolation" | "storage" | "network" => Ok("automatic_setup_pending".into()),
        _ => Err("unknown_setup_action"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![host_status, request_publish, run_setup_action])
        .run(tauri::generate_context!())
        .expect("failed to run GPUbnb Host");
}
