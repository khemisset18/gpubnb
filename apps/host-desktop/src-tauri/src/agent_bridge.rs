use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const SETUP_TIMEOUT: Duration = Duration::from_secs(120);
const PROTECTION_TIMEOUT: Duration = Duration::from_secs(120);
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionStatus {
    pub isolation_verified: bool,
    pub storage_protected: bool,
    pub network_filtered: bool,
    pub cleanup_verified: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfig {
    machine_id: Option<String>,
}

fn config_path_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(override_dir) = std::env::var_os("GPUBNB_CONFIG_DIR") {
        paths.push(PathBuf::from(override_dir).join("config.json"));
    }

    if cfg!(target_os = "windows") {
        if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
            paths.push(
                PathBuf::from(program_data)
                    .join("GPUbnb")
                    .join("config.json"),
            );
        }
    } else if let Some(xdg_config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(
            PathBuf::from(xdg_config_home)
                .join("gpubnb")
                .join("config.json"),
        );
    } else if let Some(home) = std::env::var_os("HOME") {
        paths.push(
            PathBuf::from(&home)
                .join(".config")
                .join("gpubnb")
                .join("config.json"),
        );
    }

    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        paths.push(PathBuf::from(home).join(".gpubnb").join("config.json"));
    }

    paths
}

fn valid_machine_id(value: &str) -> bool {
    let length = value.len();
    (3..=MAX_MACHINE_ID_LENGTH).contains(&length)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn parse_config() -> Option<AgentConfig> {
    config_path_candidates().into_iter().find_map(|path| {
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
    })
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

fn bounded_output(mut child: Child, timeout: Duration) -> Result<Output, &'static str> {
    let deadline = Instant::now() + timeout;
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

fn command_timeout(arguments: &[&str]) -> Duration {
    match arguments {
        ["setup", ..] => SETUP_TIMEOUT,
        ["protections", "verify", ..] => PROTECTION_TIMEOUT,
        ["link", ..] | ["start", ..] => MUTATION_TIMEOUT,
        _ => STATUS_TIMEOUT,
    }
}

fn bundled_agent_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(test_executable) = std::env::var_os("GPUBNB_TEST_AGENT_EXECUTABLE") {
        return Some(PathBuf::from(test_executable));
    }

    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    Some(directory.join(if cfg!(target_os = "windows") {
        "gpubnb-agent.exe"
    } else {
        "gpubnb-agent"
    }))
}

fn run_agent(arguments: &[&str]) -> Result<Output, &'static str> {
    let timeout = command_timeout(arguments);
    if let Some(path) = bundled_agent_path().filter(|path| path.is_file()) {
        if let Some(child) = spawn_agent(path.to_string_lossy().as_ref(), &[], arguments) {
            return bounded_output(child, timeout);
        }
        return Err("agent_command_failed");
    }

    if let Some(child) = spawn_agent("gpubnb-agent", &[], arguments) {
        return bounded_output(child, timeout);
    }

    for python in ["python", "python3", "py"] {
        if let Some(child) = spawn_agent(python, &["-m", "gpubnb_agent"], arguments) {
            return bounded_output(child, timeout);
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

pub fn protections() -> ProtectionStatus {
    run_agent(&["protections", "verify"])
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice(&output.stdout).ok())
        .unwrap_or_default()
}

pub fn setup() -> Result<AgentStatus, String> {
    let output = run_agent(&["setup"]).map_err(str::to_owned)?;
    if !output.status.success() && parse_config().is_none() {
        return Err(classify_agent_failure(&output).into());
    }
    Ok(status())
}

pub fn start() -> Result<AgentStatus, String> {
    let output = run_agent(&["start", "--daemon"]).map_err(str::to_owned)?;
    if !output.status.success() {
        return Err(classify_agent_failure(&output).into());
    }
    Ok(status())
}

fn classify_agent_failure(output: &Output) -> &'static str {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{stderr}\n{stdout}");
    if combined.contains("Clé absente")
        || combined.contains("key file")
        || combined.contains("agent.key")
    {
        "agent_setup_required"
    } else if combined.contains("Machine non liée") || combined.contains("non liée") {
        "agent_not_linked"
    } else if combined.contains("agent_key_already_registered") {
        "agent_key_already_registered"
    } else if combined.contains("API HTTP 409") || combined.contains("invalid_or_expired_link_code")
    {
        "agent_link_failed"
    } else {
        "agent_command_failed"
    }
}

pub fn link(code: &str) -> Result<AgentStatus, String> {
    let normalized = code.trim().to_ascii_uppercase();
    if normalized.len() != 10 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid_link_code".into());
    }

    let output = run_agent(&["link", &normalized]).map_err(str::to_owned)?;
    if !output.status.success() {
        return Err(classify_agent_failure(&output).into());
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
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENVIRONMENT_LOCK: Mutex<()> = Mutex::new(());

    fn integration_fixture() -> (PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "gpubnb-agent-bridge-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();

        #[cfg(target_os = "windows")]
        let executable = {
            let path = directory.join("gpubnb-agent.cmd");
            fs::write(
                &path,
                "@echo off\r\n\
                 if \"%1\"==\"--version\" (echo 0.1.0& exit /b 0)\r\n\
                 if \"%1\"==\"status\" (echo {\"running\":true}& exit /b 0)\r\n\
                 if \"%1\"==\"setup\" exit /b 0\r\n\
                 if \"%1\"==\"link\" exit /b 0\r\n\
                 if \"%1\"==\"start\" exit /b 0\r\n\
                 exit /b 9\r\n",
            )
            .unwrap();
            path
        };

        #[cfg(not(target_os = "windows"))]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let path = directory.join("gpubnb-agent");
            fs::write(
                &path,
                "#!/bin/sh\n\
                 case \"$1\" in\n\
                 --version) echo 0.1.0 ;;\n\
                 status) echo '{\"running\":true}' ;;\n\
                 setup|link|start) ;;\n\
                 *) exit 9 ;;\n\
                 esac\n",
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        };

        (directory, executable)
    }

    #[test]
    fn link_code_contract_is_ten_hex_characters() {
        let valid = "A1B2C3D4E5";
        assert_eq!(valid.len(), 10);
        assert!(valid.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(!"NOT-A-CODE".bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn classifies_missing_key_as_setup_required() {
        let output = Output {
            status: std::process::Command::new("false").status().unwrap(),
            stdout: Vec::new(),
            stderr: "Clé absente. Exécutez d\'abord : gpubnb-agent setup"
                .as_bytes()
                .to_vec(),
        };
        assert_eq!(classify_agent_failure(&output), "agent_setup_required");
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

    #[test]
    fn expensive_commands_have_explicit_longer_timeouts() {
        assert_eq!(command_timeout(&["status"]), STATUS_TIMEOUT);
        assert_eq!(command_timeout(&["link", "A1B2C3D4E5"]), MUTATION_TIMEOUT);
        assert_eq!(command_timeout(&["setup"]), SETUP_TIMEOUT);
        assert_eq!(
            command_timeout(&["protections", "verify"]),
            PROTECTION_TIMEOUT
        );
    }

    #[test]
    fn desktop_bridge_executes_setup_link_start_and_status_against_agent_protocol() {
        let _guard = ENVIRONMENT_LOCK.lock().unwrap();
        let (directory, executable) = integration_fixture();
        let config_directory = directory.join("config");
        fs::create_dir_all(&config_directory).unwrap();
        fs::write(
            config_directory.join("config.json"),
            r#"{"machineId":"machine_integration"}"#,
        )
        .unwrap();
        std::env::set_var("GPUBNB_TEST_AGENT_EXECUTABLE", &executable);
        std::env::set_var("GPUBNB_CONFIG_DIR", &config_directory);

        let result = (|| {
            let setup_status = setup()?;
            assert!(setup_status.installed);
            assert!(setup_status.linked);
            assert!(setup_status.running);
            assert_eq!(
                link("A1B2C3D4E5")?.machine_id.as_deref(),
                Some("machine_integration")
            );
            assert!(start()?.running);
            Ok::<(), String>(())
        })();

        std::env::remove_var("GPUBNB_TEST_AGENT_EXECUTABLE");
        std::env::remove_var("GPUBNB_CONFIG_DIR");
        let _ = fs::remove_dir_all(directory);
        result.unwrap();
    }
}
