//! Windows Job Object boundary for the renter worker process tree.
//!
//! The worker job is anonymous and non-inheritable. Closing the final job handle
//! must terminate every process associated with it, which gives GPUbnb a kernel-
//! enforced cleanup backstop in addition to normal graceful shutdown.

use crate::PlatformError;

pub struct WorkerJob {
    #[cfg(target_os = "windows")]
    _handle: windows_impl::OwnedJobHandle,
}

impl WorkerJob {
    #[cfg(target_os = "windows")]
    pub(crate) fn assign_process_handle(&self, process_handle: isize) -> Result<(), PlatformError> {
        windows_impl::assign_process(&self._handle, process_handle)
    }

    pub fn kill_on_close_enabled(&self) -> Result<bool, PlatformError> {
        #[cfg(target_os = "windows")]
        {
            windows_impl::kill_on_close_enabled(&self._handle)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError::WindowsRequired)
        }
    }
}

pub fn create_worker_job() -> Result<WorkerJob, PlatformError> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::create_worker_job()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(PlatformError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::WorkerJob;
    use crate::PlatformError;
    use std::ffi::c_void;
    use std::mem::{MaybeUninit, size_of};
    use std::ptr;

    type Handle = isize;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(job_attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            information_class: i32,
            information: *mut c_void,
            information_length: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            information_class: i32,
            information: *mut c_void,
            information_length: u32,
            return_length: *mut u32,
        ) -> i32;
        fn CloseHandle(object: Handle) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    }

    pub(super) struct OwnedJobHandle(Handle);

    impl Drop for OwnedJobHandle {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns a valid job handle. The configured
            // KILL_ON_JOB_CLOSE limit makes this the final cleanup backstop.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(super) fn create_worker_job() -> Result<WorkerJob, PlatformError> {
        // Anonymous job: no global name to pre-create/hijack. A null
        // SECURITY_ATTRIBUTES pointer also makes the returned handle non-inheritable.
        // SAFETY: both optional pointers are null as documented.
        let raw = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
        if raw == 0 {
            return Err(PlatformError::JobCreateFailed);
        }
        let handle = OwnedJobHandle(raw);

        let mut limits = JobObjectExtendedLimitInformation::default();
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: limits is a live structure of the exact information-class size.
        let ok = unsafe {
            SetInformationJobObject(
                handle.0,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&mut limits as *mut JobObjectExtendedLimitInformation).cast::<c_void>(),
                size_of::<JobObjectExtendedLimitInformation>() as u32,
            )
        };
        if ok == 0 {
            return Err(PlatformError::JobConfigureFailed);
        }

        let worker_job = WorkerJob { _handle: handle };
        if !kill_on_close_enabled(&worker_job._handle)? {
            return Err(PlatformError::JobConfigureFailed);
        }
        Ok(worker_job)
    }

    pub(super) fn assign_process(
        handle: &OwnedJobHandle,
        process_handle: Handle,
    ) -> Result<(), PlatformError> {
        if process_handle == 0 {
            return Err(PlatformError::JobAssignFailed);
        }
        // SAFETY: both handles are owned/live at the call site. The process is
        // created suspended so no renter code runs before this assignment.
        let ok = unsafe { AssignProcessToJobObject(handle.0, process_handle) };
        if ok == 0 {
            return Err(PlatformError::JobAssignFailed);
        }
        Ok(())
    }

    pub(super) fn kill_on_close_enabled(handle: &OwnedJobHandle) -> Result<bool, PlatformError> {
        let mut limits = MaybeUninit::<JobObjectExtendedLimitInformation>::zeroed();
        let mut returned = 0u32;
        // SAFETY: limits points to writable storage matching the requested class.
        let ok = unsafe {
            QueryInformationJobObject(
                handle.0,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                limits.as_mut_ptr().cast::<c_void>(),
                size_of::<JobObjectExtendedLimitInformation>() as u32,
                &mut returned,
            )
        };
        if ok == 0 || returned as usize != size_of::<JobObjectExtendedLimitInformation>() {
            return Err(PlatformError::JobQueryFailed);
        }
        // SAFETY: successful QueryInformationJobObject initialized the structure.
        let limits = unsafe { limits.assume_init() };
        Ok(
            limits.basic_limit_information.limit_flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_job_enforces_kill_on_close() {
        let job = create_worker_job().expect("create worker job");
        assert_eq!(job.kill_on_close_enabled(), Ok(true));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_job_fails_closed() {
        assert_eq!(
            create_worker_job().err(),
            Some(PlatformError::WindowsRequired)
        );
    }
}
