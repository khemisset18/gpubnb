//! Secured local IPC boundary between the privileged GPUbnb service and renter worker.
//!
//! No Windows default pipe ACL is used. The caller supplies the exact service SID
//! and renter logon SID, which are validated as numeric SIDs before being embedded
//! into a protected DACL. Remote clients are rejected at the pipe layer.

use crate::PlatformError;

const MAX_SESSION_ID: usize = 128;
const MAX_SID_TEXT: usize = 184;
const RENTER_PIPE_ACCESS_MASK: u32 = 0x0012_019B;

fn safe_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn numeric_sid(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_SID_TEXT || !value.starts_with("S-1-") {
        return false;
    }
    let mut fields = 0usize;
    for component in value.split('-') {
        if component.is_empty() {
            return false;
        }
        if fields >= 2 && !component.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        fields += 1;
    }
    fields >= 4
}

fn pipe_name(session_id: &str, generation: u64) -> Result<String, PlatformError> {
    if !safe_session_id(session_id) || generation == 0 {
        return Err(PlatformError::InvalidSessionId);
    }
    Ok(format!(
        r"\\.\pipe\gpubnb-native-{session_id}-{generation}"
    ))
}

fn security_sddl(service_sid: &str, renter_logon_sid: &str) -> Result<String, PlatformError> {
    if !numeric_sid(service_sid) || !numeric_sid(renter_logon_sid) {
        return Err(PlatformError::InvalidSid);
    }

    // D:P = protected DACL: no inherited/default ACEs.
    // The service owns full control. The renter logon SID gets the exact
    // read/write/synchronize rights needed by the client, deliberately excluding
    // FILE_APPEND_DATA / FILE_CREATE_PIPE_INSTANCE (0x00000004).
    Ok(format!(
        "D:P(A;;GA;;;{service_sid})(A;;0x{RENTER_PIPE_ACCESS_MASK:08X};;;{renter_logon_sid})"
    ))
}

pub struct WorkerPipe {
    name: String,
    #[cfg(target_os = "windows")]
    _handle: windows_impl::OwnedPipeHandle,
}

impl WorkerPipe {
    pub fn name(&self) -> &str {
        &self.name
    }
}

pub fn create_worker_pipe(
    session_id: &str,
    generation: u64,
    service_sid: &str,
    renter_logon_sid: &str,
) -> Result<WorkerPipe, PlatformError> {
    let name = pipe_name(session_id, generation)?;
    let sddl = security_sddl(service_sid, renter_logon_sid)?;

    #[cfg(target_os = "windows")]
    {
        windows_impl::create_worker_pipe(name, &sddl)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = sddl;
        Err(PlatformError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
pub fn current_process_user_sid() -> Result<String, PlatformError> {
    windows_impl::current_process_sid(false)
}

#[cfg(not(target_os = "windows"))]
pub fn current_process_user_sid() -> Result<String, PlatformError> {
    Err(PlatformError::WindowsRequired)
}

#[cfg(target_os = "windows")]
pub fn current_process_logon_sid() -> Result<String, PlatformError> {
    windows_impl::current_process_sid(true)
}

#[cfg(not(target_os = "windows"))]
pub fn current_process_logon_sid() -> Result<String, PlatformError> {
    Err(PlatformError::WindowsRequired)
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::WorkerPipe;
    use crate::PlatformError;
    use std::ffi::{OsStr, c_void};
    use std::mem::{align_of, size_of};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type Handle = isize;

    const INVALID_HANDLE_VALUE: Handle = -1;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER_CLASS: u32 = 1;
    const TOKEN_GROUPS_CLASS: u32 = 2;
    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const PIPE_TYPE_MESSAGE: u32 = 0x0000_0004;
    const PIPE_READMODE_MESSAGE: u32 = 0x0000_0002;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
    const SDDL_REVISION_1: u32 = 1;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        security_descriptor: *mut c_void,
        inherit_handle: i32,
    }

    #[repr(C)]
    struct SidAndAttributes {
        sid: *mut c_void,
        attributes: u32,
    }

    #[repr(C)]
    struct TokenUser {
        user: SidAndAttributes,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_buffer_size: u32,
            in_buffer_size: u32,
            default_timeout_ms: u32,
            security_attributes: *mut SecurityAttributes,
        ) -> Handle;
        fn CloseHandle(object: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn GetLastError() -> u32;
        fn LocalFree(memory: Handle) -> Handle;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string_security_descriptor: *const u16,
            string_sd_revision: u32,
            security_descriptor: *mut *mut c_void,
            security_descriptor_size: *mut u32,
        ) -> i32;
        fn OpenProcessToken(
            process_handle: Handle,
            desired_access: u32,
            token_handle: *mut Handle,
        ) -> i32;
        fn GetTokenInformation(
            token_handle: Handle,
            token_information_class: u32,
            token_information: *mut c_void,
            token_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, string_sid: *mut *mut u16) -> i32;
    }

    pub(super) struct OwnedPipeHandle(Handle);

    impl Drop for OwnedPipeHandle {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns a live pipe handle.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct OwnedToken(Handle);

    impl Drop for OwnedToken {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns a live process-token handle.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct LocalSecurityDescriptor(*mut c_void);

    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: the pointer was allocated by LocalAlloc inside the SDDL
            // conversion routine and LocalFree is the documented release path.
            unsafe {
                let _ = LocalFree(self.0 as Handle);
            }
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
            return Err(PlatformError::InvalidSessionId);
        }
        Ok(encoded)
    }

    fn sid_to_string(sid: *mut c_void) -> Result<String, PlatformError> {
        if sid.is_null() {
            return Err(PlatformError::TokenQueryFailed);
        }
        let mut raw: *mut u16 = ptr::null_mut();
        // SAFETY: sid comes from a live token-information buffer and raw is an
        // out pointer documented by ConvertSidToStringSidW.
        let ok = unsafe { ConvertSidToStringSidW(sid, &mut raw) };
        if ok == 0 || raw.is_null() {
            return Err(PlatformError::TokenQueryFailed);
        }

        let mut len = 0usize;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated LocalAlloc
        // string. The scan stops at that terminator.
        unsafe {
            while *raw.add(len) != 0 {
                len += 1;
            }
        }
        // SAFETY: raw references len initialized UTF-16 code units.
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) })
            .map_err(|_| PlatformError::TokenQueryFailed);
        // SAFETY: raw was allocated by LocalAlloc.
        unsafe {
            let _ = LocalFree(raw as Handle);
        }
        text
    }

    fn open_current_token() -> Result<OwnedToken, PlatformError> {
        let mut raw = 0isize;
        // SAFETY: GetCurrentProcess returns a pseudo-handle valid for
        // OpenProcessToken and raw is a valid out pointer.
        let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) };
        if ok == 0 || raw == 0 {
            return Err(PlatformError::TokenQueryFailed);
        }
        Ok(OwnedToken(raw))
    }

    fn token_information(token: Handle, class: u32) -> Result<Vec<u8>, PlatformError> {
        let mut length = 0u32;
        // SAFETY: first call intentionally supplies a null output buffer to query
        // the required length.
        let first = unsafe {
            GetTokenInformation(token, class, ptr::null_mut(), 0, &mut length)
        };
        if first != 0 || length == 0 {
            return Err(PlatformError::TokenQueryFailed);
        }
        // SAFETY: GetLastError has no preconditions.
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(PlatformError::TokenQueryFailed);
        }

        let mut buffer = vec![0u8; length as usize];
        // SAFETY: buffer has exactly the requested capacity and remains live for
        // any SID pointers embedded inside the returned token structure.
        let ok = unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.as_mut_ptr().cast::<c_void>(),
                length,
                &mut length,
            )
        };
        if ok == 0 {
            return Err(PlatformError::TokenQueryFailed);
        }
        Ok(buffer)
    }

    pub(super) fn current_process_sid(logon_sid: bool) -> Result<String, PlatformError> {
        let token = open_current_token()?;
        if !logon_sid {
            let buffer = token_information(token.0, TOKEN_USER_CLASS)?;
            if buffer.len() < size_of::<TokenUser>() {
                return Err(PlatformError::TokenQueryFailed);
            }
            // SAFETY: GetTokenInformation(TokenUser) populated at least one
            // complete TokenUser in the aligned Vec allocation.
            let user = unsafe { &*(buffer.as_ptr().cast::<TokenUser>()) };
            return sid_to_string(user.user.sid);
        }

        let buffer = token_information(token.0, TOKEN_GROUPS_CLASS)?;
        if buffer.len() < size_of::<u32>() {
            return Err(PlatformError::TokenQueryFailed);
        }
        // SAFETY: TokenGroups begins with a DWORD group count.
        let count = unsafe { *(buffer.as_ptr().cast::<u32>()) as usize };
        let header = (size_of::<u32>() + align_of::<SidAndAttributes>() - 1)
            & !(align_of::<SidAndAttributes>() - 1);
        let bytes_needed = header
            .checked_add(
                count
                    .checked_mul(size_of::<SidAndAttributes>())
                    .ok_or(PlatformError::TokenQueryFailed)?,
            )
            .ok_or(PlatformError::TokenQueryFailed)?;
        if bytes_needed > buffer.len() {
            return Err(PlatformError::TokenQueryFailed);
        }
        // SAFETY: header is aligned for SidAndAttributes and bounds were checked
        // against the returned token-information buffer.
        let groups = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr().add(header).cast::<SidAndAttributes>(),
                count,
            )
        };
        let logon = groups
            .iter()
            .find(|group| group.attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
            .ok_or(PlatformError::TokenQueryFailed)?;
        sid_to_string(logon.sid)
    }

    fn security_descriptor(sddl: &str) -> Result<LocalSecurityDescriptor, PlatformError> {
        let wide_sddl = wide(OsStr::new(sddl)).map_err(|_| PlatformError::InvalidSid)?;
        let mut descriptor = ptr::null_mut();
        // SAFETY: wide_sddl is NUL-terminated and descriptor is a valid out
        // pointer. Windows allocates the returned descriptor with LocalAlloc.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide_sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 || descriptor.is_null() {
            return Err(PlatformError::SecurityDescriptorFailed);
        }
        Ok(LocalSecurityDescriptor(descriptor))
    }

    pub(super) fn create_worker_pipe(
        name: String,
        sddl: &str,
    ) -> Result<WorkerPipe, PlatformError> {
        let wide_name = wide(OsStr::new(&name))?;
        let descriptor = security_descriptor(sddl)?;
        let mut attributes = SecurityAttributes {
            length: size_of::<SecurityAttributes>() as u32,
            security_descriptor: descriptor.0,
            inherit_handle: 0,
        };

        // SAFETY: name and security descriptor remain live through the call.
        // FIRST_PIPE_INSTANCE + max_instances=1 prevent a competing local server
        // from creating another instance with the same session/generation name.
        let raw = unsafe {
            CreateNamedPipeW(
                wide_name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                64 * 1024,
                64 * 1024,
                5_000,
                &mut attributes,
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(PlatformError::PipeCreateFailed);
        }
        Ok(WorkerPipe {
            name,
            _handle: OwnedPipeHandle(raw),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_and_sid_inputs_are_injection_safe() {
        assert!(safe_session_id("sess-ABC_123"));
        assert!(!safe_session_id("../provider"));
        assert!(!safe_session_id("bad\\pipe"));

        assert!(numeric_sid("S-1-5-18"));
        assert!(numeric_sid("S-1-5-5-123-456"));
        assert!(!numeric_sid("SY"));
        assert!(!numeric_sid("S-1-5-18)(A;;GA;;;WD"));
    }

    #[test]
    fn renter_acl_excludes_create_pipe_instance() {
        assert_eq!(RENTER_PIPE_ACCESS_MASK & 0x0000_0004, 0);
        let sddl = security_sddl("S-1-5-18", "S-1-5-5-123-456").expect("safe SDDL");
        assert!(sddl.starts_with("D:P"));
        assert!(!sddl.contains("WD"));
        assert!(!sddl.contains("AN"));
    }

    #[test]
    fn pipe_name_is_session_and_generation_fenced() {
        assert_eq!(
            pipe_name("sess-1", 7).expect("valid pipe name"),
            r"\\.\pipe\gpubnb-native-sess-1-7"
        );
        assert_eq!(
            pipe_name("sess-1", 0),
            Err(PlatformError::InvalidSessionId)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_creates_local_pipe_with_explicit_current_token_sids() {
        let service_sid = current_process_user_sid().expect("current user SID");
        let logon_sid = current_process_logon_sid().expect("current logon SID");
        let pipe = create_worker_pipe(
            "ci-secure-pipe",
            std::process::id() as u64,
            &service_sid,
            &logon_sid,
        )
        .expect("secure pipe");
        assert!(pipe.name().starts_with(r"\\.\pipe\gpubnb-native-"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_pipe_creation_fails_closed() {
        assert_eq!(
            create_worker_pipe("sess-1", 1, "S-1-5-18", "S-1-5-5-123-456").err(),
            Some(PlatformError::WindowsRequired)
        );
    }
}
