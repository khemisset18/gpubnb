//! Persistent authority for one Windows-native Cloud Desktop session.
//!
//! One detached helper child owns the QualifiedGraphicsRuntime in memory. Separate
//! CLI invocations communicate through a same-identity, local-only named pipe.
//! No media capability or privileged runtime state is persisted to disk.

use crate::qualification_server::QualificationMediaServer;
use crate::renter_lease::load_renter_session_lease;
use crate::service_runtime::{
    QualifiedGraphicsRuntime, ServiceRuntimeConfig, ServiceRuntimeError,
    start_qualified_graphics_runtime,
};
use crate::worker_protocol::WorkerInputEvent;
use gpubnb_windows_platform::gpu_identity::resolve_nvidia_uuid_to_luid;
use gpubnb_windows_platform::idd_control::verify_virtual_display_absent;
use gpubnb_windows_platform::pipe::{
    connect_authority_pipe_client, create_authority_pipe, current_process_user_sid,
};
use gpubnb_windows_platform::secret::MediaCapabilityToken;
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CONTROL_CONNECT_TIMEOUT_MS: u32 = 5_000;
const CONTROL_READ_TIMEOUT_MS: u32 = 60_000;
const AUTHORITY_CHILD_ENV: &str = "GPUBNB_WINDOWS_AUTHORITY_CHILD";
const CLIENT_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityError {
    WindowsRequired,
    UnsupportedWorkspace,
    LeaseUnavailable,
    LeaseGpuMismatch,
    RandomGeneration,
    RuntimeStart,
    InputProof,
    MediaBind,
    MediaProof,
    Spawn,
    ControlPipe,
    ControlProtocol,
    AlreadyRunning,
    NotRunning,
    Suspended,
    Degraded,
    RuntimeFailure(&'static str),
    Stop,
    Cleanup,
}

impl AuthorityError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::WindowsRequired => "windows_required",
            Self::UnsupportedWorkspace => "workspace_not_implemented",
            Self::LeaseUnavailable => "renter_session_lease_unavailable",
            Self::LeaseGpuMismatch => "renter_session_lease_gpu_mismatch",
            Self::RandomGeneration => "authority_random_generation_failed",
            Self::RuntimeStart => "native_runtime_start_failed",
            Self::InputProof => "native_input_proof_failed",
            Self::MediaBind => "native_media_bind_failed",
            Self::MediaProof => "native_media_proof_failed",
            Self::Spawn => "native_authority_spawn_failed",
            Self::ControlPipe => "native_authority_control_failed",
            Self::ControlProtocol => "native_authority_protocol_failed",
            Self::AlreadyRunning => "native_session_already_running",
            Self::NotRunning => "native_session_not_running",
            Self::Suspended => "native_session_suspended",
            Self::Degraded => "native_session_degraded",
            Self::RuntimeFailure(code) => code,
            Self::Stop => "native_session_stop_failed",
            Self::Cleanup => "native_session_cleanup_failed",
        }
    }
}

fn bounded_runtime_failure_code(value: &str) -> Option<&'static str> {
    match value {
        "invalid_configuration" => Some("invalid_configuration"),
        "worker_signer_policy" => Some("worker_signer_policy"),
        "renter_session" => Some("renter_session"),
        "pipe" => Some("pipe"),
        "worker_trust" => Some("worker_trust"),
        "worker_launch" => Some("worker_launch"),
        "worker_handshake" => Some("worker_handshake"),
        "exact_gpu" => Some("exact_gpu"),
        "virtual_display" => Some("virtual_display"),
        "worker_protocol" => Some("worker_protocol"),
        "media_proof" => Some("media_proof"),
        "media_diagnostic" => Some("media_diagnostic"),
        "media_transport" => Some("media_transport"),
        "media_capability" => Some("media_capability"),
        "graphics_proof" => Some("graphics_proof"),
        "stop_unconfirmed" => Some("stop_unconfirmed"),
        "display_cleanup" => Some("display_cleanup"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfTestReport {
    pub gpu_uuid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartSessionReport {
    pub generation: u64,
    pub media_port: u16,
    pub media_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityStatus {
    Ready,
    Suspended,
    Degraded,
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn random_runtime_identity() -> Result<(u64, [u8; 16]), AuthorityError> {
    let token = MediaCapabilityToken::generate().map_err(|_| AuthorityError::RandomGeneration)?;
    let bytes = token.as_str().as_bytes();
    if bytes.len() != 64 {
        return Err(AuthorityError::RandomGeneration);
    }
    let generation = u64::from_str_radix(&token.as_str()[..16], 16)
        .map_err(|_| AuthorityError::RandomGeneration)?;
    if generation == 0 {
        return Err(AuthorityError::RandomGeneration);
    }
    let mut nonce = [0u8; 16];
    for (index, slot) in nonce.iter_mut().enumerate() {
        let offset = 16 + index * 2;
        let high = hex_nibble(bytes[offset]).ok_or(AuthorityError::RandomGeneration)?;
        let low = hex_nibble(bytes[offset + 1]).ok_or(AuthorityError::RandomGeneration)?;
        *slot = (high << 4) | low;
    }
    if nonce == [0; 16] {
        return Err(AuthorityError::RandomGeneration);
    }
    Ok((generation, nonce))
}

fn runtime_config<'a>(
    session_id: &'a str,
    gpu_uuid: &'a str,
    lease: &'a crate::renter_lease::RenterSessionLease,
    generation: u64,
    display_nonce: [u8; 16],
) -> ServiceRuntimeConfig<'a> {
    ServiceRuntimeConfig {
        session_id,
        generation,
        workspace: crate::lifecycle::WorkspaceKind::CloudDesktop,
        gpu_uuid,
        windows_session_id: lease.windows_session_id,
        renter_user_sid: &lease.renter_user_sid,
        provider_user_sid: &lease.provider_user_sid,
        display_nonce,
        width: 1920,
        height: 1080,
        refresh_hz: 60,
    }
}

fn verified_lease(
    gpu_uuid: &str,
) -> Result<crate::renter_lease::RenterSessionLease, AuthorityError> {
    let lease = load_renter_session_lease().map_err(|_| AuthorityError::LeaseUnavailable)?;
    if !lease.gpu_uuid.eq_ignore_ascii_case(gpu_uuid) {
        return Err(AuthorityError::LeaseGpuMismatch);
    }
    resolve_nvidia_uuid_to_luid(gpu_uuid).map_err(|_| AuthorityError::LeaseGpuMismatch)?;
    Ok(lease)
}

fn read_headers<R: BufRead>(reader: &mut R) -> Result<String, AuthorityError> {
    let mut bytes = Vec::with_capacity(1024);
    loop {
        let mut line = Vec::with_capacity(128);
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| AuthorityError::MediaProof)?;
        if count == 0 || !line.ends_with(b"\r\n") {
            return Err(AuthorityError::MediaProof);
        }
        let next = bytes
            .len()
            .checked_add(line.len())
            .ok_or(AuthorityError::MediaProof)?;
        if next > 8192 {
            return Err(AuthorityError::MediaProof);
        }
        let done = line == b"\r\n";
        bytes.extend_from_slice(&line);
        if done {
            return String::from_utf8(bytes).map_err(|_| AuthorityError::MediaProof);
        }
    }
}

fn read_ws_binary<R: Read>(reader: &mut R) -> Result<Vec<u8>, AuthorityError> {
    let mut first = [0u8; 2];
    reader
        .read_exact(&mut first)
        .map_err(|_| AuthorityError::MediaProof)?;
    if first[0] != 0x82 || first[1] & 0x80 != 0 {
        return Err(AuthorityError::MediaProof);
    }
    let mut length = u64::from(first[1] & 0x7f);
    if length == 126 {
        let mut raw = [0u8; 2];
        reader
            .read_exact(&mut raw)
            .map_err(|_| AuthorityError::MediaProof)?;
        length = u64::from(u16::from_be_bytes(raw));
    } else if length == 127 {
        let mut raw = [0u8; 8];
        reader
            .read_exact(&mut raw)
            .map_err(|_| AuthorityError::MediaProof)?;
        length = u64::from_be_bytes(raw);
    }
    if length == 0 || length > 1024 * 1024 + 4096 {
        return Err(AuthorityError::MediaProof);
    }
    let mut payload = vec![0u8; length as usize];
    reader
        .read_exact(&mut payload)
        .map_err(|_| AuthorityError::MediaProof)?;
    Ok(payload)
}

fn run_probe_client(
    endpoint: SocketAddr,
    session_id: String,
    token: String,
) -> Result<(), AuthorityError> {
    let mut stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(10))
        .map_err(|_| AuthorityError::MediaProof)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|_| AuthorityError::MediaProof)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| AuthorityError::MediaProof)?;
    let request = format!(
        "GET /session/{session_id} HTTP/1.1\r\nHost: {endpoint}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {CLIENT_KEY}\r\nX-GPUbnb-Media-Token: {token}\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| AuthorityError::MediaProof)?;
    let mut reader = BufReader::new(stream);
    let response = read_headers(&mut reader)?;
    if !response.starts_with("HTTP/1.1 101 Switching Protocols\r\n") {
        return Err(AuthorityError::MediaProof);
    }
    let frame = read_ws_binary(&mut reader)?;
    if frame.len() < crate::browser_media_protocol::BROWSER_MEDIA_HEADER_SIZE {
        return Err(AuthorityError::MediaProof);
    }
    Ok(())
}

pub fn run_self_test() -> Result<SelfTestReport, AuthorityError> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err(AuthorityError::WindowsRequired);
    }
    #[cfg(target_os = "windows")]
    {
        let lease = load_renter_session_lease().map_err(|_| AuthorityError::LeaseUnavailable)?;
        resolve_nvidia_uuid_to_luid(&lease.gpu_uuid)
            .map_err(|_| AuthorityError::LeaseGpuMismatch)?;
        let session_id = format!("selftest-{}", std::process::id());
        let (generation, display_nonce) = random_runtime_identity()?;
        let mut runtime = start_qualified_graphics_runtime(runtime_config(
            &session_id,
            &lease.gpu_uuid,
            &lease,
            generation,
            display_nonce,
        ))
        .map_err(|_| AuthorityError::RuntimeStart)?;

        let proof_result = (|| {
            runtime
                .inject_input(WorkerInputEvent::MouseMoveRelative { dx: 1, dy: 0 })
                .map_err(|_| AuthorityError::InputProof)?;
            runtime
                .suspend_media()
                .map_err(|_| AuthorityError::InputProof)?;
            runtime
                .resume_after_fresh_proof()
                .map_err(|_| AuthorityError::InputProof)?;
            runtime
                .inject_input(WorkerInputEvent::MouseMoveRelative { dx: -1, dy: 0 })
                .map_err(|_| AuthorityError::InputProof)?;

            let stream_epoch = runtime.stream_epoch();
            let server = QualificationMediaServer::bind(&session_id, stream_epoch)
                .map_err(|_| AuthorityError::MediaBind)?;
            let endpoint = server.endpoint().map_err(|_| AuthorityError::MediaBind)?;
            let token = runtime
                .media_token()
                .ok_or(AuthorityError::MediaProof)?
                .to_owned();
            let client_session = session_id.clone();
            let client = thread::spawn(move || run_probe_client(endpoint, client_session, token));
            let sent = server.serve_once(&mut runtime, 1).map_err(|error| {
                eprintln!("gpubnb_self_test media_server_error={error:?}");
                AuthorityError::MediaProof
            })?;
            let client_result = client.join().map_err(|_| AuthorityError::MediaProof)?;
            if let Err(error) = &client_result {
                eprintln!("gpubnb_self_test client_error={error:?}");
            }
            client_result?;
            if sent != 1 {
                return Err(AuthorityError::MediaProof);
            }
            Ok(())
        })();

        let stop_result = runtime.stop().map_err(|_| AuthorityError::Cleanup);
        proof_result?;
        stop_result?;
        Ok(SelfTestReport {
            gpu_uuid: lease.gpu_uuid,
        })
    }
}

fn parse_ready(value: &str) -> Result<StartSessionReport, AuthorityError> {
    let mut parts = value.split('|');
    if parts.next() != Some("READY") {
        return Err(match value {
            "ERR|already_running" => AuthorityError::AlreadyRunning,
            _ => AuthorityError::ControlProtocol,
        });
    }
    let generation = parts
        .next()
        .ok_or(AuthorityError::ControlProtocol)?
        .parse::<u64>()
        .map_err(|_| AuthorityError::ControlProtocol)?;
    let media_port = parts
        .next()
        .ok_or(AuthorityError::ControlProtocol)?
        .parse::<u16>()
        .map_err(|_| AuthorityError::ControlProtocol)?;
    let media_token = parts
        .next()
        .ok_or(AuthorityError::ControlProtocol)?
        .to_owned();
    if generation == 0
        || media_port == 0
        || media_token.len() != 64
        || !media_token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || parts.next().is_some()
    {
        return Err(AuthorityError::ControlProtocol);
    }
    Ok(StartSessionReport {
        generation,
        media_port,
        media_token,
    })
}

fn control_request(
    session_id: &str,
    request: &str,
    connect_timeout_ms: u32,
    read_timeout_ms: u32,
) -> Result<String, AuthorityError> {
    let client = connect_authority_pipe_client(session_id, connect_timeout_ms)
        .map_err(|_| AuthorityError::ControlPipe)?;
    client
        .send_frame(request.as_bytes())
        .map_err(|_| AuthorityError::ControlPipe)?;
    let response = client
        .read_frame(read_timeout_ms)
        .map_err(|_| AuthorityError::ControlPipe)?;
    String::from_utf8(response).map_err(|_| AuthorityError::ControlProtocol)
}

pub fn start_session(
    session_id: &str,
    workspace: &str,
    gpu_uuid: &str,
) -> Result<StartSessionReport, AuthorityError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (session_id, workspace, gpu_uuid);
        return Err(AuthorityError::WindowsRequired);
    }
    #[cfg(target_os = "windows")]
    {
        if workspace != "cloud-desktop" {
            return Err(AuthorityError::UnsupportedWorkspace);
        }
        let _lease = verified_lease(gpu_uuid)?;

        if control_request(session_id, "STATUS", 100, 1_000).is_ok() {
            return Err(AuthorityError::AlreadyRunning);
        }

        let executable = env::current_exe().map_err(|_| AuthorityError::Spawn)?;
        let mut command = Command::new(executable);
        command
            .arg("--authority-child")
            .arg("--session-id")
            .arg(session_id)
            .arg("--workspace")
            .arg(workspace)
            .arg("--gpu-uuid")
            .arg(gpu_uuid)
            .env(AUTHORITY_CHILD_ENV, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.creation_flags(0x0000_0008 | 0x0800_0000);
        let mut child = command.spawn().map_err(|_| AuthorityError::Spawn)?;

        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(_status) = child.try_wait().map_err(|_| AuthorityError::Spawn)? {
                return Err(AuthorityError::RuntimeStart);
            }
            match control_request(session_id, "START", 500, CONTROL_READ_TIMEOUT_MS) {
                Ok(response) => return parse_ready(&response),
                Err(_) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(_) => return Err(AuthorityError::ControlPipe),
            }
        }
    }
}

pub fn status_session(session_id: &str) -> Result<AuthorityStatus, AuthorityError> {
    let response = control_request(session_id, "STATUS", CONTROL_CONNECT_TIMEOUT_MS, 10_000)?;
    match response.as_str() {
        "STATUS|ready" => Ok(AuthorityStatus::Ready),
        "STATUS|suspended" => Ok(AuthorityStatus::Suspended),
        "STATUS|degraded" => Ok(AuthorityStatus::Degraded),
        "ERR|not_running" => Err(AuthorityError::NotRunning),
        _ => Err(AuthorityError::ControlProtocol),
    }
}

pub fn suspend_session(session_id: &str) -> Result<(), AuthorityError> {
    let response = control_request(
        session_id,
        "SUSPEND",
        CONTROL_CONNECT_TIMEOUT_MS,
        CONTROL_READ_TIMEOUT_MS,
    )?;
    match response.as_str() {
        "OK|suspended" => Ok(()),
        "ERR|not_running" => Err(AuthorityError::NotRunning),
        "ERR|degraded" => Err(AuthorityError::Degraded),
        _ => {
            if let Some(code) = response.strip_prefix("ERR|degraded|") {
                return Err(
                    bounded_runtime_failure_code(code)
                        .map(AuthorityError::RuntimeFailure)
                        .unwrap_or(AuthorityError::ControlProtocol),
                );
            }
            Err(AuthorityError::ControlProtocol)
        }
    }
}

pub fn resume_session(session_id: &str) -> Result<String, AuthorityError> {
    let response = control_request(
        session_id,
        "RESUME",
        CONTROL_CONNECT_TIMEOUT_MS,
        CONTROL_READ_TIMEOUT_MS,
    )?;
    if let Some(token) = response.strip_prefix("OK|resumed|") {
        if token.len() == 64
            && token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Ok(token.to_owned());
        }
        return Err(AuthorityError::ControlProtocol);
    }
    match response.as_str() {
        "ERR|not_running" => Err(AuthorityError::NotRunning),
        "ERR|media_endpoint_lost" => Err(AuthorityError::Degraded),
        _ => Err(AuthorityError::ControlProtocol),
    }
}

pub fn stop_session(session_id: &str) -> Result<(), AuthorityError> {
    let response = match control_request(
        session_id,
        "STOP",
        CONTROL_CONNECT_TIMEOUT_MS,
        CONTROL_READ_TIMEOUT_MS,
    ) {
        Ok(response) => response,
        // A connection failure alone is ambiguous: the authority could be busy
        // or wedged. Prove absence by acquiring FIRST_PIPE_INSTANCE ourselves.
        // Only then is idempotent STOP allowed to report an already-clean state.
        Err(AuthorityError::ControlPipe) => {
            let owner_sid = current_process_user_sid().map_err(|_| AuthorityError::ControlPipe)?;
            match create_authority_pipe(session_id, &owner_sid) {
                Ok(proof_of_absence) => {
                    // Keep FIRST_PIPE_INSTANCE held while checking the display:
                    // a concurrent START must not create a new authority between
                    // the authority-absence proof and the IDD-absence proof.
                    // A crashed owner could have left an IddCx departure failure
                    // behind, so never report idempotent STOP until the driver
                    // also proves that no GPUbnb monitor remains.
                    verify_virtual_display_absent().map_err(|_| AuthorityError::Cleanup)?;
                    drop(proof_of_absence);
                    return Ok(());
                }
                Err(_) => return Err(AuthorityError::ControlPipe),
            }
        }
        Err(error) => return Err(error),
    };
    match response.as_str() {
        "OK|stopped" => Ok(()),
        "ERR|stop_failed" => Err(AuthorityError::Stop),
        _ => {
            if let Some(code) = response.strip_prefix("ERR|stop_failed|") {
                return Err(
                    bounded_runtime_failure_code(code)
                        .map(AuthorityError::RuntimeFailure)
                        .unwrap_or(AuthorityError::ControlProtocol),
                );
            }
            Err(AuthorityError::ControlProtocol)
        }
    }
}

fn runtime_status(
    runtime: &Arc<Mutex<Option<QualifiedGraphicsRuntime>>>,
    endpoint_alive: bool,
    gpu_uuid: &str,
) -> AuthorityStatus {
    let guard = match runtime.lock() {
        Ok(guard) => guard,
        Err(_) => return AuthorityStatus::Degraded,
    };
    let Some(active) = guard.as_ref() else {
        return AuthorityStatus::Degraded;
    };
    if active.failed() {
        return AuthorityStatus::Degraded;
    }
    if active.suspended() {
        return AuthorityStatus::Suspended;
    }
    let identity = match resolve_nvidia_uuid_to_luid(gpu_uuid) {
        Ok(identity) => identity,
        Err(_) => return AuthorityStatus::Degraded,
    };
    if identity.luid != active.display_spec().adapter_luid {
        return AuthorityStatus::Degraded;
    }
    if active.media_ready() && endpoint_alive {
        AuthorityStatus::Ready
    } else {
        AuthorityStatus::Degraded
    }
}

fn stop_owned_runtime(
    runtime: &Arc<Mutex<Option<QualifiedGraphicsRuntime>>>,
) -> Result<(), ServiceRuntimeError> {
    let owned = {
        let mut guard = runtime.lock().map_err(|_| ServiceRuntimeError::WorkerProtocol)?;
        guard.take()
    };
    match owned {
        Some(runtime) => runtime.stop(),
        None => Ok(()),
    }
}

pub fn run_authority_child(
    session_id: &str,
    workspace: &str,
    gpu_uuid: &str,
) -> Result<(), AuthorityError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (session_id, workspace, gpu_uuid);
        return Err(AuthorityError::WindowsRequired);
    }
    #[cfg(target_os = "windows")]
    {
        if env::var(AUTHORITY_CHILD_ENV).ok().as_deref() != Some("1") {
            return Err(AuthorityError::ControlProtocol);
        }
        if workspace != "cloud-desktop" {
            return Err(AuthorityError::UnsupportedWorkspace);
        }

        let owner_sid = current_process_user_sid().map_err(|_| AuthorityError::ControlPipe)?;
        // FIRST_PIPE_INSTANCE is the single-authority lock for this GPUbnb session.
        let control = create_authority_pipe(session_id, &owner_sid)
            .map_err(|_| AuthorityError::AlreadyRunning)?;

        let lease = verified_lease(gpu_uuid)?;
        let (generation, display_nonce) = random_runtime_identity()?;
        let runtime = start_qualified_graphics_runtime(runtime_config(
            session_id,
            gpu_uuid,
            &lease,
            generation,
            display_nonce,
        ))
        .map_err(|_| AuthorityError::RuntimeStart)?;

        let server = QualificationMediaServer::bind(session_id, generation)
            .map_err(|_| AuthorityError::MediaBind)?;
        let endpoint = server.endpoint().map_err(|_| AuthorityError::MediaBind)?;
        if runtime.media_token().is_none() {
            return Err(AuthorityError::MediaProof);
        }

        let runtime = Arc::new(Mutex::new(Some(runtime)));
        let endpoint_alive = Arc::new(AtomicBool::new(true));
        let media_runtime = Arc::clone(&runtime);
        let media_alive = Arc::clone(&endpoint_alive);
        let mut media_thread = Some(thread::spawn(move || {
            let result = server.serve_interactive_shared(&media_runtime, &media_alive);
            media_alive.store(false, Ordering::SeqCst);
            result
        }));

        let mut start_reported = false;
        loop {
            control
                .accept_verified_user_client(&owner_sid, u32::MAX)
                .map_err(|_| AuthorityError::ControlPipe)?;
            let request = control
                .read_frame(10_000)
                .map_err(|_| AuthorityError::ControlPipe)?;
            let request =
                std::str::from_utf8(&request).map_err(|_| AuthorityError::ControlProtocol)?;

            let mut exit_after_response = false;
            let response = match request {
                "START" if !start_reported => {
                    let media_token = runtime
                        .lock()
                        .map_err(|_| AuthorityError::ControlPipe)?
                        .as_ref()
                        .and_then(QualifiedGraphicsRuntime::media_token)
                        .map(str::to_owned)
                        .ok_or(AuthorityError::MediaProof)?;
                    start_reported = true;
                    format!("READY|{generation}|{}|{media_token}", endpoint.port())
                }
                "START" => "ERR|already_running".to_owned(),
                "STATUS" => {
                    match runtime_status(&runtime, endpoint_alive.load(Ordering::SeqCst), gpu_uuid)
                    {
                        AuthorityStatus::Ready => "STATUS|ready".to_owned(),
                        AuthorityStatus::Suspended => "STATUS|suspended".to_owned(),
                        AuthorityStatus::Degraded => "STATUS|degraded".to_owned(),
                    }
                }
                "SUSPEND" => {
                    let mut guard = runtime.lock().map_err(|_| AuthorityError::ControlPipe)?;
                    let active = guard.as_mut().ok_or(AuthorityError::NotRunning)?;
                    match active.suspend_media() {
                        Ok(()) => "OK|suspended".to_owned(),
                        Err(error) => {
                            let code = active
                                .failure_code()
                                .unwrap_or_else(|| error.diagnostic_code());
                            format!("ERR|degraded|{code}")
                        }
                    }
                }
                "RESUME" => {
                    if !endpoint_alive.load(Ordering::SeqCst) {
                        "ERR|media_endpoint_lost".to_owned()
                    } else {
                        let mut guard = runtime.lock().map_err(|_| AuthorityError::ControlPipe)?;
                        let active = guard.as_mut().ok_or(AuthorityError::NotRunning)?;
                        if active.resume_after_fresh_proof().is_err() {
                            "ERR|degraded".to_owned()
                        } else if let Some(token) = active.media_token() {
                            format!("OK|resumed|{token}")
                        } else {
                            "ERR|degraded".to_owned()
                        }
                    }
                }
                "STOP" => {
                    endpoint_alive.store(false, Ordering::SeqCst);
                    exit_after_response = true;
                    let prior_failure = runtime
                        .lock()
                        .ok()
                        .and_then(|guard| guard.as_ref().and_then(QualifiedGraphicsRuntime::failure_code));
                    let runtime_stop = stop_owned_runtime(&runtime);
                    let media_stopped = media_thread
                        .take()
                        .is_some_and(|thread| matches!(thread.join(), Ok(Ok(()))));
                    if runtime_stop.is_ok() && media_stopped {
                        "OK|stopped".to_owned()
                    } else {
                        let code = runtime_stop
                            .err()
                            .map(ServiceRuntimeError::diagnostic_code)
                            .or(prior_failure)
                            .unwrap_or("worker_protocol");
                        format!("ERR|stop_failed|{code}")
                    }
                }
                _ => "ERR|protocol".to_owned(),
            };

            control
                .send_frame(response.as_bytes())
                .map_err(|_| AuthorityError::ControlPipe)?;
            control
                .disconnect_client()
                .map_err(|_| AuthorityError::ControlPipe)?;
            if exit_after_response {
                return if response == "OK|stopped" {
                    Ok(())
                } else {
                    Err(AuthorityError::Stop)
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_runtime_failure_codes_reject_unstructured_text() {
        assert_eq!(
            bounded_runtime_failure_code("media_transport"),
            Some("media_transport")
        );
        assert_eq!(
            bounded_runtime_failure_code("renter_session"),
            Some("renter_session")
        );
        assert_eq!(bounded_runtime_failure_code("media_transport:token"), None);
        assert_eq!(bounded_runtime_failure_code(""), None);
    }

    #[test]
    fn ready_response_is_strict() {
        let value =
            "READY|42|54321|0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let parsed = parse_ready(value).expect("ready");
        assert_eq!(parsed.generation, 42);
        assert_eq!(parsed.media_port, 54321);
        assert_eq!(parsed.media_token.len(), 64);
        assert!(parse_ready("READY|0|54321|bad").is_err());
        assert!(parse_ready("READY|42|0|0123").is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn physical_operations_fail_closed_off_windows() {
        assert_eq!(run_self_test(), Err(AuthorityError::WindowsRequired));
        assert_eq!(
            start_session(
                "sess-1",
                "cloud-desktop",
                "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
            ),
            Err(AuthorityError::WindowsRequired)
        );
    }
}
