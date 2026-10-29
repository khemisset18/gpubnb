//! GPUbnb Windows-native stream helper authority boundary.
//!
//! Cloud Desktop uses a persistent per-session authority backed by the real
//! renter-session, IddCx virtual-display, capture, exact-GPU NVENC, media and
//! input proof chain. Unsupported Windows Workspaces and missing physical renter
//! prerequisites remain fail-closed; no success-shaped reply is emitted for a
//! partial or simulated backend.

use std::env;
use std::process::ExitCode;

const MAX_SESSION_ID: usize = 200;
const MAX_GPU_UUID: usize = 200;
const MAX_APPLICATION_PATH: usize = 1024;
const WORKSPACES: [&str; 4] = ["cloud-desktop", "creator", "cad", "gaming"];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    SelfTest,
    SelfTestConsole,
    Start {
        session_id: String,
        workspace: String,
        gpu_uuid: String,
        application: Option<String>,
    },
    StartConsole {
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
    AuthorityChild {
        session_id: String,
        workspace: String,
        gpu_uuid: String,
    },
    AuthorityConsoleChild {
        session_id: String,
        workspace: String,
        gpu_uuid: String,
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

fn parse_authority_child(args: &[String]) -> Result<Command, CliError> {
    if args.len() != 7
        || args[1] != "--session-id"
        || args[3] != "--workspace"
        || args[5] != "--gpu-uuid"
    {
        return Err(CliError::new("invalid_authority_arguments", 2));
    }
    let session_id = args[2].clone();
    let workspace = args[4].clone();
    let gpu_uuid = args[6].clone();
    validate_session_id(&session_id)?;
    validate_workspace(&workspace)?;
    validate_gpu_uuid(&gpu_uuid)?;
    if workspace != "cloud-desktop" {
        return Err(CliError::new("workspace_not_implemented", 21));
    }
    Ok(Command::AuthorityChild {
        session_id,
        workspace,
        gpu_uuid,
    })
}

fn parse_args(args: &[String]) -> Result<Command, CliError> {
    match args.first().map(String::as_str) {
        Some("--authority-child") => parse_authority_child(args),
        Some("--authority-console-child") => match parse_authority_child(args)? {
            Command::AuthorityChild {
                session_id,
                workspace,
                gpu_uuid,
            } => Ok(Command::AuthorityConsoleChild {
                session_id,
                workspace,
                gpu_uuid,
            }),
            _ => Err(CliError::new("invalid_authority_arguments", 2)),
        },
        Some("--self-test") if args.len() == 2 && args[1] == "--json" => Ok(Command::SelfTest),
        Some("--self-test-console") if args.len() == 2 && args[1] == "--json" => {
            Ok(Command::SelfTestConsole)
        }
        Some("--self-test") => Err(CliError::new("invalid_self_test_arguments", 2)),
        Some("--start") => parse_start(args),
        Some("--start-console") => match parse_start(args)? {
            Command::Start {
                session_id,
                workspace,
                gpu_uuid,
                application,
            } => Ok(Command::StartConsole {
                session_id,
                workspace,
                gpu_uuid,
                application,
            }),
            _ => Err(CliError::new("invalid_start_arguments", 2)),
        },
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

#[cfg(target_os = "windows")]
fn authority_error(error: gpubnb_windows_stream_helper::authority::AuthorityError) -> CliError {
    CliError::new(error.code(), 21)
}

fn execute(command: &Command) -> Result<String, CliError> {
    match command {
        Command::SelfTest => {
            #[cfg(not(target_os = "windows"))]
            {
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                let report = gpubnb_windows_stream_helper::authority::run_self_test()
                    .map_err(authority_error)?;
                Ok(format!(
                    r#"{{"schemaVersion":1,"platform":"windows","helperVersion":"{}","gpuUuid":"{}","isolatedSession":true,"separateRenterIdentity":true,"renterSessionActive":true,"providerSessionInactive":true,"virtualDisplay":true,"providerDesktopExcluded":true,"captureFrame":true,"exactGpuBound":true,"nvencReady":true,"hardwareEncoder":"nvenc","mediaLoopback":true,"inputIsolation":true,"audioAvailable":false}}"#,
                    env!("CARGO_PKG_VERSION"),
                    report.gpu_uuid
                ))
            }
        }
        Command::SelfTestConsole => {
            #[cfg(not(target_os = "windows"))]
            {
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                let report = gpubnb_windows_stream_helper::authority::run_console_self_test()
                    .map_err(authority_error)?;
                Ok(format!(
                    r#"{{"schemaVersion":1,"platform":"windows","captureBackend":"console-dedicated","helperVersion":"{}","gpuUuid":"{}","isolatedSession":true,"separateRenterIdentity":true,"renterSessionActive":true,"providerSessionInactive":true,"consoleDisplay":true,"virtualDisplay":false,"providerDesktopExcluded":true,"captureFrame":true,"exactGpuBound":true,"nvencReady":true,"hardwareEncoder":"nvenc","mediaLoopback":true,"inputIsolation":true,"audioAvailable":false}}"#,
                    env!("CARGO_PKG_VERSION"),
                    report.gpu_uuid
                ))
            }
        }
        Command::Start {
            session_id,
            workspace,
            gpu_uuid,
            application: _,
        } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (session_id, workspace, gpu_uuid);
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                let report = gpubnb_windows_stream_helper::authority::start_session(
                    session_id, workspace, gpu_uuid,
                )
                .map_err(authority_error)?;
                Ok(format!(
                    r#"{{"schemaVersion":1,"sessionId":"{session_id}","workspaceSlug":"{workspace}","gpuUuid":"{gpu_uuid}","helperVersion":"{}","isolatedSession":true,"separateRenterIdentity":true,"renterSessionActive":true,"providerSessionInactive":true,"virtualDisplay":true,"providerDesktopExcluded":true,"captureReady":true,"exactGpuBound":true,"nvencReady":true,"hardwareEncoder":"nvenc","mediaReady":true,"inputIsolation":true,"inputReady":true,"mediaUrl":"http://127.0.0.1:{}/session/{session_id}","mediaToken":"{}","audioReady":false,"controllerReady":false}}"#,
                    env!("CARGO_PKG_VERSION"),
                    report.media_port,
                    report.media_token
                ))
            }
        }
        Command::StartConsole {
            session_id,
            workspace,
            gpu_uuid,
            application: _,
        } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (session_id, workspace, gpu_uuid);
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                let report = gpubnb_windows_stream_helper::authority::start_console_session(
                    session_id, workspace, gpu_uuid,
                )
                .map_err(authority_error)?;
                Ok(format!(
                    r#"{{"schemaVersion":1,"captureBackend":"console-dedicated","consoleDisplay":true,"virtualDisplay":false,"sessionId":"{session_id}","workspaceSlug":"{workspace}","gpuUuid":"{gpu_uuid}","helperVersion":"{}","isolatedSession":true,"separateRenterIdentity":true,"renterSessionActive":true,"providerSessionInactive":true,"providerDesktopExcluded":true,"captureReady":true,"exactGpuBound":true,"nvencReady":true,"hardwareEncoder":"nvenc","mediaReady":true,"inputIsolation":true,"inputReady":true,"mediaUrl":"http://127.0.0.1:{}/session/{session_id}","mediaToken":"{}","audioReady":false,"controllerReady":false}}"#,
                    env!("CARGO_PKG_VERSION"),
                    report.media_port,
                    report.media_token
                ))
            }
        }
        Command::Status { session_id } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = session_id;
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                use gpubnb_windows_stream_helper::authority::AuthorityStatus;
                let status = gpubnb_windows_stream_helper::authority::status_session(session_id)
                    .map_err(authority_error)?;
                let (ready, suspended, console) = match status {
                    AuthorityStatus::Ready => (true, false, false),
                    AuthorityStatus::Suspended => (false, true, false),
                    AuthorityStatus::Degraded => (false, false, false),
                    AuthorityStatus::ConsoleReady => (true, false, true),
                    AuthorityStatus::ConsoleSuspended => (false, true, true),
                    AuthorityStatus::ConsoleDegraded => (false, false, true),
                };
                let capture_backend = if console {
                    "console-dedicated"
                } else {
                    "iddcx"
                };
                let virtual_display = !console;
                Ok(format!(
                    r#"{{"schemaVersion":1,"sessionId":"{session_id}","captureBackend":"{capture_backend}","consoleDisplay":{console},"running":true,"suspended":{suspended},"isolatedSession":true,"renterSessionActive":true,"providerSessionInactive":true,"virtualDisplay":{virtual_display},"providerDesktopExcluded":true,"exactGpuBound":true,"captureReady":{ready},"nvencReady":{ready},"hardwareEncoder":"nvenc","mediaReady":{ready},"inputIsolation":true,"inputReady":{ready}}}"#
                ))
            }
        }
        Command::Suspend { session_id } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = session_id;
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                gpubnb_windows_stream_helper::authority::suspend_session(session_id)
                    .map_err(authority_error)?;
                Ok(format!(
                    r#"{{"schemaVersion":1,"sessionId":"{session_id}","suspended":true,"mediaReady":false,"inputReady":false}}"#
                ))
            }
        }
        Command::Resume { session_id } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = session_id;
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                use gpubnb_windows_stream_helper::authority::AuthorityStatus;
                let media_token =
                    gpubnb_windows_stream_helper::authority::resume_session(session_id)
                        .map_err(authority_error)?;
                // Re-read the actual authority backend after fresh media proof.
                let status = gpubnb_windows_stream_helper::authority::status_session(session_id)
                    .map_err(authority_error)?;
                let console = match status {
                    AuthorityStatus::Ready => false,
                    AuthorityStatus::ConsoleReady => true,
                    _ => return Err(CliError::new("native_session_degraded", 21)),
                };
                let capture_backend = if console {
                    "console-dedicated"
                } else {
                    "iddcx"
                };
                let virtual_display = !console;
                Ok(format!(
                    r#"{{"schemaVersion":1,"sessionId":"{session_id}","resumed":true,"freshMediaProof":true,"captureBackend":"{capture_backend}","consoleDisplay":{console},"exactGpuBound":true,"virtualDisplay":{virtual_display},"providerDesktopExcluded":true,"captureReady":true,"nvencReady":true,"hardwareEncoder":"nvenc","mediaReady":true,"inputIsolation":true,"inputReady":true,"mediaToken":"{media_token}"}}"#
                ))
            }
        }
        Command::Stop { session_id } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = session_id;
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                gpubnb_windows_stream_helper::authority::stop_session(session_id)
                    .map_err(authority_error)?;
                Ok(format!(
                    r#"{{"schemaVersion":1,"sessionId":"{session_id}","stopped":true}}"#
                ))
            }
        }
        Command::AuthorityChild {
            session_id,
            workspace,
            gpu_uuid,
        }
        | Command::AuthorityConsoleChild {
            session_id,
            workspace,
            gpu_uuid,
        } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (session_id, workspace, gpu_uuid);
                Err(CliError::new("windows_required", 20))
            }
            #[cfg(target_os = "windows")]
            {
                match command {
                    Command::AuthorityConsoleChild { .. } => {
                        gpubnb_windows_stream_helper::authority::run_console_authority_child(
                            session_id, workspace, gpu_uuid,
                        )
                    }
                    _ => gpubnb_windows_stream_helper::authority::run_authority_child(
                        session_id, workspace, gpu_uuid,
                    ),
                }
                .map_err(authority_error)?;
                Ok(r#"{"ok":true,"authorityStopped":true}"#.to_owned())
            }
        }
    }
}

fn error_json(error: CliError) -> String {
    // Error codes are compile-time ASCII constants. Never echo arguments, paths,
    // GPU identifiers, tokens or other caller-controlled data into diagnostics.
    format!(r#"{{"ok":false,"error":"{}"}}"#, error.code)
}

// Pure build identity: never probes a GPU, starts an authority or opens a session.
fn build_policy_json() -> Result<String, CliError> {
    let source = option_env!("GPUBNB_SOURCE_COMMIT")
        .filter(|v| v.len() == 40 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or(CliError::new("build_source_commit_unconfigured", 21))?;
    let signer = option_env!("GPUBNB_WINDOWS_WORKER_SIGNER_SHA256")
        .filter(|v| {
            v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()) && *v != "0".repeat(64)
        })
        .ok_or(CliError::new("build_worker_signer_unconfigured", 21))?;
    let authority = if cfg!(feature = "release-candidate") {
        "release-candidate"
    } else if cfg!(feature = "physical-qualification") {
        "physical-qualification"
    } else {
        "disabled"
    };
    Ok(format!(
        r#"{{"schemaVersion":1,"sourceCommit":"{source}","workerSignerSha256":"{signer}","mutationAuthority":"{authority}","workerProtocol":{},"mediaTransportProtocol":{},"browserMediaProtocol":{},"browserInputProtocol":{}}}"#,
        gpubnb_windows_stream_helper::worker_protocol::WORKER_PROTOCOL_VERSION,
        gpubnb_windows_stream_helper::media_protocol::MEDIA_TRANSPORT_PROTOCOL_VERSION,
        gpubnb_windows_stream_helper::browser_media_protocol::BROWSER_MEDIA_PROTOCOL_VERSION,
        gpubnb_windows_stream_helper::browser_input_protocol::BROWSER_INPUT_PROTOCOL_VERSION,
    ))
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--build-policy", "--json"] {
        return match build_policy_json() {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                println!("{}", error_json(error));
                ExitCode::from(error.exit_code)
            }
        };
    }
    match parse_args(&args).and_then(|command| execute(&command)) {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
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

    #[test]
    fn build_identity_never_invents_missing_provenance_or_signer() {
        let configured = option_env!("GPUBNB_SOURCE_COMMIT").is_some()
            && option_env!("GPUBNB_WINDOWS_WORKER_SIGNER_SHA256").is_some();
        if !configured {
            assert!(build_policy_json().is_err());
        } else if let Ok(value) = build_policy_json() {
            assert!(value.contains("\"workerProtocol\":1"));
            assert!(value.contains("\"mediaTransportProtocol\":2"));
        }
    }

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

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn native_backend_fails_closed_off_windows() {
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
