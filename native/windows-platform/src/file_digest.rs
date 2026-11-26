//! Read-only full-file SHA-256 evidence for an already fenced Windows file.
//!
//! This is NOT a replacement for Authenticode. No launch or DLL-loading
//! authority is granted here. The caller must retain the verification fence.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileDigestError {
    WindowsRequired,
    OpenFailed,
    IdentityMismatch,
    ReadFailed,
    TooLarge,
    HashFailed,
}

// Bound the diagnostic's memory and total bytes read. This is a measurement
// limit, not a maximum supported executable size for existing signed releases.
#[cfg(target_os = "windows")]
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(target_os = "windows")]
pub(super) fn sha256_reader(reader: impl std::io::Read) -> Result<[u8; 32], FileDigestError> {
    windows::sha256_reader(reader)
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{FileDigestError, MAX_FILE_BYTES};
    use std::ffi::c_void;
    use std::io::Read;
    use std::ptr;

    type Handle = *mut c_void;
    const SUCCESS: i32 = 0;

    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptOpenAlgorithmProvider(
            algorithm: *mut Handle,
            algorithm_id: *const u16,
            implementation: *const u16,
            flags: u32,
        ) -> i32;
        fn BCryptCloseAlgorithmProvider(algorithm: Handle, flags: u32) -> i32;
        fn BCryptCreateHash(
            algorithm: Handle,
            hash: *mut Handle,
            hash_object: *mut u8,
            hash_object_len: u32,
            secret: *const u8,
            secret_len: u32,
            flags: u32,
        ) -> i32;
        fn BCryptHashData(hash: Handle, data: *const u8, data_len: u32, flags: u32) -> i32;
        fn BCryptFinishHash(hash: Handle, output: *mut u8, output_len: u32, flags: u32) -> i32;
        fn BCryptDestroyHash(hash: Handle) -> i32;
    }

    struct Algorithm(Handle);

    impl Drop for Algorithm {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns a successful CNG algorithm handle.
            unsafe { BCryptCloseAlgorithmProvider(self.0, 0) };
        }
    }

    struct Hash(Handle);

    impl Drop for Hash {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns a successful CNG hash handle.
            unsafe { BCryptDestroyHash(self.0) };
        }
    }

    pub(super) fn sha256_reader(mut reader: impl Read) -> Result<[u8; 32], FileDigestError> {
        let algorithm_id: Vec<u16> = "SHA256".encode_utf16().chain(Some(0)).collect();
        let mut raw = ptr::null_mut();
        // SAFETY: output handle is writable; algorithm_id is NUL terminated.
        if unsafe { BCryptOpenAlgorithmProvider(&mut raw, algorithm_id.as_ptr(), ptr::null(), 0) }
            != SUCCESS
            || raw.is_null()
        {
            return Err(FileDigestError::HashFailed);
        }
        let algorithm = Algorithm(raw);
        let mut raw_hash = ptr::null_mut();
        // SAFETY: algorithm is live; Windows 10+ CNG allocates the hash object
        // when the object pointer and length are both zero. No secret is needed.
        if unsafe {
            BCryptCreateHash(
                algorithm.0,
                &mut raw_hash,
                ptr::null_mut(),
                0,
                ptr::null(),
                0,
                0,
            )
        } != SUCCESS
            || raw_hash.is_null()
        {
            return Err(FileDigestError::HashFailed);
        }
        let hash = Hash(raw_hash);
        let mut buffer = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|_| FileDigestError::ReadFailed)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > MAX_FILE_BYTES {
                return Err(FileDigestError::TooLarge);
            }
            // SAFETY: count is bounded by the buffer size; hash is live.
            if unsafe { BCryptHashData(hash.0, buffer.as_ptr(), count as u32, 0) } != SUCCESS {
                return Err(FileDigestError::HashFailed);
            }
        }
        let mut output = [0u8; 32];
        // SAFETY: output is the exact SHA-256 output size; hash is live.
        if unsafe { BCryptFinishHash(hash.0, output.as_mut_ptr(), output.len() as u32, 0) }
            != SUCCESS
        {
            return Err(FileDigestError::HashFailed);
        }
        Ok(output)
    }
}
