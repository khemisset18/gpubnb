//! Secured local IPC boundary between the privileged GPUbnb service and renter worker.
//!
//! No Windows default pipe ACL is used. The caller supplies the exact service SID
//! and renter logon SID, which are validated as numeric SIDs before being embedded
//! into a protected DACL. Remote clients are rejected at the pipe layer.

use crate::PlatformError;

const MAX_SESSION_ID: usize = 128;
const MAX_SID_TEXT: usize = 184;
const RENTER_PIPE_ACCESS_MASK: u32 = 0x0012_019B;
#[cfg(target_os = "windows")]
const PIPE_AUTH_PRELUDE: u8 = 0x47;
pub const WORKER_PIPE_FRAME_MAX: usize = 512;
#[cfg(target_os = "windows")]
const WORKER_PIPE_PACKET_SIZE: usize = WORKER_PIPE_FRAME_MAX + 2;

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
    Ok(format!(r"\\.\pipe\gpubnb-native-{session_id}-{generation}"))
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

pub struct WorkerPipeClient {
    name: String,
    #[cfg(target_os = "windows")]
    _handle: windows_impl::OwnedClientHandle,
}

impl WorkerPipeClient {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn send_frame(&self, frame: &[u8]) -> Result<(), PlatformError> {
        if frame.len() > WORKER_PIPE_FRAME_MAX {
            return Err(PlatformError::PipeProtocolFailed);
        }
        #[cfg(target_os = "windows")]
        {
            windows_impl::send_client_frame(&self._handle, frame)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError::WindowsRequired)
        }
    }

    pub fn read_frame(&self, timeout_ms: u32) -> Result<Vec<u8>, PlatformError> {
        if timeout_ms == 0 {
            return Err(PlatformError::PipeConnectTimeout);
        }
        #[cfg(target_os = "windows")]
        {
            windows_impl::read_client_frame(&self._handle, timeout_ms)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = timeout_ms;
            Err(PlatformError::WindowsRequired)
        }
    }
}

pub struct WorkerPipe {
    name: String,
    #[cfg(target_os = "windows")]
    _handle: windows_impl::OwnedPipeHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPipeClient {
    pub process_id: u32,
    pub logon_sid: String,
}

impl WorkerPipe {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn send_frame(&self, frame: &[u8]) -> Result<(), PlatformError> {
        if frame.len() > WORKER_PIPE_FRAME_MAX {
            return Err(PlatformError::PipeProtocolFailed);
        }
        #[cfg(target_os = "windows")]
        {
            windows_impl::send_server_frame(&self._handle, frame)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError::WindowsRequired)
        }
    }

    pub fn read_frame(&self, timeout_ms: u32) -> Result<Vec<u8>, PlatformError> {
        if timeout_ms == 0 {
            return Err(PlatformError::PipeConnectTimeout);
        }
        #[cfg(target_os = "windows")]
        {
            windows_impl::read_frame(&self._handle, timeout_ms)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = timeout_ms;
            Err(PlatformError::WindowsRequired)
        }
    }

    pub fn accept_verified_client(
        &self,
        expected_logon_sid: &str,
        expected_process_id: u32,
        timeout_ms: u32,
    ) -> Result<VerifiedPipeClient, PlatformError> {
        if !numeric_sid(expected_logon_sid) || timeout_ms == 0 {
            return Err(PlatformError::InvalidSid);
        }
        if expected_process_id == 0 {
            return Err(PlatformError::PipeClientPidMismatch);
        }
        #[cfg(target_os = "windows")]
        {
            windows_impl::accept_verified_client(
                &self._handle,
                expected_logon_sid,
                expected_process_id,
                timeout_ms,
            )
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (expected_process_id, timeout_ms);
            Err(PlatformError::WindowsRequired)
        }
    }
}

pub fn connect_worker_pipe_client(
    session_id: &str,
    generation: u64,
    timeout_ms: u32,
) -> Result<WorkerPipeClient, PlatformError> {
    let name = pipe_name(session_id, generation)?;
    if timeout_ms == 0 {
        return Err(PlatformError::PipeConnectTimeout);
    }

    #[cfg(target_os = "windows")]
    {
        windows_impl::connect_worker_pipe_client(name, timeout_ms)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (name, timeout_ms);
        Err(PlatformError::WindowsRequired)
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
        let _ = (name, sddl);
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
    use super::{
        PIPE_AUTH_PRELUDE, VerifiedPipeClient, WORKER_PIPE_FRAME_MAX, WORKER_PIPE_PACKET_SIZE,
        WorkerPipe, WorkerPipeClient,
    };
    use crate::PlatformError;
    use std::ffi::{OsStr, c_void};
    use std::mem::{align_of, size_of};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type Handle = isize;

    const INVALID_HANDLE_VALUE: Handle = -1;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER_CLASS: u32 = 1;
    const TOKEN_GROUPS_CLASS: u32 = 2;
    const TOKEN_IMPERSONATION_LEVEL_CLASS: u32 = 9;
    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const SECURITY_IDENTIFICATION_LEVEL: u32 = 1;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_MORE_DATA: u32 = 234;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const INFINITE: u32 = u32::MAX;
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

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    impl Overlapped {
        fn new(event: Handle) -> Self {
            Self {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event,
            }
        }
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
        fn CreateEventW(
            event_attributes: *mut c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetOverlappedResult(
            file: Handle,
            overlapped: *mut Overlapped,
            transferred: *mut u32,
            wait: i32,
        ) -> i32;
        fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
        fn ConnectNamedPipe(pipe: Handle, overlapped: *mut Overlapped) -> i32;
        fn ReadFile(
            file: Handle,
            buffer: *mut c_void,
            bytes_to_read: u32,
            bytes_read: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn GetNamedPipeClientProcessId(pipe: Handle, client_process_id: *mut u32) -> i32;
        fn GetCurrentThread() -> Handle;
        fn WaitNamedPipeW(name: *const u16, timeout_ms: u32) -> i32;
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn WriteFile(
            file: Handle,
            buffer: *const c_void,
            bytes_to_write: u32,
            bytes_written: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
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
        fn ImpersonateNamedPipeClient(pipe: Handle) -> i32;
        fn RevertToSelf() -> i32;
        fn OpenThreadToken(
            thread_handle: Handle,
            desired_access: u32,
            open_as_self: i32,
            token_handle: *mut Handle,
        ) -> i32;
    }

    pub(super) struct OwnedClientHandle(Handle);

    impl Drop for OwnedClientHandle {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns a connected client pipe handle.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
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

    struct OwnedEvent(Handle);

    impl Drop for OwnedEvent {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns a live event handle.
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

    fn open_current_thread_token() -> Result<OwnedToken, PlatformError> {
        let mut raw = 0isize;
        // SAFETY: GetCurrentThread returns a pseudo-handle for the calling
        // impersonating thread and raw is a valid out pointer.
        let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 0, &mut raw) };
        if ok == 0 || raw == 0 {
            return Err(PlatformError::TokenQueryFailed);
        }
        Ok(OwnedToken(raw))
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

    struct TokenBuffer {
        words: Vec<usize>,
        byte_len: usize,
    }

    impl TokenBuffer {
        fn as_ptr(&self) -> *const u8 {
            self.words.as_ptr().cast::<u8>()
        }

        fn len(&self) -> usize {
            self.byte_len
        }
    }

    fn token_information(token: Handle, class: u32) -> Result<TokenBuffer, PlatformError> {
        let mut length = 0u32;
        // SAFETY: first call intentionally supplies a null output buffer to query
        // the required length.
        let first = unsafe { GetTokenInformation(token, class, ptr::null_mut(), 0, &mut length) };
        if first != 0 || length == 0 {
            return Err(PlatformError::TokenQueryFailed);
        }
        // SAFETY: GetLastError has no preconditions.
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(PlatformError::TokenQueryFailed);
        }

        // Token structures contain pointer-sized fields. Allocate in usize units
        // so every cast below has at least pointer alignment; Vec<u8> is not enough.
        let word = size_of::<usize>();
        let words = (length as usize)
            .checked_add(word - 1)
            .ok_or(PlatformError::TokenQueryFailed)?
            / word;
        let mut buffer = TokenBuffer {
            words: vec![0usize; words],
            byte_len: length as usize,
        };
        // SAFETY: the allocation is pointer-aligned and has at least length bytes.
        // It stays live while any SID pointer embedded in it is inspected.
        let ok = unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.words.as_mut_ptr().cast::<c_void>(),
                length,
                &mut length,
            )
        };
        if ok == 0 || length as usize > buffer.words.len() * word {
            return Err(PlatformError::TokenQueryFailed);
        }
        buffer.byte_len = length as usize;
        Ok(buffer)
    }

    fn impersonation_level(token: &OwnedToken) -> Result<u32, PlatformError> {
        let buffer = token_information(token.0, TOKEN_IMPERSONATION_LEVEL_CLASS)?;
        if buffer.len() < size_of::<u32>() {
            return Err(PlatformError::PipeImpersonationFailed);
        }
        // SAFETY: TokenImpersonationLevel returns one SECURITY_IMPERSONATION_LEVEL
        // value, represented by a 32-bit enum, and the buffer size was checked.
        Ok(unsafe { *(buffer.as_ptr().cast::<u32>()) })
    }

    fn sid_from_token(token: &OwnedToken, logon_sid: bool) -> Result<String, PlatformError> {
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

    pub(super) fn current_process_sid(logon_sid: bool) -> Result<String, PlatformError> {
        let token = open_current_token()?;
        sid_from_token(&token, logon_sid)
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

    fn create_event() -> Result<OwnedEvent, PlatformError> {
        // SAFETY: null security/name pointers are allowed. Manual-reset avoids
        // losing a completion signal before GetOverlappedResult consumes it.
        let raw = unsafe { CreateEventW(ptr::null_mut(), 1, 0, ptr::null()) };
        if raw == 0 {
            return Err(PlatformError::PipeConnectFailed);
        }
        Ok(OwnedEvent(raw))
    }

    fn cancel_and_drain(pipe: Handle, overlapped: &mut Overlapped) {
        // SAFETY: both handles/OVERLAPPED remain live until this function returns.
        unsafe {
            let _ = CancelIoEx(pipe, overlapped);
            let _ = WaitForSingleObject(overlapped.event, INFINITE);
            let mut transferred = 0u32;
            let _ = GetOverlappedResult(pipe, overlapped, &mut transferred, 0);
        }
    }

    fn wait_pending(
        pipe: Handle,
        overlapped: &mut Overlapped,
        timeout_ms: u32,
        timeout_error: PlatformError,
        operation_error: PlatformError,
    ) -> Result<u32, PlatformError> {
        // SAFETY: event belongs to this live OVERLAPPED.
        match unsafe { WaitForSingleObject(overlapped.event, timeout_ms) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                cancel_and_drain(pipe, overlapped);
                return Err(timeout_error);
            }
            _ => {
                cancel_and_drain(pipe, overlapped);
                return Err(operation_error);
            }
        }
        let mut transferred = 0u32;
        // SAFETY: operation has signaled completion and storage is still live.
        let ok = unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, 0) };
        if ok == 0 {
            return Err(operation_error);
        }
        Ok(transferred)
    }

    fn connect_client(pipe: Handle, timeout_ms: u32) -> Result<(), PlatformError> {
        let event = create_event()?;
        let mut overlapped = Overlapped::new(event.0);
        // SAFETY: pipe is overlapped and the OVERLAPPED/event stay live.
        let connected = unsafe { ConnectNamedPipe(pipe, &mut overlapped) };
        if connected != 0 {
            return Ok(());
        }
        // SAFETY: GetLastError immediately follows the failed API call.
        match unsafe { GetLastError() } {
            ERROR_PIPE_CONNECTED => Ok(()),
            ERROR_IO_PENDING => wait_pending(
                pipe,
                &mut overlapped,
                timeout_ms,
                PlatformError::PipeConnectTimeout,
                PlatformError::PipeConnectFailed,
            )
            .map(|_| ()),
            _ => Err(PlatformError::PipeConnectFailed),
        }
    }

    fn read_auth_prelude(pipe: Handle, timeout_ms: u32) -> Result<(), PlatformError> {
        let event = create_event().map_err(|_| PlatformError::PipeReadFailed)?;
        let mut overlapped = Overlapped::new(event.0);
        let mut prelude = 0u8;
        // SAFETY: one-byte buffer and OVERLAPPED/event remain live through
        // completion. lpNumberOfBytesRead may be null for overlapped I/O.
        let immediate = unsafe {
            ReadFile(
                pipe,
                (&mut prelude as *mut u8).cast::<c_void>(),
                1,
                ptr::null_mut(),
                &mut overlapped,
            )
        };
        let transferred = if immediate != 0 {
            let mut transferred = 0u32;
            // SAFETY: an immediately completed overlapped operation may be queried.
            let ok = unsafe { GetOverlappedResult(pipe, &mut overlapped, &mut transferred, 0) };
            if ok == 0 {
                return Err(PlatformError::PipeReadFailed);
            }
            transferred
        } else {
            // SAFETY: GetLastError immediately follows failed ReadFile.
            if unsafe { GetLastError() } != ERROR_IO_PENDING {
                return Err(PlatformError::PipeReadFailed);
            }
            wait_pending(
                pipe,
                &mut overlapped,
                timeout_ms,
                PlatformError::PipeConnectTimeout,
                PlatformError::PipeReadFailed,
            )?
        };
        if transferred != 1 || prelude != PIPE_AUTH_PRELUDE {
            return Err(PlatformError::PipeProtocolFailed);
        }
        Ok(())
    }

    pub(super) fn connect_worker_pipe_client(
        name: String,
        timeout_ms: u32,
    ) -> Result<WorkerPipeClient, PlatformError> {
        let wide_name = wide(OsStr::new(&name))?;
        // SAFETY: name is NUL-terminated. WaitNamedPipeW blocks only for the
        // caller-supplied bounded timeout.
        let available = unsafe { WaitNamedPipeW(wide_name.as_ptr(), timeout_ms) };
        if available == 0 {
            return Err(PlatformError::PipeConnectTimeout);
        }

        // SECURITY_IDENTIFICATION prevents the privileged server from using the
        // client connection for impersonation beyond identity inspection.
        // SAFETY: all optional pointers are null and name remains live.
        let raw = unsafe {
            CreateFileW(
                wide_name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null_mut(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | FILE_FLAG_OVERLAPPED,
                0,
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(PlatformError::PipeConnectFailed);
        }
        let handle = OwnedClientHandle(raw);

        let prelude = [PIPE_AUTH_PRELUDE];
        write_message(handle.0, &prelude, timeout_ms)?;

        Ok(WorkerPipeClient {
            name,
            _handle: handle,
        })
    }

    fn write_message(
        handle: Handle,
        bytes: &[u8],
        timeout_ms: u32,
    ) -> Result<(), PlatformError> {
        if bytes.is_empty() || bytes.len() > u32::MAX as usize || timeout_ms == 0 {
            return Err(PlatformError::PipeProtocolFailed);
        }
        let event = create_event().map_err(|_| PlatformError::PipeProtocolFailed)?;
        let mut overlapped = Overlapped::new(event.0);
        // SAFETY: bytes and OVERLAPPED/event stay live until completion.
        let immediate = unsafe {
            WriteFile(
                handle,
                bytes.as_ptr().cast::<c_void>(),
                bytes.len() as u32,
                ptr::null_mut(),
                (&mut overlapped as *mut Overlapped).cast::<c_void>(),
            )
        };
        let transferred = if immediate != 0 {
            let mut transferred = 0u32;
            // SAFETY: the overlapped write completed synchronously.
            let ok = unsafe { GetOverlappedResult(handle, &mut overlapped, &mut transferred, 0) };
            if ok == 0 {
                return Err(PlatformError::PipeProtocolFailed);
            }
            transferred
        } else {
            // SAFETY: GetLastError immediately follows WriteFile.
            if unsafe { GetLastError() } != ERROR_IO_PENDING {
                return Err(PlatformError::PipeProtocolFailed);
            }
            wait_pending(
                handle,
                &mut overlapped,
                timeout_ms,
                PlatformError::PipeConnectTimeout,
                PlatformError::PipeProtocolFailed,
            )?
        };
        if transferred as usize != bytes.len() {
            return Err(PlatformError::PipeProtocolFailed);
        }
        Ok(())
    }

    fn send_frame_handle(handle: Handle, frame: &[u8]) -> Result<(), PlatformError> {
        if frame.len() > WORKER_PIPE_FRAME_MAX {
            return Err(PlatformError::PipeProtocolFailed);
        }
        let mut packet = [0u8; WORKER_PIPE_PACKET_SIZE];
        packet[..2].copy_from_slice(&(frame.len() as u16).to_le_bytes());
        packet[2..2 + frame.len()].copy_from_slice(frame);
        write_message(handle, &packet, 10_000)
    }

    pub(super) fn send_client_frame(
        client: &OwnedClientHandle,
        frame: &[u8],
    ) -> Result<(), PlatformError> {
        send_frame_handle(client.0, frame)
    }

    pub(super) fn send_server_frame(
        pipe: &OwnedPipeHandle,
        frame: &[u8],
    ) -> Result<(), PlatformError> {
        send_frame_handle(pipe.0, frame)
    }

    fn read_frame_handle(handle: Handle, timeout_ms: u32) -> Result<Vec<u8>, PlatformError> {
        let event = create_event().map_err(|_| PlatformError::PipeReadFailed)?;
        let mut overlapped = Overlapped::new(event.0);
        let mut packet = [0u8; WORKER_PIPE_PACKET_SIZE];

        // SAFETY: fixed packet and OVERLAPPED stay live through completion.
        let immediate = unsafe {
            ReadFile(
                handle,
                packet.as_mut_ptr().cast::<c_void>(),
                WORKER_PIPE_PACKET_SIZE as u32,
                ptr::null_mut(),
                &mut overlapped,
            )
        };
        let transferred = if immediate != 0 {
            let mut transferred = 0u32;
            // SAFETY: the overlapped read completed synchronously.
            let ok = unsafe { GetOverlappedResult(handle, &mut overlapped, &mut transferred, 0) };
            if ok == 0 {
                return Err(PlatformError::PipeReadFailed);
            }
            transferred
        } else {
            // SAFETY: GetLastError immediately follows ReadFile.
            let error = unsafe { GetLastError() };
            if error == ERROR_MORE_DATA {
                return Err(PlatformError::PipeProtocolFailed);
            }
            if error != ERROR_IO_PENDING {
                return Err(PlatformError::PipeReadFailed);
            }
            wait_pending(
                handle,
                &mut overlapped,
                timeout_ms,
                PlatformError::PipeConnectTimeout,
                PlatformError::PipeReadFailed,
            )?
        };

        if transferred as usize != WORKER_PIPE_PACKET_SIZE {
            return Err(PlatformError::PipeProtocolFailed);
        }
        let declared = usize::from(u16::from_le_bytes([packet[0], packet[1]]));
        if declared > WORKER_PIPE_FRAME_MAX {
            return Err(PlatformError::PipeProtocolFailed);
        }
        if packet[2 + declared..].iter().any(|byte| *byte != 0) {
            return Err(PlatformError::PipeProtocolFailed);
        }
        Ok(packet[2..2 + declared].to_vec())
    }

    pub(super) fn read_frame(
        pipe: &OwnedPipeHandle,
        timeout_ms: u32,
    ) -> Result<Vec<u8>, PlatformError> {
        read_frame_handle(pipe.0, timeout_ms)
    }

    pub(super) fn read_client_frame(
        client: &OwnedClientHandle,
        timeout_ms: u32,
    ) -> Result<Vec<u8>, PlatformError> {
        read_frame_handle(client.0, timeout_ms)
    }

    pub(super) fn accept_verified_client(
        pipe: &OwnedPipeHandle,
        expected_logon_sid: &str,
        expected_process_id: u32,
        timeout_ms: u32,
    ) -> Result<VerifiedPipeClient, PlatformError> {
        connect_client(pipe.0, timeout_ms)?;
        read_auth_prelude(pipe.0, timeout_ms)?;

        let mut process_id = 0u32;
        // SAFETY: pipe is a connected server handle and process_id is a valid out pointer.
        let pid_ok = unsafe { GetNamedPipeClientProcessId(pipe.0, &mut process_id) };
        if pid_ok == 0 || process_id == 0 {
            return Err(PlatformError::PipeClientPidFailed);
        }
        if process_id != expected_process_id {
            return Err(PlatformError::PipeClientPidMismatch);
        }

        // SECURITY BOUNDARY: failure must abort. Continuing would execute under
        // the privileged service identity instead of the renter client's identity.
        // SAFETY: pipe has a client and at least one message was read above.
        let impersonated = unsafe { ImpersonateNamedPipeClient(pipe.0) };
        if impersonated == 0 {
            return Err(PlatformError::PipeImpersonationFailed);
        }

        let peer_result = (|| {
            let token =
                open_current_thread_token().map_err(|_| PlatformError::PipeImpersonationFailed)?;
            let level =
                impersonation_level(&token).map_err(|_| PlatformError::PipeImpersonationFailed)?;
            if level > SECURITY_IDENTIFICATION_LEVEL {
                return Err(PlatformError::PipeImpersonationLevelTooHigh);
            }
            let actual =
                sid_from_token(&token, true).map_err(|_| PlatformError::PipeImpersonationFailed)?;
            if !actual.eq_ignore_ascii_case(expected_logon_sid) {
                return Err(PlatformError::PipePeerSidMismatch);
            }
            Ok(VerifiedPipeClient {
                process_id,
                logon_sid: actual,
            })
        })();

        // SAFETY: this thread is impersonating only because the call above succeeded.
        let reverted = unsafe { RevertToSelf() };
        if reverted == 0 {
            // Microsoft explicitly warns that continuing after RevertToSelf fails
            // leaves this privileged thread running as the client. There is no
            // trustworthy recovery path inside the process, so fail closed by
            // terminating the component instead of returning to privileged code.
            std::process::abort();
        }
        peer_result
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

    #[cfg(target_os = "windows")]
    const TEST_SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
    #[cfg(target_os = "windows")]
    const TEST_SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
    #[cfg(target_os = "windows")]
    const TEST_SECURITY_IMPERSONATION: u32 = 0x0002_0000;

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
    fn oversized_worker_frame_is_rejected_before_io() {
        #[cfg(not(target_os = "windows"))]
        {
            let client = WorkerPipeClient {
                name: "test".to_owned(),
            };
            assert_eq!(
                client.send_frame(&vec![0u8; WORKER_PIPE_FRAME_MAX + 1]),
                Err(PlatformError::PipeProtocolFailed)
            );
        }
    }

    #[test]
    fn pipe_name_is_session_and_generation_fenced() {
        assert_eq!(
            pipe_name("sess-1", 7).expect("valid pipe name"),
            r"\\.\pipe\gpubnb-native-sess-1-7"
        );
        assert_eq!(pipe_name("sess-1", 0), Err(PlatformError::InvalidSessionId));
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

    #[cfg(target_os = "windows")]
    fn connect_test_client(
        name: String,
        sqos_flags: u32,
        ready: std::sync::mpsc::Sender<u32>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        use std::ffi::{OsStr, c_void};
        use std::os::windows::ffi::OsStrExt;

        type Handle = isize;
        const INVALID_HANDLE_VALUE: Handle = -1;
        const GENERIC_READ: u32 = 0x8000_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const OPEN_EXISTING: u32 = 3;

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateFileW(
                file_name: *const u16,
                desired_access: u32,
                share_mode: u32,
                security_attributes: *mut c_void,
                creation_disposition: u32,
                flags_and_attributes: u32,
                template_file: Handle,
            ) -> Handle;
            fn WriteFile(
                file: Handle,
                buffer: *const c_void,
                bytes_to_write: u32,
                bytes_written: *mut u32,
                overlapped: *mut c_void,
            ) -> i32;
            fn CloseHandle(object: Handle) -> i32;
            fn GetCurrentProcessId() -> u32;
        }

        let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
        // SAFETY: path is NUL-terminated and optional pointers are null.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                sqos_flags,
                0,
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE, "open secure pipe client");

        let prelude = PIPE_AUTH_PRELUDE;
        let mut written = 0u32;
        // SAFETY: one-byte buffer remains live for synchronous WriteFile.
        let ok = unsafe {
            WriteFile(
                handle,
                (&prelude as *const u8).cast::<c_void>(),
                1,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0, "write auth prelude");
        assert_eq!(written, 1);
        // SAFETY: no preconditions.
        let pid = unsafe { GetCurrentProcessId() };
        ready.send(pid).expect("send client pid");
        release.recv().expect("server verification completed");
        // SAFETY: client uniquely owns this handle.
        unsafe {
            let _ = CloseHandle(handle);
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_round_trips_bounded_worker_frame_through_public_client() {
        let service_sid = current_process_user_sid().expect("service SID");
        let logon_sid = current_process_logon_sid().expect("logon SID");
        let generation = std::process::id() as u64 + 10;
        let session = "ci-public-client";
        let pipe =
            create_worker_pipe(session, generation, &service_sid, &logon_sid).expect("secure pipe");

        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let client = std::thread::spawn(move || {
            let client =
                connect_worker_pipe_client(session, generation, 10_000).expect("connect client");
            ready_tx.send(()).expect("client ready");
            client
                .send_frame(b"gpubnb-worker-hello")
                .expect("send frame");
        });

        let verified = pipe
            .accept_verified_client(&logon_sid, std::process::id(), 10_000)
            .expect("verified public client");
        assert_eq!(verified.process_id, std::process::id());
        ready_rx.recv().expect("client connected");
        assert_eq!(
            pipe.read_frame(10_000).expect("read bounded frame"),
            b"gpubnb-worker-hello"
        );
        client.join().expect("client thread");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_verifies_connected_client_pid_and_logon_sid() {
        let service_sid = current_process_user_sid().expect("service SID");
        let logon_sid = current_process_logon_sid().expect("logon SID");
        let pipe = create_worker_pipe(
            "ci-peer-check",
            std::process::id() as u64,
            &service_sid,
            &logon_sid,
        )
        .expect("secure pipe");

        let (pid_tx, pid_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let name = pipe.name().to_owned();
        let client = std::thread::spawn(move || {
            connect_test_client(
                name,
                TEST_SECURITY_SQOS_PRESENT | TEST_SECURITY_IDENTIFICATION,
                pid_tx,
                release_rx,
            )
        });

        let verified = pipe
            .accept_verified_client(&logon_sid, std::process::id(), 10_000)
            .expect("verified pipe peer");
        let client_pid = pid_rx.recv().expect("client pid");
        assert_eq!(verified.process_id, client_pid);
        assert_eq!(verified.logon_sid, logon_sid);
        release_tx.send(()).expect("release client");
        client.join().expect("client thread");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_rejects_connected_client_with_wrong_process_id() {
        let service_sid = current_process_user_sid().expect("service SID");
        let logon_sid = current_process_logon_sid().expect("logon SID");
        let pipe = create_worker_pipe(
            "ci-peer-pid-mismatch",
            std::process::id() as u64 + 3,
            &service_sid,
            &logon_sid,
        )
        .expect("secure pipe");

        let (pid_tx, _pid_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let name = pipe.name().to_owned();
        let client = std::thread::spawn(move || {
            connect_test_client(
                name,
                TEST_SECURITY_SQOS_PRESENT | TEST_SECURITY_IDENTIFICATION,
                pid_tx,
                release_rx,
            )
        });

        assert_eq!(
            pipe.accept_verified_client(&logon_sid, std::process::id() + 1, 10_000),
            Err(PlatformError::PipeClientPidMismatch)
        );
        release_tx.send(()).expect("release client");
        client.join().expect("client thread");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_rejects_pipe_client_requesting_impersonation_authority() {
        let service_sid = current_process_user_sid().expect("service SID");
        let logon_sid = current_process_logon_sid().expect("logon SID");
        let pipe = create_worker_pipe(
            "ci-peer-level",
            std::process::id() as u64 + 2,
            &service_sid,
            &logon_sid,
        )
        .expect("secure pipe");

        let (pid_tx, _pid_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let name = pipe.name().to_owned();
        let client = std::thread::spawn(move || {
            connect_test_client(
                name,
                TEST_SECURITY_SQOS_PRESENT | TEST_SECURITY_IMPERSONATION,
                pid_tx,
                release_rx,
            )
        });

        assert_eq!(
            pipe.accept_verified_client(&logon_sid, std::process::id(), 10_000),
            Err(PlatformError::PipeImpersonationLevelTooHigh)
        );
        release_tx.send(()).expect("release client");
        client.join().expect("client thread");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_rejects_connected_client_with_wrong_logon_sid() {
        let service_sid = current_process_user_sid().expect("service SID");
        let logon_sid = current_process_logon_sid().expect("logon SID");
        let pipe = create_worker_pipe(
            "ci-peer-mismatch",
            std::process::id() as u64 + 1,
            &service_sid,
            &logon_sid,
        )
        .expect("secure pipe");

        let (pid_tx, _pid_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let name = pipe.name().to_owned();
        let client = std::thread::spawn(move || {
            connect_test_client(
                name,
                TEST_SECURITY_SQOS_PRESENT | TEST_SECURITY_IDENTIFICATION,
                pid_tx,
                release_rx,
            )
        });

        assert_eq!(
            pipe.accept_verified_client("S-1-5-5-999999-999999", std::process::id(), 10_000,),
            Err(PlatformError::PipePeerSidMismatch)
        );
        release_tx.send(()).expect("release client");
        client.join().expect("client thread");
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
