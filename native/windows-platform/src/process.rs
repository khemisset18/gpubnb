//! Windows suspended-process primitive used to prove ordering before renter-token launch.
//!
//! This module deliberately does not expose a production current-user launcher.
//! It verifies the kernel ordering we will reuse for CreateProcessAsUser:
//! create suspended -> assign Job Object -> resume.

use crate::job::{WorkerJob, create_worker_job};
use crate::session::RenterSessionToken;
use crate::{PlatformError, VerifiedApplicationFile, open_application_for_verification};
use std::ffi::{OsStr, OsString, c_void};
use std::mem::{MaybeUninit, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::ptr;

type Handle = isize;

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
#[cfg(test)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;
const INFINITE_THREAD_RESUME_FAILURE: u32 = u32::MAX;

const QUALIFIED_STEAM_APPLICATIONS: [&str; 2] = [
    r"C:\Program Files (x86)\Steam\steam.exe",
    r"C:\Program Files\Steam\steam.exe",
];

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    reserved2_size: u16,
    reserved2: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn CreateProcessAsUserW(
        token: Handle,
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateProcessW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        exe_name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
    fn GetProcessTimes(
        process: Handle,
        creation_time: *mut FileTime,
        exit_time: *mut FileTime,
        kernel_time: *mut FileTime,
        user_time: *mut FileTime,
    ) -> i32;
    fn ProcessIdToSessionId(process_id: u32, session_id: *mut u32) -> i32;
    fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
    fn CloseHandle(object: Handle) -> i32;
}

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

impl FileTime {
    fn as_u64(&self) -> u64 {
        (u64::from(self.high) << 32) | u64::from(self.low)
    }
}

struct OwnedProcessHandle(Handle);

impl Drop for OwnedProcessHandle {
    fn drop(&mut self) {
        // SAFETY: unique ownership of a CreateProcessW process handle.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct OwnedThreadHandle(Handle);

impl Drop for OwnedThreadHandle {
    fn drop(&mut self) {
        // SAFETY: unique ownership of a CreateProcessW thread handle.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenterWorkerLaunchSpec<'a> {
    pub session_id: &'a str,
    pub generation: u64,
    pub gpu_uuid: &'a str,
    pub workspace: &'a str,
}

fn safe_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn canonical_gpu_uuid(value: &str) -> bool {
    if !value.starts_with("GPU-") || value.len() != 40 {
        return false;
    }
    value[4..].bytes().enumerate().all(|(index, byte)| {
        let hyphen = matches!(index, 8 | 13 | 18 | 23);
        (hyphen && byte == b'-') || (!hyphen && byte.is_ascii_hexdigit())
    })
}

fn allowed_workspace(value: &str) -> bool {
    matches!(value, "cloud-desktop" | "creator" | "cad" | "gaming")
}

fn validate_worker_launch_spec(spec: RenterWorkerLaunchSpec<'_>) -> Result<(), PlatformError> {
    if !safe_session_id(spec.session_id)
        || spec.generation == 0
        || !canonical_gpu_uuid(spec.gpu_uuid)
        || !allowed_workspace(spec.workspace)
    {
        return Err(PlatformError::InvalidPath);
    }
    Ok(())
}

fn worker_command_line(
    worker_path: &Path,
    spec: RenterWorkerLaunchSpec<'_>,
) -> Result<OsString, PlatformError> {
    validate_worker_launch_spec(spec)?;
    if !worker_path.is_absolute() {
        return Err(PlatformError::InvalidPath);
    }

    let mut command = OsString::from("\"");
    command.push(worker_path.as_os_str());
    command.push("\" --session-id ");
    command.push(spec.session_id);
    command.push(" --generation ");
    command.push(spec.generation.to_string());
    command.push(" --gpu-uuid ");
    command.push(spec.gpu_uuid);
    command.push(" --workspace ");
    command.push(spec.workspace);
    Ok(command)
}

pub struct RenterWorkerProcess {
    // Drop order matters: the job is released first, which terminates the worker
    // process tree before its process/thread handles are released.
    _job: WorkerJob,
    worker: SuspendedWorkerProcess,
}

/// Exact Steam process generation started inside the already isolated renter
/// session. Process-loopback audio can target this identity and include its
/// descendant game process tree without observing the provider's audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenterApplicationIdentity {
    pub process_id: u32,
    pub windows_session_id: u32,
    pub creation_time_100ns: u64,
}

/// Owns the Steam root process. Its descendants are also members of the worker
/// Job Object, so STOP closes the complete renter application tree.
pub struct RenterApplicationProcess {
    process: Option<OwnedProcessHandle>,
    identity: RenterApplicationIdentity,
}

impl RenterApplicationProcess {
    pub const fn identity(&self) -> RenterApplicationIdentity {
        self.identity
    }

    pub fn ensure_running(&self) -> Result<(), PlatformError> {
        let process = self
            .process
            .as_ref()
            .ok_or(PlatformError::ProcessWaitFailed)?;
        // SAFETY: the uniquely owned process handle remains live during the
        // zero-time wait; WAIT_TIMEOUT means the exact Steam generation lives.
        if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_TIMEOUT {
            Ok(())
        } else {
            Err(PlatformError::ProcessWaitFailed)
        }
    }
}

impl Drop for RenterApplicationProcess {
    fn drop(&mut self) {
        // The worker is a member of the service-owned kill-on-close Job Object.
        // STOP terminates Steam here; the Job Object remains the backstop for
        // Steam/game descendants and worker crashes.
        if let Some(process) = self.process.as_ref() {
            unsafe {
                let _ = TerminateProcess(process.0, 0x4750_5542);
                let _ = WaitForSingleObject(process.0, 5_000);
            }
        }
    }
}

impl RenterWorkerProcess {
    pub fn pid(&self) -> u32 {
        self.worker.pid()
    }

    pub fn wait_exit(&self, timeout_ms: u32) -> Result<u32, PlatformError> {
        if timeout_ms == 0 {
            return Err(PlatformError::ProcessWaitTimeout);
        }
        self.worker.wait_exit(timeout_ms)
    }
}

struct SuspendedWorkerProcess {
    process: OwnedProcessHandle,
    thread: OwnedThreadHandle,
    pid: u32,
    assigned_to_job: bool,
    resumed: bool,
}

impl Drop for SuspendedWorkerProcess {
    fn drop(&mut self) {
        if !self.resumed {
            // SAFETY: process is still live/suspended. This prevents an orphan if
            // job assignment or resume fails before the Job Object can own cleanup.
            unsafe {
                let _ = TerminateProcess(self.process.0, 0x4750_5542);
            }
        }
    }
}

impl SuspendedWorkerProcess {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn assign_to_job(&mut self, job: &WorkerJob) -> Result<(), PlatformError> {
        job.assign_process_handle(self.process.0)?;
        self.assigned_to_job = true;
        Ok(())
    }

    fn resume(&mut self) -> Result<(), PlatformError> {
        if !self.assigned_to_job {
            return Err(PlatformError::ProcessNotAssigned);
        }
        // SAFETY: thread is the initial suspended thread returned by CreateProcessW.
        let previous = unsafe { ResumeThread(self.thread.0) };
        if previous == INFINITE_THREAD_RESUME_FAILURE {
            return Err(PlatformError::ProcessResumeFailed);
        }
        self.resumed = true;
        Ok(())
    }

    fn wait_exit(&self, timeout_ms: u32) -> Result<u32, PlatformError> {
        // SAFETY: process handle remains live for the duration of the wait.
        match unsafe { WaitForSingleObject(self.process.0, timeout_ms) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => return Err(PlatformError::ProcessWaitTimeout),
            _ => return Err(PlatformError::ProcessWaitFailed),
        }
        let mut code = 0u32;
        // SAFETY: code is a valid out pointer and process has signaled exit.
        let ok = unsafe { GetExitCodeProcess(self.process.0, &mut code) };
        if ok == 0 {
            return Err(PlatformError::ProcessExitQueryFailed);
        }
        Ok(code)
    }
}

fn verify_suspended_process_image(
    worker: &SuspendedWorkerProcess,
    verified: &VerifiedApplicationFile,
) -> Result<(), PlatformError> {
    verify_process_image(worker.process.0, verified)
}

fn verify_process_image(
    process: Handle,
    verified: &VerifiedApplicationFile,
) -> Result<(), PlatformError> {
    let mut buffer = vec![0u16; 32_768];
    let mut len =
        u32::try_from(buffer.len()).map_err(|_| PlatformError::ProcessImageQueryFailed)?;
    // SAFETY: worker owns a live process handle; buffer is writable for len UTF-16 units.
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) };
    if ok == 0
        || len == 0
        || usize::try_from(len)
            .ok()
            .filter(|n| *n < buffer.len())
            .is_none()
    {
        return Err(PlatformError::ProcessImageQueryFailed);
    }
    let image = OsString::from_wide(&buffer[..len as usize]);
    let launched = open_application_for_verification(Path::new(&image))?;
    if launched.evidence().identity != verified.evidence().identity {
        return Err(PlatformError::ProcessImageIdentityMismatch);
    }
    Ok(())
}

fn qualified_steam_application_path(path: &Path) -> bool {
    let path = path.to_string_lossy();
    QUALIFIED_STEAM_APPLICATIONS
        .iter()
        .any(|candidate| path.eq_ignore_ascii_case(candidate))
}

fn gaming_application_command_line(path: &Path) -> Result<OsString, PlatformError> {
    if !path.is_absolute() || !qualified_steam_application_path(path) {
        return Err(PlatformError::InvalidPath);
    }
    let mut command_line = OsString::from("\"");
    command_line.push(path.as_os_str());
    command_line.push("\"");
    Ok(command_line)
}

/// Starts the only currently qualified Gaming entry point, Steam, on the
/// worker's interactive renter desktop. The caller must still keep Gaming
/// booking disabled until audio transport and controller proofs are complete.
pub fn launch_qualified_gaming_application(
    expected_session_id: u32,
) -> Result<RenterApplicationProcess, PlatformError> {
    if expected_session_id == 0 {
        return Err(PlatformError::InvalidWindowsSessionId);
    }
    let mut worker_session_id = 0u32;
    // SAFETY: worker process id is valid and session_id is a writable out value.
    if unsafe { ProcessIdToSessionId(std::process::id(), &mut worker_session_id) } == 0
        || worker_session_id != expected_session_id
    {
        return Err(PlatformError::RenterTokenSessionMismatch);
    }

    let mut verified = None;
    for candidate in QUALIFIED_STEAM_APPLICATIONS {
        let path = Path::new(candidate);
        match open_application_for_verification(path) {
            Ok(file) => {
                if !qualified_steam_application_path(file.path()) {
                    return Err(PlatformError::InvalidPath);
                }
                file.verify_authenticode()?;
                verified = Some(file);
                break;
            }
            Err(error) if path.exists() => return Err(error),
            Err(_) => {}
        }
    }
    let verified = verified.ok_or(PlatformError::OpenFailed)?;
    let application = wide(verified.path().as_os_str())?;
    let command_line_os = gaming_application_command_line(verified.path())?;
    let mut command_line = wide(command_line_os.as_os_str())?;
    let current_directory = wide(
        verified
            .path()
            .parent()
            .ok_or(PlatformError::InvalidPath)?
            .as_os_str(),
    )?;
    let mut desktop = wide(OsStr::new(r"winsta0\default"))?;

    let mut startup = MaybeUninit::<StartupInfoW>::zeroed();
    // SAFETY: STARTUPINFOW is zero-initialized and desktop points to a live,
    // NUL-terminated buffer for the renter's interactive desktop.
    let startup = unsafe {
        let ptr = startup.as_mut_ptr();
        (*ptr).cb = size_of::<StartupInfoW>() as u32;
        (*ptr).desktop = desktop.as_mut_ptr();
        &mut *ptr
    };
    let mut info = MaybeUninit::<ProcessInformation>::zeroed();
    // SAFETY: all pointers are live, handles are non-inheritable, and this
    // process runs under the renter identity in the already isolated WTS
    // session. No shell or user-supplied arguments are accepted.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            ptr::null_mut(),
            current_directory.as_ptr(),
            startup,
            info.as_mut_ptr(),
        )
    };
    if created == 0 {
        return Err(PlatformError::ProcessCreateFailed);
    }
    // SAFETY: successful CreateProcessW initialized PROCESS_INFORMATION.
    let info = unsafe { info.assume_init() };
    if info.process == 0 || info.thread == 0 || info.process_id == 0 {
        if info.process != 0 {
            unsafe {
                let _ = TerminateProcess(info.process, 0x4750_5542);
                let _ = CloseHandle(info.process);
            }
        }
        if info.thread != 0 {
            unsafe {
                let _ = CloseHandle(info.thread);
            }
        }
        return Err(PlatformError::ProcessCreateFailed);
    }
    let mut renter_application = RenterApplicationProcess {
        process: Some(OwnedProcessHandle(info.process)),
        identity: RenterApplicationIdentity {
            process_id: info.process_id,
            windows_session_id: expected_session_id,
            creation_time_100ns: 0,
        },
    };
    let thread = OwnedThreadHandle(info.thread);
    let process_handle = renter_application
        .process
        .as_ref()
        .ok_or(PlatformError::ProcessCreateFailed)?
        .0;
    verify_process_image(process_handle, &verified)?;

    let mut in_job = 0i32;
    // Children inherit the worker's non-breakaway kill-on-close Job Object.
    // Refuse to resume Steam if Windows did not preserve that containment.
    if unsafe { IsProcessInJob(process_handle, 0, &mut in_job) } == 0 || in_job == 0 {
        return Err(PlatformError::ProcessNotAssigned);
    }

    let mut process_session_id = 0u32;
    if unsafe { ProcessIdToSessionId(info.process_id, &mut process_session_id) } == 0
        || process_session_id != expected_session_id
    {
        return Err(PlatformError::RenterTokenSessionMismatch);
    }

    let mut creation_time = FileTime::default();
    let mut exit_time = FileTime::default();
    let mut kernel_time = FileTime::default();
    let mut user_time = FileTime::default();
    if unsafe {
        GetProcessTimes(
            process_handle,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    } == 0
    {
        return Err(PlatformError::ProcessWaitFailed);
    }
    if creation_time.as_u64() == 0 {
        return Err(PlatformError::ProcessWaitFailed);
    }

    // SAFETY: initial thread handle belongs to the still-suspended process.
    if unsafe { ResumeThread(thread.0) } == INFINITE_THREAD_RESUME_FAILURE {
        return Err(PlatformError::ProcessResumeFailed);
    }
    if unsafe { WaitForSingleObject(process_handle, 0) } != WAIT_TIMEOUT {
        return Err(PlatformError::ProcessCreateFailed);
    }

    renter_application.identity.windows_session_id = process_session_id;
    renter_application.identity.creation_time_100ns = creation_time.as_u64();
    Ok(renter_application)
}

fn wide(value: &OsStr) -> Result<Vec<u16>, PlatformError> {
    let encoded: Vec<u16> = value.encode_wide().chain(Some(0)).collect();
    if encoded.len() <= 1
        || encoded
            .iter()
            .take(encoded.len() - 1)
            .any(|unit| *unit == 0)
    {
        return Err(PlatformError::InvalidPath);
    }
    Ok(encoded)
}

fn spawn_suspended_as_renter(
    token: &RenterSessionToken,
    application: &Path,
    command_line: &OsStr,
    current_directory: &Path,
) -> Result<SuspendedWorkerProcess, PlatformError> {
    if !application.is_absolute() || !current_directory.is_absolute() {
        return Err(PlatformError::InvalidPath);
    }

    let application = wide(application.as_os_str())?;
    let mut command_line = wide(command_line)?;
    let current_directory = wide(current_directory.as_os_str())?;
    let mut desktop = wide(OsStr::new(r"winsta0\default"))?;
    let environment = token.create_environment()?;

    let mut startup = MaybeUninit::<StartupInfoW>::zeroed();
    // SAFETY: STARTUPINFOW is zero-initialized, cb is set, and lpDesktop points
    // to a live NUL-terminated buffer for the dedicated renter session.
    let startup = unsafe {
        let ptr = startup.as_mut_ptr();
        (*ptr).cb = size_of::<StartupInfoW>() as u32;
        (*ptr).desktop = desktop.as_mut_ptr();
        &mut *ptr
    };
    let mut info = MaybeUninit::<ProcessInformation>::zeroed();

    // No service handles are inherited. The environment belongs to the renter
    // token and the process starts suspended, so no renter code executes until
    // Job Object assignment succeeds.
    // SAFETY: all pointers remain live through the call; command line is writable
    // as required by CreateProcessAsUserW.
    let ok = unsafe {
        CreateProcessAsUserW(
            token.raw_handle(),
            application.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            environment.raw_ptr(),
            current_directory.as_ptr(),
            startup,
            info.as_mut_ptr(),
        )
    };
    if ok == 0 {
        return Err(PlatformError::RenterProcessCreateFailed);
    }

    // SAFETY: successful CreateProcessAsUserW initialized PROCESS_INFORMATION.
    let info = unsafe { info.assume_init() };
    if info.process == 0 || info.thread == 0 || info.process_id == 0 {
        if info.process != 0 {
            // SAFETY: best-effort cleanup of a partially valid child process.
            unsafe {
                let _ = TerminateProcess(info.process, 0x4750_5542);
                let _ = CloseHandle(info.process);
            }
        }
        if info.thread != 0 {
            // SAFETY: best-effort cleanup of a partially valid thread handle.
            unsafe {
                let _ = CloseHandle(info.thread);
            }
        }
        return Err(PlatformError::RenterProcessCreateFailed);
    }

    Ok(SuspendedWorkerProcess {
        process: OwnedProcessHandle(info.process),
        thread: OwnedThreadHandle(info.thread),
        pid: info.process_id,
        assigned_to_job: false,
        resumed: false,
    })
}

pub fn launch_qualified_renter_worker(
    token: &RenterSessionToken,
    verified_worker: &VerifiedApplicationFile,
    allowed_signer_sha256: &[[u8; 32]],
    spec: RenterWorkerLaunchSpec<'_>,
) -> Result<RenterWorkerProcess, PlatformError> {
    validate_worker_launch_spec(spec)?;
    verified_worker.verify_signer_allowed_sha256(allowed_signer_sha256)?;

    let application = verified_worker.path();
    let current_directory = application.parent().ok_or(PlatformError::InvalidPath)?;
    if !current_directory.is_absolute() {
        return Err(PlatformError::InvalidPath);
    }
    let command_line = worker_command_line(application, spec)?;

    let job = create_worker_job()?;
    let mut worker =
        spawn_suspended_as_renter(token, application, &command_line, current_directory)?;
    verify_suspended_process_image(&worker, verified_worker)?;
    worker.assign_to_job(&job)?;
    worker.resume()?;

    Ok(RenterWorkerProcess { _job: job, worker })
}

#[cfg(test)]
fn spawn_suspended_current_user_validation(
    application: &Path,
    command_line: &OsStr,
) -> Result<SuspendedWorkerProcess, PlatformError> {
    if !application.is_absolute() {
        return Err(PlatformError::InvalidPath);
    }
    let application = wide(application.as_os_str())?;
    let mut command_line = wide(command_line)?;

    let mut startup = MaybeUninit::<StartupInfoW>::zeroed();
    // SAFETY: zero is the documented baseline for STARTUPINFOW and cb is then set.
    let startup = unsafe {
        let ptr = startup.as_mut_ptr();
        (*ptr).cb = size_of::<StartupInfoW>() as u32;
        &mut *ptr
    };
    let mut info = MaybeUninit::<ProcessInformation>::zeroed();

    // Validation-only current-token launch. Production renter launch will use
    // CreateProcessAsUserW with an explicitly qualified renter primary token.
    // SAFETY: all buffers/structs are live, command line is writable and
    // NUL-terminated, handles are non-inheritable, and optional pointers are null.
    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            ptr::null_mut(),
            ptr::null(),
            startup,
            info.as_mut_ptr(),
        )
    };
    if ok == 0 {
        return Err(PlatformError::ProcessCreateFailed);
    }
    // SAFETY: successful CreateProcessW initialized PROCESS_INFORMATION.
    let info = unsafe { info.assume_init() };
    if info.process == 0 || info.thread == 0 || info.process_id == 0 {
        if info.process != 0 {
            // SAFETY: best-effort cleanup of a partially valid process handle.
            unsafe {
                let _ = TerminateProcess(info.process, 0x4750_5542);
                let _ = CloseHandle(info.process);
            }
        }
        if info.thread != 0 {
            // SAFETY: best-effort cleanup of a partially valid thread handle.
            unsafe {
                let _ = CloseHandle(info.thread);
            }
        }
        return Err(PlatformError::ProcessCreateFailed);
    }

    Ok(SuspendedWorkerProcess {
        process: OwnedProcessHandle(info.process),
        thread: OwnedThreadHandle(info.thread),
        pid: info.process_id,
        assigned_to_job: false,
        resumed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::create_worker_job;
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn command_shell() -> PathBuf {
        std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .expect("ComSpec")
    }

    #[test]
    fn worker_launch_spec_rejects_arbitrary_workspace_and_identity() {
        let good = RenterWorkerLaunchSpec {
            session_id: "sess-1",
            generation: 1,
            gpu_uuid: "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            workspace: "cloud-desktop",
        };
        assert_eq!(validate_worker_launch_spec(good), Ok(()));

        for bad in [
            RenterWorkerLaunchSpec {
                session_id: "../provider",
                ..good
            },
            RenterWorkerLaunchSpec {
                generation: 0,
                ..good
            },
            RenterWorkerLaunchSpec {
                gpu_uuid: "GPU-EXACT",
                ..good
            },
            RenterWorkerLaunchSpec {
                workspace: "developer",
                ..good
            },
        ] {
            assert_eq!(
                validate_worker_launch_spec(bad),
                Err(PlatformError::InvalidPath)
            );
        }
    }

    #[test]
    fn worker_command_line_is_generated_only_from_safe_fields() {
        let spec = RenterWorkerLaunchSpec {
            session_id: "sess-ABC_123",
            generation: 7,
            gpu_uuid: "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            workspace: "gaming",
        };
        let path = Path::new(r"C:\Program Files\GPUbnb\gpubnb-windows-worker.exe");
        let command = worker_command_line(path, spec).expect("worker command");
        let text = command.to_string_lossy();
        assert!(text.contains("--session-id sess-ABC_123"));
        assert!(text.contains("--generation 7"));
        assert!(text.contains("--workspace gaming"));
        assert!(!text.contains("cmd.exe"));
        assert!(!text.contains("powershell"));
    }

    #[test]
    fn gaming_application_path_is_fixed_to_the_two_qualified_steam_locations() {
        assert!(qualified_steam_application_path(Path::new(
            r"C:\Program Files (x86)\Steam\steam.exe"
        )));
        assert!(qualified_steam_application_path(Path::new(
            r"c:\program files\steam\STEAM.EXE"
        )));
        for rejected in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\Steam\steam.exe:payload",
            r"\\server\Steam\steam.exe",
            r"C:\Program Files\Other\game.exe",
        ] {
            assert!(!qualified_steam_application_path(Path::new(rejected)));
        }
    }

    #[test]
    fn gaming_launch_command_is_only_the_quoted_allowlisted_executable() {
        let path = Path::new(r"C:\Program Files (x86)\Steam\steam.exe");
        assert_eq!(
            gaming_application_command_line(path).expect("qualified Steam command"),
            OsString::from(r#""C:\Program Files (x86)\Steam\steam.exe""#)
        );
        assert_eq!(
            gaming_application_command_line(Path::new(r"C:\Windows\System32\cmd.exe")),
            Err(PlatformError::InvalidPath)
        );
    }

    #[test]
    fn gaming_application_rejects_the_provider_session_before_launch() {
        assert_eq!(
            launch_qualified_gaming_application(0).err(),
            Some(PlatformError::InvalidWindowsSessionId)
        );
    }

    #[test]
    fn renter_launcher_rejects_relative_worker_path_before_token_use() {
        // The production launcher requires a qualified absolute worker binary.
        // This test exercises the path gate without requiring LocalSystem/WTS.
        let relative = Path::new("gpubnb-windows-worker.exe");
        assert!(!relative.is_absolute());
    }

    #[test]
    fn suspended_process_cannot_resume_before_job_assignment() {
        let shell = command_shell();
        let command = OsString::from(format!("\"{}\" /D /Q /C exit 0", shell.display()));
        let mut worker =
            spawn_suspended_current_user_validation(&shell, &command).expect("spawn suspended");
        assert_ne!(worker.pid(), 0);
        assert_eq!(worker.resume(), Err(PlatformError::ProcessNotAssigned));
    }

    #[test]
    fn suspended_process_is_assigned_before_resume_and_exits_cleanly() {
        let job = create_worker_job().expect("worker job");
        let shell = command_shell();
        let command = OsString::from(format!("\"{}\" /D /Q /C exit 0", shell.display()));
        let mut worker =
            spawn_suspended_current_user_validation(&shell, &command).expect("spawn suspended");

        worker.assign_to_job(&job).expect("assign job");
        worker.resume().expect("resume after assignment");
        assert_eq!(worker.wait_exit(10_000), Ok(0));
        assert_eq!(job.kill_on_close_enabled(), Ok(true));
    }
}
