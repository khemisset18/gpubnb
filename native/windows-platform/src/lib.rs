//! Narrow Win32 adapter for security-sensitive Windows-native primitives.
//!
//! Unsafe FFI is intentionally confined to this crate. Higher-level readiness,
//! billing and session-fencing policy stays in the safe windows-stream-helper core.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: [u8; 16],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplicationFileEvidence {
    pub identity: FileIdentity,
    pub fixed_local_volume: bool,
    pub final_component_reparse_point: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformError {
    WindowsRequired,
    InvalidPath,
    OpenFailed,
    FileInfoFailed,
    VolumeInfoFailed,
    NonFixedVolume,
    ReparsePoint,
}

pub struct VerifiedApplicationFile {
    evidence: ApplicationFileEvidence,
    #[cfg(target_os = "windows")]
    _handle: windows_impl::OwnedHandle,
}

impl VerifiedApplicationFile {
    pub const fn evidence(&self) -> ApplicationFileEvidence {
        self.evidence
    }
}

pub fn open_application_for_verification(
    path: &Path,
) -> Result<VerifiedApplicationFile, PlatformError> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::open_application_for_verification(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err(PlatformError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{ApplicationFileEvidence, FileIdentity, PlatformError, VerifiedApplicationFile};
    use std::ffi::{OsStr, c_void};
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    type Handle = isize;

    const INVALID_HANDLE_VALUE: Handle = -1;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const FILE_ID_INFO_CLASS: i32 = 0x12;
    const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 0x09;
    const DRIVE_FIXED: u32 = 3;

    #[repr(C)]
    struct FileId128 {
        identifier: [u8; 16],
    }

    #[repr(C)]
    struct FileIdInfo {
        volume_serial_number: u64,
        file_id: FileId128,
    }

    #[repr(C)]
    struct FileAttributeTagInfo {
        file_attributes: u32,
        reparse_tag: u32,
    }

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
        fn GetFileInformationByHandleEx(
            file: Handle,
            info_class: i32,
            file_information: *mut c_void,
            buffer_size: u32,
        ) -> i32;
        fn GetVolumePathNameW(
            file_name: *const u16,
            volume_path_name: *mut u16,
            buffer_length: u32,
        ) -> i32;
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
        fn CloseHandle(object: Handle) -> i32;
    }

    pub(super) struct OwnedHandle(Handle);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: self.0 is a live handle returned by CreateFileW and this
            // type is the unique owner. Drop executes at most once.
            unsafe {
                let _ = CloseHandle(self.0);
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
            return Err(PlatformError::InvalidPath);
        }
        Ok(encoded)
    }

    fn file_info<T>(handle: Handle, class: i32) -> Result<T, PlatformError> {
        let mut value = MaybeUninit::<T>::uninit();
        // SAFETY: value points to writable storage of exactly size_of::<T>(),
        // handle is owned/live, and the info class determines T at each call site.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                value.as_mut_ptr().cast::<c_void>(),
                size_of::<T>() as u32,
            )
        };
        if ok == 0 {
            return Err(PlatformError::FileInfoFailed);
        }
        // SAFETY: a successful GetFileInformationByHandleEx fully initialized
        // the requested fixed-size structure.
        Ok(unsafe { value.assume_init() })
    }

    fn fixed_local_volume(path_wide: &[u16]) -> Result<bool, PlatformError> {
        let mut root = [0u16; 1024];
        // SAFETY: path_wide is NUL-terminated and root is a writable buffer with
        // the supplied element count.
        let ok =
            unsafe { GetVolumePathNameW(path_wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) };
        if ok == 0 {
            return Err(PlatformError::VolumeInfoFailed);
        }
        // SAFETY: GetVolumePathNameW writes a NUL-terminated root path on success.
        let drive_type = unsafe { GetDriveTypeW(root.as_ptr()) };
        Ok(drive_type == DRIVE_FIXED)
    }

    pub(super) fn open_application_for_verification(
        path: &Path,
    ) -> Result<VerifiedApplicationFile, PlatformError> {
        if !path.is_absolute() {
            return Err(PlatformError::InvalidPath);
        }
        let path_wide = wide(path.as_os_str())?;
        if !fixed_local_volume(&path_wide)? {
            return Err(PlatformError::NonFixedVolume);
        }

        // FILE_SHARE_DELETE and FILE_SHARE_WRITE are deliberately omitted so a
        // verified executable cannot be replaced while this handle is retained.
        // FILE_FLAG_OPEN_REPARSE_POINT inspects the final component itself.
        // SAFETY: all pointers are either valid/NUL-terminated or null as allowed
        // by CreateFileW; no borrowed pointer outlives this call.
        let raw = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                0,
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(PlatformError::OpenFailed);
        }
        let handle = OwnedHandle(raw);

        let attributes: FileAttributeTagInfo = file_info(handle.0, FILE_ATTRIBUTE_TAG_INFO_CLASS)?;
        let is_reparse = attributes.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        if is_reparse {
            return Err(PlatformError::ReparsePoint);
        }

        let identity: FileIdInfo = file_info(handle.0, FILE_ID_INFO_CLASS)?;
        Ok(VerifiedApplicationFile {
            evidence: ApplicationFileEvidence {
                identity: FileIdentity {
                    volume_serial: identity.volume_serial_number,
                    file_id: identity.file_id.identifier,
                },
                fixed_local_volume: true,
                final_component_reparse_point: false,
            },
            _handle: handle,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn current_executable_has_stable_identity_on_fixed_runner_volume() {
            let exe = std::env::current_exe().expect("current exe");
            let opened = open_application_for_verification(&exe).expect("open current exe");
            let evidence = opened.evidence();
            assert!(evidence.fixed_local_volume);
            assert!(!evidence.final_component_reparse_point);
            assert!(evidence.identity.file_id.iter().any(|byte| *byte != 0));
        }
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod non_windows_tests {
    use super::*;

    #[test]
    fn non_windows_fails_closed() {
        assert_eq!(
            open_application_for_verification(Path::new("/tmp/app.exe")).err(),
            Some(PlatformError::WindowsRequired)
        );
    }
}
