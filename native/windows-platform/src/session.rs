//! Explicit Windows renter-session token boundary.
//!
//! The privileged service must never auto-select the console/active provider
//! session. Callers supply a non-zero Windows session id that was provisioned for
//! the renter. WTSQueryUserToken is then verified rather than trusted blindly.

use crate::PlatformError;

#[derive(Debug)]
pub struct RenterSessionToken {
    session_id: u32,
    logon_sid: String,
    user_sid: String,
    #[cfg(target_os = "windows")]
    handle: windows_impl::OwnedToken,
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

    #[cfg(target_os = "windows")]
    pub(crate) const fn raw_handle(&self) -> isize {
        self.handle.0
    }
}

pub fn query_renter_session_token(session_id: u32) -> Result<RenterSessionToken, PlatformError> {
    if session_id == 0 {
        return Err(PlatformError::InvalidWindowsSessionId);
    }

    #[cfg(target_os = "windows")]
    {
        windows_impl::query_renter_session_token(session_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(PlatformError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::RenterSessionToken;
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

    #[repr(C)]
    struct SidAndAttributes {
        sid: *mut c_void,
        attributes: u32,
    }

    #[repr(C)]
    struct TokenUser {
        user: SidAndAttributes,
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

    pub(super) fn query_renter_session_token(
        session_id: u32,
    ) -> Result<RenterSessionToken, PlatformError> {
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
        let logon_sid = logon_sid(handle.0)?;

        Ok(RenterSessionToken {
            session_id,
            logon_sid,
            user_sid,
            handle,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_zero_is_never_a_renter_session() {
        assert_eq!(
            query_renter_session_token(0).err(),
            Some(PlatformError::InvalidWindowsSessionId)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn nonexistent_session_fails_closed() {
        assert_eq!(
            query_renter_session_token(u32::MAX - 1).err(),
            Some(PlatformError::RenterTokenQueryFailed)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_fails_closed() {
        assert_eq!(
            query_renter_session_token(1).err(),
            Some(PlatformError::WindowsRequired)
        );
    }
}
