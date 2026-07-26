use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Output};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub installed: bool,
    pub linked: bool,
    pub running: bool,
    pub machine_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfig {
    machine_id: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".gpubnb").join("config.json"))
}

fn parse_config() -> Option<AgentConfig> {
    let content = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&content).ok()
}

fn run_agent(arguments: &[&str]) -> Result<Output, &'static str> {
    let direct = Command::new("gpubnb-agent").args(arguments).output();
    if let Ok(output) = direct {
        return Ok(output);
    }

    for python in ["python", "python3", "py"] {
        if let Ok(output) = Command::new(python)
            .args(["-m", "gpubnb_agent"])
            .args(arguments)
            .output()
        {
            return Ok(output);
        }
    }

    Err("agent_not_installed")
}

pub fn status() -> AgentStatus {
    let installed = run_agent(&["--version"]).is_ok();
    let config = parse_config();
    let machine_id = config.and_then(|value| value.machine_id);
    let linked = machine_id.is_some();

    let running = run_agent(&["status"])
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
        .and_then(|value| value.get("running").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);

    let detail = if !installed {
        "L’agent GPUbnb n’est pas encore installé sur cet ordinateur".to_owned()
    } else if !linked {
        "L’agent est installé, mais cette machine n’est pas encore liée".to_owned()
    } else if running {
        "La machine est liée et l’agent fonctionne en arrière-plan".to_owned()
    } else {
        "La machine est liée, mais l’agent doit encore être démarré".to_owned()
    };

    AgentStatus {
        installed,
        linked,
        running,
        machine_id,
        detail,
    }
}

pub fn link(code: &str) -> Result<AgentStatus, String> {
    let normalized = code.trim().to_ascii_uppercase();
    if normalized.len() != 10 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid_link_code".into());
    }

    let output = run_agent(&["link", &normalized]).map_err(str::to_owned)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(format!("agent_link_failed:{}", detail.trim()));
    }

    let linked = status();
    if !linked.linked {
        return Err("agent_link_not_persisted".into());
    }
    Ok(linked)
}

#[cfg(test)]
mod tests {
    #[test]
    fn link_code_contract_is_ten_hex_characters() {
        let valid = "A1B2C3D4E5";
        assert_eq!(valid.len(), 10);
        assert!(valid.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!"NOT-A-CODE".bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
