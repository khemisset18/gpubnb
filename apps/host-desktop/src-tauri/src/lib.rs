use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    id: &'static str,
    label: &'static str,
    ok: bool,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    platform: &'static str,
    architecture: &'static str,
    ready: bool,
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
        Check { id: "platform", label: "Système compatible", ok: supported, detail: platform_name().to_string() },
        Check { id: "agent", label: "Agent GPUbnb", ok: false, detail: "Association sécurisée requise".into() },
        Check { id: "isolation", label: "Environnement isolé", ok: false, detail: "Aucun accès locataire autorisé avant certification".into() },
        Check { id: "storage", label: "Disques personnels protégés", ok: false, detail: "Politique de montage à vérifier".into() },
        Check { id: "network", label: "Réseau filtré", ok: false, detail: "Pare-feu de session à configurer".into() },
    ];
    let ready = checks.iter().all(|check| check.ok);
    HostStatus { platform: platform_name(), architecture: std::env::consts::ARCH, ready, checks }
}

#[tauri::command]
fn request_publish() -> Result<(), &'static str> {
    Err("host_not_certified")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![host_status, request_publish])
        .run(tauri::generate_context!())
        .expect("failed to run GPUbnb Host");
}
