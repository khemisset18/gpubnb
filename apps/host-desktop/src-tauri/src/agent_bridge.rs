use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const AGENT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_AGENT_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_MACHINE_ID_LENGTH: usize = 128;

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

fn valid_machine_id(value: &str) -> bool {
    let length = value.len();
    (3..=MAX_MACHINE_ID_LENGTH).contains(&length)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn parse_config() -> Option<AgentConfig> {
    let path = config_path()?;
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }

    let content = std::fs::read_to_string(path).ok()?;
    let mut config: AgentConfig = serde_json::from_str(&content).ok()?;
    config.machine_id = config
        .machine_id
        .filter(|machine_id| valid_machine_id(machine_id));
    Some(config)
}

fn spawn_agent(program: &str, prefix: &[&str], arguments: &[&str]) -> Option<Child> {
    Command::new(program)
        .args(prefix)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()
}

fn bounded_output(mut child: Child) -> Result<Output, &'static str> {
    let deadline = Instant::now() + AGENT_COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|_| "agent_command_failed")?;
                let total_bytes = output.stdout.len().saturating_add(output.stderr.len());
                if total_bytes > MAX_AGENT_OUTPUT_BYTES {
                    return Err("agent_output_too_large");
                }
                return Ok(output);
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("agent_command_timeout");
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("agent_command_failed");
            }
        }
    }
}

fn run_agent(arguments: &[&str]) -> Result<Output, &'static str> {
    if let Some(child) = spawn_agent("gpubnb-agent", &[], arguments) {
        return bounded_output(child);
    }

    for python in ["python", "python3", "py"] {
        if let Some(child) = spawn_agent(python, &["-m", "gpubnb_agent"], arguments) {
            return bounded_output(child);
        }
    }

    Err("agent_not_installed")
}

pub fn status() -> AgentStatus {
    let installed = run_agent(&["--version"]).is_ok_and(|output| output.status.success());
    let machine_id = parse_config().and_then(|value| value.machine_id);
    let linked = machine_id.is_some();

    let running = installed
        && run_agent(&["status"])
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
        return Err("agent_link_failed".into());
    }

    let linked = status();
    if !linked.linked {
        return Err("agent_link_not_persisted".into());
    }
    Ok(linked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_code_contract_is_ten_hex_characters() {
        let valid = "A1B2C3D4E5";
        assert_eq!(valid.len(), 10);
        assert!(valid.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!"NOT-A-CODE".bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn machine_identity_is_strictly_bounded() {
        assert!(valid_machine_id("machine_123"));
        assert!(valid_machine_id("host.eu-west-1"));
        assert!(!valid_machine_id("ab"));
        assert!(!valid_machine_id("machine id"));
        assert!(!valid_machine_id("machine/../../secret"));
        assert!(!valid_machine_id(&"a".repeat(MAX_MACHINE_ID_LENGTH + 1)));
    }
}
