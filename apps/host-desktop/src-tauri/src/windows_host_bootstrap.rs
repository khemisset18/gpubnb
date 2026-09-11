use std::path::{Path, PathBuf};

const HOST_AUTOSTART_VALUE_NAME: &str = "GPUbnb Host";

fn autostart_value(executable: &Path) -> String {
    format!("\"{}\"", executable.display())
}

fn docker_desktop_candidates_from(
    program_files: Option<&str>,
    local_app_data: Option<&str>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = program_files.filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(root).join("Docker/Docker/Docker Desktop.exe"));
    }
    if let Some(root) = local_app_data.filter(|value| !value.is_empty()) {
        candidates.push(
            PathBuf::from(root).join("Programs/Docker/Docker/Docker Desktop.exe"),
        );
        candidates.push(PathBuf::from(root).join("Programs/DockerDesktop/Docker Desktop.exe"));
        candidates.push(PathBuf::from(root).join("Docker/Docker Desktop.exe"));
    }
    candidates
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{autostart_value, docker_desktop_candidates_from, HOST_AUTOSTART_VALUE_NAME};
    use std::env;
    use std::ffi::OsStr;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    fn hidden_command(program: impl AsRef<OsStr>) -> Command {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn register_host_autostart() -> Result<(), String> {
        let executable = env::current_exe().map_err(|error| format!("host_executable:{error}"))?;
        let value = autostart_value(&executable);
        let status = hidden_command("reg.exe")
            .args([
                "ADD",
                RUN_KEY,
                "/v",
                HOST_AUTOSTART_VALUE_NAME,
                "/t",
                "REG_SZ",
                "/d",
                value.as_str(),
                "/f",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("host_autostart_registry:{error}"))?;
        if !status.success() {
            return Err(format!("host_autostart_registry_exit:{}", status.code().unwrap_or(-1)));
        }
        Ok(())
    }

    fn docker_desktop_running() -> Result<bool, String> {
        let output = hidden_command("tasklist.exe")
            .args([
                "/FI",
                "IMAGENAME eq Docker Desktop.exe",
                "/FO",
                "CSV",
                "/NH",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("docker_tasklist:{error}"))?;
        if !output.status.success() {
            return Err(format!("docker_tasklist_exit:{}", output.status.code().unwrap_or(-1)));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .to_ascii_lowercase()
            .contains("docker desktop.exe"))
    }

    fn docker_desktop_candidates() -> Vec<PathBuf> {
        let program_files = env::var("ProgramFiles").ok().or_else(|| Some(r"C:\Program Files".into()));
        let local_app_data = env::var("LOCALAPPDATA").ok();
        docker_desktop_candidates_from(program_files.as_deref(), local_app_data.as_deref())
    }

    fn ensure_docker_desktop_started() -> Result<bool, String> {
        if docker_desktop_running()? {
            return Ok(false);
        }
        let executable = docker_desktop_candidates()
            .into_iter()
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| "docker_desktop_not_found".to_owned())?;
        hidden_command(&executable)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("docker_desktop_start:{error}"))?;
        Ok(true)
    }

    pub(super) fn prepare_host_startup_windows() {
        // Registration is idempotent and refreshes the path after an application
        // update, so the next Windows logon always launches the installed Host.
        if let Err(error) = register_host_autostart() {
            eprintln!("GPUbnb Host autostart setup failed: {error}");
        }
        // Docker Desktop is a user-session application. Starting it here (rather
        // than from the LocalSystem Agent service) avoids Session-0/UI isolation
        // and gives the already-auto-started Agent its container backend as soon
        // as the owner logs in after a reboot.
        if let Err(error) = ensure_docker_desktop_started() {
            eprintln!("GPUbnb Docker startup failed: {error}");
        }
    }
}

pub fn prepare_host_startup() {
    #[cfg(target_os = "windows")]
    windows::prepare_host_startup_windows();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_value_quotes_executable_paths_with_spaces() {
        assert_eq!(
            autostart_value(Path::new(r"C:\Program Files\GPUbnb Host\GPUbnb Host.exe")),
            r#"\"C:\Program Files\GPUbnb Host\GPUbnb Host.exe\""#
        );
    }

    #[test]
    fn docker_candidates_cover_machine_and_per_user_installs() {
        let candidates = docker_desktop_candidates_from(
            Some(r"C:\Program Files"),
            Some(r"C:\Users\host\AppData\Local"),
        );
        self::assert_candidates(&candidates);
    }

    fn assert_candidates(candidates: &[PathBuf]) {
        assert!(candidates.iter().any(|path| {
            path.ends_with(Path::new(r"Docker\Docker\Docker Desktop.exe"))
        }));
        assert!(candidates.iter().any(|path| {
            path.ends_with(Path::new(r"Programs\DockerDesktop\Docker Desktop.exe"))
        }));
    }
}
