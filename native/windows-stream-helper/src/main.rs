//! GPUbnb Windows-native stream helper authority boundary.
//!
//! This bootstrap binary is intentionally fail-closed. It implements the strict
//! CLI/input contract and owns no capture/session resources yet. A future Windows
//! backend may return success only after the IddCx virtual-display, DXGI capture,
//! exact-GPU NVENC and input-isolation proofs required by the Agent all pass.

use std::env;
use std::process::ExitCode;

const MAX_SESSION_ID: usize = 200;
const MAX_GPU_UUID: usize = 200;
const MAX_APPLICATION_PATH: usize = 1024;
const WORKSPACES: [&str; 4] = ["cloud-desktop", "creator", "cad", "gaming"];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    SelfTest,
    Start {
        session_id: String,
        workspace: String,
        gpu_uuid: String,
        application: Option<String>,
    },
    Stop {
        session_id: String,
    },
    Suspend {
        session_id: String,
    },
    Resume {
        session_id: String,
    },
    Status {
        session_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CliError {
    code: &'static str,
    exit_code: u8,
}

impl CliError {
    const fn new(code: &'static str, exit_code: u8) -> Self {
        Self { code, exit_code }
    }
}

fn validate_session_id(value: &str) -> Result<(), CliError> {
    if value.is_empty()
        || value.len() > MAX_SESSION_ID
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(CliError::new("invalid_session_id", 2));
    }
    Ok(())
}

fn validate_workspace(value: &str) -> Result<(), CliError> {
    if WORKSPACES.contains(&value) {
        Ok(())
    } else {
        Err(CliError::new("unsupported_workspace", 2))
    }
}

fn validate_gpu_uuid(value: &str) -> Result<(), CliError> {
    // NVIDIA physical GPU UUIDs exposed by nvidia-smi use GPU- followed by a
    // canonical 8-4-4-4-12 hexadecimal UUID. Reject looser strings so a future
    // backend cannot silently accept aliases, device names or injected arguments.
    if value.len() > MAX_GPU_UUID || !value.starts_with("GPU-") {
        return Err(CliError::new("invalid_gpu_uuid", 2));
    }
    let uuid = &value[4..];
    if uuid.len() != 36 {
        return Err(CliError::new("invalid_gpu_uuid", 2));
    }
    for (index, byte) in uuid.bytes().enumerate() {
        let hyphen = matches!(index, 8 | 13 | 18 | 23);
        if (hyphen && byte != b'-') || (!hyphen && !byte.is_ascii_hexdigit()) {
            return Err(CliError::new("invalid_gpu_uuid", 2));
        }
    }
    Ok(())
}

fn validate_application(value: &str) -> Result<(), CliError> {
    // Only local, drive-qualified Win32 executable paths are accepted. UNC paths,
    // device namespaces, relative paths, alternate data streams and path traversal
    // are intentionally rejected even though the Agent also performs discovery.
    if value.is_empty()
        || value.len() > MAX_APPLICATION_PATH
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.starts_with(r"\\")
        || value.starts_with(r"\\?\")
        || value.starts_with(r"\\.\")
    {
        return Err(CliError::new("invalid_application_path", 2));
    }

    let bytes = value.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || !value.to_ascii_lowercase().ends_with(".exe")
    {
        return Err(CliError::new("invalid_application_path", 2));
    }

    // A colon is permitted only as the drive separator. This excludes NTFS ADS
    // forms such as "app.exe:stream". Reject dot components and Win32-normalized
    // trailing spaces/dots to avoid path interpretation mismatches.
    if value[2..].contains(':') {
        return Err(CliError::new("invalid_application_path", 2));
    }
    for component in value[3..].split('\\') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(' ')
            || component.ends_with('.')
        {
            return Err(CliError::new("invalid_application_path", 2));
        }
    }
    Ok(())
}

fn validate_workspace_application(
    workspace: &str,
    application: Option<&str>,
) -> Result<(), CliError> {
    match (workspace, application) {
        ("cloud-desktop", None) => Ok(()),
        ("cloud-desktop", Some(_)) => Err(CliError::new("application_not_allowed", 2)),
        ("creator" | "cad" | "gaming", Some(path)) => {
            validate_application(path)?;
            // Mirror the Agent's explicit discovery policy. A matching basename
            // alone does not authorize an arbitrary user/network supplied binary.
            let allowed: &[&str] = match workspace {
                "creator" => &[
                    r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
                    r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
                    r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
                ],
                "cad" => &[
                    r"C:\Program Files\FreeCAD 1.0\bin\FreeCAD.exe",
                    r"C:\Program Files\FreeCAD 0.21\bin\FreeCAD.exe",
                ],
                "gaming" => &[
                    r"C:\Program Files (x86)\Steam\steam.exe",
                    r"C:\Program Files\Steam\steam.exe",
                ],
                _ => unreachable!(),
            };
            if allowed
                .iter()
                .any(|candidate| path.eq_ignore_ascii_case(candidate))
            {
                Ok(())
            } else {
                Err(CliError::new("application_not_qualified", 2))
            }
        }
        ("creator" | "cad" | "gaming", None) => Err(CliError::new("application_required", 2)),
        _ => Err(CliError::new("unsupported_workspace", 2)),
    }
}

fn take_value(args: &[String], index: &mut usize, name: &'static str) -> Result<String, CliError> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| CliError::new(name, 2))
}

fn parse_start(args: &[String]) -> Result<Command, CliError> {
    let mut json = false;
    let mut session_id = None;
    let mut workspace = None;
    let mut gpu_uuid = None;
    let mut application = None;
    let mut i = 1;

    while i < args.len() {
        match args[i].as_str() {
            "--json" if !json => json = true,
            "--session-id" if session_id.is_none() => {
                session_id = Some(take_value(args, &mut i, "missing_session_id")?);
            }
            "--workspace" if workspace.is_none() => {
                workspace = Some(take_value(args, &mut i, "missing_workspace")?);
            }
            "--gpu-uuid" if gpu_uuid.is_none() => {
                gpu_uuid = Some(take_value(args, &mut i, "missing_gpu_uuid")?);
            }
            "--application" if application.is_none() => {
                application = Some(take_value(args, &mut i, "missing_application_path")?);
            }
            _ => return Err(CliError::new("unknown_or_duplicate_argument", 2)),
        }
        i += 1;
    }

    if !json {
        return Err(CliError::new("json_required", 2));
    }
    let session_id = session_id.ok_or_else(|| CliError::new("missing_session_id", 2))?;
    let workspace = workspace.ok_or_else(|| CliError::new("missing_workspace", 2))?;
    let gpu_uuid = gpu_uuid.ok_or_else(|| CliError::new("missing_gpu_uuid", 2))?;

    validate_session_id(&session_id)?;
    validate_workspace(&workspace)?;
    validate_gpu_uuid(&gpu_uuid)?;
    validate_workspace_application(&workspace, application.as_deref())?;

    Ok(Command::Start {
        session_id,
        workspace,
        gpu_uuid,
        application,
    })
}

fn parse_session_command(
    args: &[String],
    build: impl FnOnce(String) -> Command,
) -> Result<Command, CliError> {
    let mut json = false;
    let mut session_id = None;
    let mut i = 1;

    while i < args.len() {
        match args[i].as_str() {
            "--json" if !json => json = true,
            "--session-id" if session_id.is_none() => {
                session_id = Some(take_value(args, &mut i, "missing_session_id")?);
            }
            _ => return Err(CliError::new("unknown_or_duplicate_argument", 2)),
        }
        i += 1;
    }

    if !json {
        return Err(CliError::new("json_required", 2));
    }
    let session_id = session_id.ok_or_else(|| CliError::new("missing_session_id", 2))?;
    validate_session_id(&session_id)?;
    Ok(build(session_id))
}

fn parse_args(args: &[String]) -> Result<Command, CliError> {
    match args.first().map(String::as_str) {
        Some("--self-test") if args.len() == 2 && args[1] == "--json" => Ok(Command::SelfTest),
        Some("--self-test") => Err(CliError::new("invalid_self_test_arguments", 2)),
        Some("--start") => parse_start(args),
        Some("--stop") => parse_session_command(args, |session_id| Command::Stop { session_id }),
        Some("--suspend") => {
            parse_session_command(args, |session_id| Command::Suspend { session_id })
        }
        Some("--resume") => {
            parse_session_command(args, |session_id| Command::Resume { session_id })
        }
        Some("--status") => {
            parse_session_command(args, |session_id| Command::Status { session_id })
        }
        _ => Err(CliError::new("command_required", 2)),
    }
}

fn execute(command: &Command) -> Result<(), CliError> {
    match command {
        Command::SelfTest => {
            #[cfg(not(target_os = "windows"))]
            {
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                Err(CliError::new("native_backend_not_implemented", 21))
            }
        }
        Command::Start { .. }
        | Command::Stop { .. }
        | Command::Suspend { .. }
        | Command::Resume { .. }
        | Command::Status { .. } => Err(CliError::new("native_backend_not_implemented", 21)),
    }
}

fn error_json(error: CliError) -> String {
    // Error codes are compile-time ASCII constants. Never echo arguments, paths,
    // GPU identifiers, tokens or other caller-controlled data into diagnostics.
    format!(r#"{{"ok":false,"error":"{}"}}"#, error.code)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match parse_args(&args).and_then(|command| execute(&command)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            println!("{}", error_json(error));
            eprintln!("error:{}", error.code);
            ExitCode::from(error.exit_code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPU_UUID: &str = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn self_test_requires_exact_json_contract() {
        assert_eq!(
            parse_args(&strings(&["--self-test", "--json"])),
            Ok(Command::SelfTest)
        );
        assert_eq!(
            parse_args(&strings(&["--self-test"])),
            Err(CliError::new("invalid_self_test_arguments", 2))
        );
    }

    #[test]
    fn start_accepts_only_supported_workspace_and_safe_ids() {
        let command = parse_args(&strings(&[
            "--start",
            "--json",
            "--session-id",
            "sess-ABC_123",
            "--workspace",
            "creator",
            "--gpu-uuid",
            GPU_UUID,
            "--application",
            r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
        ]))
        .expect("valid contract");
        assert!(matches!(command, Command::Start { workspace, .. } if workspace == "creator"));

        let bad = parse_args(&strings(&[
            "--start",
            "--json",
            "--session-id",
            "../provider",
            "--workspace",
            "cloud-desktop",
            "--gpu-uuid",
            GPU_UUID,
        ]));
        assert_eq!(bad, Err(CliError::new("invalid_session_id", 2)));
    }

    #[test]
    fn lifecycle_commands_require_json_and_safe_session_id() {
        for (verb, expected) in [
            (
                "--stop",
                Command::Stop {
                    session_id: "sess-1".into(),
                },
            ),
            (
                "--suspend",
                Command::Suspend {
                    session_id: "sess-1".into(),
                },
            ),
            (
                "--resume",
                Command::Resume {
                    session_id: "sess-1".into(),
                },
            ),
            (
                "--status",
                Command::Status {
                    session_id: "sess-1".into(),
                },
            ),
        ] {
            assert_eq!(
                parse_args(&strings(&[verb, "--json", "--session-id", "sess-1"])),
                Ok(expected),
                "{verb}"
            );
            assert_eq!(
                parse_args(&strings(&[verb, "--session-id", "sess-1"])),
                Err(CliError::new("json_required", 2)),
                "{verb}"
            );
            assert_eq!(
                parse_args(&strings(&[verb, "--json", "--session-id", "../provider"])),
                Err(CliError::new("invalid_session_id", 2)),
                "{verb}"
            );
        }
    }

    #[test]
    fn gpu_uuid_requires_canonical_nvidia_uuid() {
        for invalid in [
            "GPU-EXACT",
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524g",
            "GPU-e8301c162a142b3ff057b21f3b00524a",
            "AMD-e8301c16-2a14-2b3f-f057-b21f3b00524a",
        ] {
            assert_eq!(
                validate_gpu_uuid(invalid),
                Err(CliError::new("invalid_gpu_uuid", 2)),
                "{invalid}"
            );
        }
        assert_eq!(validate_gpu_uuid(GPU_UUID), Ok(()));
    }

    #[test]
    fn application_path_must_be_local_absolute_executable() {
        assert_eq!(
            validate_application(r"C:\Program Files\Blender Foundation\blender.exe"),
            Ok(())
        );
        for invalid in [
            r"blender.exe",
            r"..\blender.exe",
            r"\\server\share\blender.exe",
            r"\\?\C:\Program Files\Blender\blender.exe",
            r"C:\Program Files\Blender\..\blender.exe",
            r"C:\Program Files\Blender\blender.exe:payload",
            r"C:/Program Files/Blender/blender.exe",
            r"C:\Program Files\Blender\blender.com",
        ] {
            assert_eq!(
                validate_application(invalid),
                Err(CliError::new("invalid_application_path", 2)),
                "{invalid}"
            );
        }
    }

    #[test]
    fn workspace_application_contract_is_fail_closed() {
        assert_eq!(
            validate_workspace_application("cloud-desktop", None),
            Ok(())
        );
        assert_eq!(
            validate_workspace_application("cloud-desktop", Some(r"C:\Windows\System32\cmd.exe")),
            Err(CliError::new("application_not_allowed", 2))
        );
        for workspace in ["creator", "cad", "gaming"] {
            assert_eq!(
                validate_workspace_application(workspace, None),
                Err(CliError::new("application_required", 2))
            );
        }
    }

    #[test]
    fn application_policy_rejects_arbitrary_and_cross_workspace_executables() {
        for workspace in ["creator", "cad", "gaming"] {
            for path in [
                r"C:\Windows\System32\cmd.exe",
                r"C:\Temp\blender.exe",
                r"C:\Temp\FreeCAD.exe",
                r"C:\Temp\steam.exe",
            ] {
                assert_eq!(
                    validate_workspace_application(workspace, Some(path)),
                    Err(CliError::new("application_not_qualified", 2))
                );
            }
        }
        assert_eq!(
            validate_workspace_application("creator", Some(r"C:\Program Files\Steam\steam.exe")),
            Err(CliError::new("application_not_qualified", 2))
        );
        for (workspace, path) in [
            (
                "creator",
                r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
            ),
            ("cad", r"C:\Program Files\FreeCAD 1.0\bin\FreeCAD.exe"),
            ("gaming", r"C:\Program Files (x86)\Steam\steam.exe"),
        ] {
            assert_eq!(
                validate_workspace_application(workspace, Some(path)),
                Ok(())
            );
            assert_eq!(
                validate_workspace_application(workspace, Some(&path.to_ascii_uppercase())),
                Ok(())
            );
        }
    }

    #[test]
    fn start_rejects_unknown_workspace_and_duplicate_arguments() {
        let unknown = parse_args(&strings(&[
            "--start",
            "--json",
            "--session-id",
            "sess-1",
            "--workspace",
            "developer",
            "--gpu-uuid",
            GPU_UUID,
        ]));
        assert_eq!(unknown, Err(CliError::new("unsupported_workspace", 2)));

        let duplicate = parse_args(&strings(&[
            "--start",
            "--json",
            "--json",
            "--session-id",
            "sess-1",
            "--workspace",
            "gaming",
            "--gpu-uuid",
            GPU_UUID,
            "--application",
            r"C:\Program Files (x86)\Steam\steam.exe",
        ]));
        assert_eq!(
            duplicate,
            Err(CliError::new("unknown_or_duplicate_argument", 2))
        );
    }

    #[test]
    fn stop_contract_is_strict() {
        assert_eq!(
            parse_args(&strings(&["--stop", "--json", "--session-id", "sess-1"])),
            Ok(Command::Stop {
                session_id: "sess-1".to_owned()
            })
        );
        assert!(parse_args(&strings(&["--stop", "--session-id", "sess-1"])).is_err());
    }

    #[test]
    fn error_output_is_machine_readable_and_secret_free() {
        let error = CliError::new("native_backend_not_implemented", 21);
        assert_eq!(
            error_json(error),
            r#"{"ok":false,"error":"native_backend_not_implemented"}"#
        );
        assert!(!error_json(error).contains("GPU-"));
        assert!(!error_json(error).contains("\\"));
    }

    #[test]
    fn bootstrap_backend_can_never_report_success() {
        let commands = [
            Command::SelfTest,
            Command::Start {
                session_id: "sess-1".to_owned(),
                workspace: "cloud-desktop".to_owned(),
                gpu_uuid: GPU_UUID.to_owned(),
                application: None,
            },
            Command::Stop {
                session_id: "sess-1".to_owned(),
            },
        ];
        assert!(commands.iter().all(|command| execute(command).is_err()));
    }
}
