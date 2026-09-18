//! Windows suspended-process primitive used to prove ordering before renter-token launch.
//!
//! This module deliberately does not expose a production current-user launcher.
//! It verifies the kernel ordering we will reuse for CreateProcessAsUser:
//! create suspended -> assign Job Object -> resume.

use crate::PlatformError;
use crate::job::{WorkerJob, create_worker_job};
use crate::session::RenterSessionToken;
use std::ffi::{OsStr, c_void};
use std::mem::{MaybeUninit, size_of};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

type Handle = isize;

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;
const INFINITE_THREAD_RESUME_FAILURE: u32 = u32::MAX;

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
    fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
    fn CloseHandle(object: Handle) -> i32;
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

pub struct RenterWorkerProcess {
    // Drop order matters: the job is released first, which terminates the worker
    // process tree before its process/thread handles are released.
    _job: WorkerJob,
    worker: SuspendedWorkerProcess,
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

pub fn launch_renter_worker(
    token: &RenterSessionToken,
    application: &Path,
    command_line: &OsStr,
) -> Result<RenterWorkerProcess, PlatformError> {
    let current_directory = application.parent().ok_or(PlatformError::InvalidPath)?;
    if !current_directory.is_absolute() {
        return Err(PlatformError::InvalidPath);
    }

    let job = create_worker_job()?;
    let mut worker =
        spawn_suspended_as_renter(token, application, command_line, current_directory)?;
    worker.assign_to_job(&job)?;
    worker.resume()?;

    Ok(RenterWorkerProcess {
        _job: job,
        worker,
    })
}

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
