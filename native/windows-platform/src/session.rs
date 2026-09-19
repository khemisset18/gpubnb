//! Explicit Windows renter-session token boundary.
//!
//! The privileged service must never auto-select the console/active provider
//! session. Callers supply a non-zero Windows session id that was provisioned for
//! the renter. WTSQueryUserToken is then verified rather than trusted blindly.
//! This module validates an existing interactive boundary; it deliberately does
//! not claim that LogonUser/CreateProcessAsUser can manufacture a separate WTS
//! session.

use crate::PlatformError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenterSessionIsolationProof {
    windows_session_id: u32,
}

impl RenterSessionIsolationProof {
    const fn verified(windows_session_id: u32) -> Self {
        Self { windows_session_id }
    }

    pub const fn windows_session_id(self) -> u32 {
        self.windows_session_id
    }

    pub const fn separate_renter_identity(self) -> bool {
        true
    }

    pub const fn renter_session_active(self) -> bool {
        true
    }

    pub const fn provider_session_inactive(self) -> bool {
        true
    }
}

pub struct RenterSessionToken {
    session_id: u32,
    logon_sid: String,
    user_sid: String,
    isolation: RenterSessionIsolationProof,
    #[cfg(target_os = "windows")]
    handle: windows_impl::OwnedToken,
}

pub struct RenterEnvironment {
    #[cfg(target_os = "windows")]
    block: windows_impl::OwnedEnvironment,
}

impl RenterSessionToken {
    pub const fn session_id(&self) -> u32 {
        self.session_id
    }

    pub fn logon_sid(&self) -> &str {
        &self.logon_sid
    }

    pub fn user_sid(&self) -> &str {
        &self.user_sid
    }

    pub const fn isolation_proof(&self) -> RenterSessionIsolationProof {
        self.isolation
    }

    pub fn create_environment(&self) -> Result<RenterEnvironment, PlatformError> {
        #[cfg(target_os = "windows")]
        {
            windows_impl::create_environment(&self.handle)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError::WindowsRequired)
        }
    }

    #[cfg(target_os = "windows")]
    pub(crate) const fn raw_handle(&self) -> isize {
        self.handle.0
    }
}

impl RenterEnvironment {
    #[cfg(target_os = "windows")]
    pub(crate) const fn raw_ptr(&self) -> *mut std::ffi::c_void {
        self.block.0
    }
}

const FORBIDDEN_RENTER_SYSTEM_SIDS: [&str; 3] = ["S-1-5-18", "S-1-5-19", "S-1-5-20"];

fn numeric_sid(value: &str) -> bool {
    if value.is_empty() || value.len() > 184 || !value.starts_with("S-1-") {
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

#[cfg(any(target_os = "windows", test))]
fn validate_exclusive_active_session(
    renter_session_id: u32,
    active_session_ids: &[u32],
) -> Result<(), PlatformError> {
    if !active_session_ids.contains(&renter_session_id) {
        return Err(PlatformError::RenterSessionNotActive);
    }
    if active_session_ids
        .iter()
        .any(|session_id| *session_id != renter_session_id)
    {
        return Err(PlatformError::AnotherInteractiveSessionActive);
    }
    Ok(())
}

fn validate_renter_identity_policy(
    expected_renter_user_sid: &str,
    provider_user_sid: &str,
) -> Result<(), PlatformError> {
    if !numeric_sid(expected_renter_user_sid) || !numeric_sid(provider_user_sid) {
        return Err(PlatformError::InvalidRenterUserSid);
    }
    if FORBIDDEN_RENTER_SYSTEM_SIDS
        .iter()
        .any(|sid| sid.eq_ignore_ascii_case(expected_renter_user_sid))
    {
        return Err(PlatformError::RenterSystemIdentityForbidden);
    }
    if expected_renter_user_sid.eq_ignore_ascii_case(provider_user_sid) {
        return Err(PlatformError::RenterProviderIdentityForbidden);
    }
    Ok(())
}

pub fn current_process_session_id() -> Result<u32, PlatformError> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::current_process_session_id()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(PlatformError::WindowsRequired)
    }
}

pub fn query_renter_session_token(
    session_id: u32,
    expected_renter_user_sid: &str,
    provider_user_sid: &str,
) -> Result<RenterSessionToken, PlatformError> {
    if session_id == 0 {
        return Err(PlatformError::InvalidWindowsSessionId);
    }
    validate_renter_identity_policy(expected_renter_user_sid, provider_user_sid)?;

    #[cfg(target_os = "windows")]
    {
        windows_impl::query_renter_session_token(session_id, expected_renter_user_sid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(PlatformError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{RenterSessionIsolationProof, RenterSessionToken};
    use crate::PlatformError;
    use std::ffi::c_void;
    use std::mem::{align_of, size_of};
    use std::ptr;

    type Handle = isize;

    const TOKEN_USER_CLASS: u32 = 1;
    const TOKEN_GROUPS_CLASS: u32 = 2;
    const TOKEN_TYPE_CLASS: u32 = 8;
    const TOKEN_SESSION_ID_CLASS: u32 = 12;
    const TOKEN_PRIMARY: u32 = 1;
    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const WTS_ACTIVE: u32 = 0;

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
    struct WtsSessionInfoW {
        session_id: u32,
        win_station_name: *mut u16,
        state: u32,
    }

    pub(super) struct OwnedToken(pub(super) Handle);

    impl Drop for OwnedToken {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns the WTSQueryUserToken handle.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(super) struct OwnedEnvironment(pub(super) *mut c_void);

    impl Drop for OwnedEnvironment {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: pointer was returned by CreateEnvironmentBlock and is
                // uniquely owned by this wrapper.
                unsafe {
                    let _ = DestroyEnvironmentBlock(self.0);
                }
            }
        }
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

    #[link(name = "wtsapi32")]
    unsafe extern "system" {
        fn WTSQueryUserToken(session_id: u32, token: *mut Handle) -> i32;
        fn WTSEnumerateSessionsW(
            server: Handle,
            reserved: u32,
            version: u32,
            sessions: *mut *mut WtsSessionInfoW,
            count: *mut u32,
        ) -> i32;
        fn WTSFreeMemory(memory: *mut c_void);
    }

    #[link(name = "userenv")]
    unsafe extern "system" {
        fn CreateEnvironmentBlock(
            environment: *mut *mut c_void,
            token: Handle,
            inherit: i32,
        ) -> i32;
        fn DestroyEnvironmentBlock(environment: *mut c_void) -> i32;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetTokenInformation(
            token_handle: Handle,
            token_information_class: u32,
            token_information: *mut c_void,
            token_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, string_sid: *mut *mut u16) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CloseHandle(object: Handle) -> i32;
        fn GetLastError() -> u32;
        fn LocalFree(memory: Handle) -> Handle;
        fn GetCurrentProcessId() -> u32;
        fn ProcessIdToSessionId(process_id: u32, session_id: *mut u32) -> i32;
    }

    fn token_information(token: Handle, class: u32) -> Result<TokenBuffer, PlatformError> {
        let mut length = 0u32;
        // SAFETY: first call intentionally queries the exact required size.
        let first = unsafe { GetTokenInformation(token, class, ptr::null_mut(), 0, &mut length) };
        if first != 0 || length == 0 {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        // SAFETY: GetLastError immediately follows GetTokenInformation.
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(PlatformError::RenterTokenQueryFailed);
        }

        let word = size_of::<usize>();
        let words = (length as usize)
            .checked_add(word - 1)
            .ok_or(PlatformError::RenterTokenQueryFailed)?
            / word;
        let mut buffer = TokenBuffer {
            words: vec![0usize; words],
            byte_len: length as usize,
        };
        // SAFETY: allocation is pointer-aligned and has at least length bytes.
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
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        buffer.byte_len = length as usize;
        Ok(buffer)
    }

    fn token_u32(token: Handle, class: u32) -> Result<u32, PlatformError> {
        let buffer = token_information(token, class)?;
        if buffer.len() < size_of::<u32>() {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        // SAFETY: caller requested a token class whose documented result is DWORD
        // and the returned buffer contains at least one DWORD.
        Ok(unsafe { *(buffer.as_ptr().cast::<u32>()) })
    }

    fn sid_to_string(sid: *mut c_void) -> Result<String, PlatformError> {
        if sid.is_null() {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        let mut raw: *mut u16 = ptr::null_mut();
        // SAFETY: sid points into a live token-information buffer.
        let ok = unsafe { ConvertSidToStringSidW(sid, &mut raw) };
        if ok == 0 || raw.is_null() {
            return Err(PlatformError::RenterTokenQueryFailed);
        }

        let mut len = 0usize;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated LocalAlloc string.
        unsafe {
            while *raw.add(len) != 0 {
                len += 1;
            }
        }
        // SAFETY: raw references len initialized UTF-16 units.
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) })
            .map_err(|_| PlatformError::RenterTokenQueryFailed);
        // SAFETY: raw was allocated by LocalAlloc.
        unsafe {
            let _ = LocalFree(raw as Handle);
        }
        text
    }

    fn user_sid(token: Handle) -> Result<String, PlatformError> {
        let buffer = token_information(token, TOKEN_USER_CLASS)?;
        if buffer.len() < size_of::<TokenUser>() {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        // SAFETY: TokenUser populated one complete aligned TokenUser structure.
        let user = unsafe { &*(buffer.as_ptr().cast::<TokenUser>()) };
        sid_to_string(user.user.sid)
    }

    fn logon_sid(token: Handle) -> Result<String, PlatformError> {
        let buffer = token_information(token, TOKEN_GROUPS_CLASS)?;
        if buffer.len() < size_of::<u32>() {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        // SAFETY: TOKEN_GROUPS begins with a DWORD count.
        let count = unsafe { *(buffer.as_ptr().cast::<u32>()) as usize };
        let header = (size_of::<u32>() + align_of::<SidAndAttributes>() - 1)
            & !(align_of::<SidAndAttributes>() - 1);
        let bytes_needed = header
            .checked_add(
                count
                    .checked_mul(size_of::<SidAndAttributes>())
                    .ok_or(PlatformError::RenterTokenQueryFailed)?,
            )
            .ok_or(PlatformError::RenterTokenQueryFailed)?;
        if bytes_needed > buffer.len() {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        // SAFETY: alignment and bounds were checked above.
        let groups = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr().add(header).cast::<SidAndAttributes>(),
                count,
            )
        };
        let group = groups
            .iter()
            .find(|group| group.attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
            .ok_or(PlatformError::RenterTokenQueryFailed)?;
        sid_to_string(group.sid)
    }

    pub(super) fn current_process_session_id() -> Result<u32, PlatformError> {
        // SAFETY: GetCurrentProcessId has no preconditions.
        let process_id = unsafe { GetCurrentProcessId() };
        if process_id == 0 {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        let mut session_id = 0u32;
        // SAFETY: session_id is a valid out pointer for this live process id.
        let ok = unsafe { ProcessIdToSessionId(process_id, &mut session_id) };
        if ok == 0 || session_id == 0 {
            return Err(PlatformError::InvalidWindowsSessionId);
        }
        Ok(session_id)
    }

    fn active_session_ids() -> Result<Vec<u32>, PlatformError> {
        let mut raw: *mut WtsSessionInfoW = ptr::null_mut();
        let mut count = 0u32;
        // SAFETY: raw/count are valid out pointers. A null server handle means the
        // local machine, which is the only authority boundary GPUbnb supports.
        let ok = unsafe { WTSEnumerateSessionsW(0, 0, 1, &mut raw, &mut count) };
        if ok == 0 {
            return Err(PlatformError::RenterTokenQueryFailed);
        }

        struct OwnedWtsMemory(*mut c_void);
        impl Drop for OwnedWtsMemory {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    // SAFETY: memory came from WTSEnumerateSessionsW.
                    unsafe { WTSFreeMemory(self.0) };
                }
            }
        }

        let _memory = OwnedWtsMemory(raw.cast::<c_void>());
        if count == 0 {
            return Ok(Vec::new());
        }
        if raw.is_null() || count > 1024 {
            return Err(PlatformError::RenterTokenQueryFailed);
        }

        // SAFETY: WTSEnumerateSessionsW returned count contiguous entries.
        let sessions = unsafe { std::slice::from_raw_parts(raw, count as usize) };
        Ok(sessions
            .iter()
            .filter(|session| session.state == WTS_ACTIVE)
            .map(|session| session.session_id)
            .collect())
    }

    pub(super) fn create_environment(
        token: &OwnedToken,
    ) -> Result<super::RenterEnvironment, PlatformError> {
        let mut raw = ptr::null_mut();
        // SAFETY: token is a live primary user token. inherit=FALSE ensures the
        // privileged service environment is not copied into the renter worker.
        let ok = unsafe { CreateEnvironmentBlock(&mut raw, token.0, 0) };
        if ok == 0 || raw.is_null() {
            return Err(PlatformError::EnvironmentCreateFailed);
        }
        Ok(super::RenterEnvironment {
            block: OwnedEnvironment(raw),
        })
    }

    pub(super) fn query_renter_session_token(
        session_id: u32,
        expected_renter_user_sid: &str,
    ) -> Result<RenterSessionToken, PlatformError> {
        super::validate_exclusive_active_session(session_id, &active_session_ids()?)?;

        let mut raw = 0isize;
        // SAFETY: raw is a valid out pointer. WTSQueryUserToken requires the
        // privileged LocalSystem service context; lack of that privilege fails closed.
        let ok = unsafe { WTSQueryUserToken(session_id, &mut raw) };
        if ok == 0 || raw == 0 {
            return Err(PlatformError::RenterTokenQueryFailed);
        }
        let handle = OwnedToken(raw);

        let token_type = token_u32(handle.0, TOKEN_TYPE_CLASS)?;
        if token_type != TOKEN_PRIMARY {
            return Err(PlatformError::RenterTokenNotPrimary);
        }

        let token_session_id = token_u32(handle.0, TOKEN_SESSION_ID_CLASS)?;
        if token_session_id != session_id {
            return Err(PlatformError::RenterTokenSessionMismatch);
        }

        let user_sid = user_sid(handle.0)?;
        if !user_sid.eq_ignore_ascii_case(expected_renter_user_sid) {
            return Err(PlatformError::RenterTokenUserMismatch);
        }
        let logon_sid = logon_sid(handle.0)?;

        Ok(RenterSessionToken {
            session_id,
            logon_sid,
            user_sid,
            isolation: RenterSessionIsolationProof::verified(session_id),
            handle,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_isolation_proof_encodes_the_full_renter_boundary() {
        let proof = RenterSessionIsolationProof::verified(42);
        assert_eq!(proof.windows_session_id(), 42);
        assert!(proof.separate_renter_identity());
        assert!(proof.renter_session_active());
        assert!(proof.provider_session_inactive());
    }

    #[test]
    fn exclusive_session_policy_requires_only_the_renter_to_be_active() {
        assert_eq!(validate_exclusive_active_session(42, &[42]), Ok(()));
        assert_eq!(
            validate_exclusive_active_session(42, &[]),
            Err(PlatformError::RenterSessionNotActive)
        );
        assert_eq!(
            validate_exclusive_active_session(42, &[7]),
            Err(PlatformError::RenterSessionNotActive)
        );
        assert_eq!(
            validate_exclusive_active_session(42, &[42, 7]),
            Err(PlatformError::AnotherInteractiveSessionActive)
        );
    }

    #[test]
    fn renter_identity_policy_rejects_provider_system_and_malformed_sids() {
        assert_eq!(
            validate_renter_identity_policy(
                "S-1-5-21-100-200-300-1000",
                "S-1-5-21-100-200-300-1000",
            ),
            Err(PlatformError::RenterProviderIdentityForbidden)
        );
        for system_sid in FORBIDDEN_RENTER_SYSTEM_SIDS {
            assert_eq!(
                validate_renter_identity_policy(system_sid, "S-1-5-21-100-200-300-1000",),
                Err(PlatformError::RenterSystemIdentityForbidden)
            );
        }
        assert_eq!(
            validate_renter_identity_policy(
                "S-1-5-21-100)(A;;GA;;;WD",
                "S-1-5-21-100-200-300-1000",
            ),
            Err(PlatformError::InvalidRenterUserSid)
        );
    }

    #[test]
    fn session_zero_is_never_a_renter_session() {
        assert_eq!(
            query_renter_session_token(0, "S-1-5-21-100-200-300-1001", "S-1-5-21-100-200-300-1000")
                .err(),
            Some(PlatformError::InvalidWindowsSessionId)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn current_process_reports_nonzero_windows_session() {
        assert!(current_process_session_id().expect("current WTS session") > 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn nonexistent_session_fails_closed() {
        assert_eq!(
            query_renter_session_token(
                u32::MAX - 1,
                "S-1-5-21-100-200-300-1001",
                "S-1-5-21-100-200-300-1000",
            )
            .err(),
            Some(PlatformError::RenterSessionNotActive)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_fails_closed() {
        assert_eq!(
            query_renter_session_token(
                1,
                "S-1-5-21-100-200-300-1001",
                "S-1-5-21-100-200-300-1000",
            )
            .err(),
            Some(PlatformError::WindowsRequired)
        );
    }
}
