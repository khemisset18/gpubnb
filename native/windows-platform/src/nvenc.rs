//! Minimal NVIDIA NVENC driver capability probe.
//!
//! This module deliberately does not define or mirror the proprietary SDK structs.
//! It only calls the stable driver entrypoint NvEncodeAPIGetMaxSupportedVersion.
//! A real D3D11 encode still requires the versioned NVIDIA Video Codec SDK API
//! surface and must independently prove encoded output from the leased GPU.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NvencApiVersion {
    pub raw: u32,
    pub major: u8,
    pub minor: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NvencProbeError {
    WindowsRequired,
    LibraryMissing,
    SymbolMissing,
    VersionQueryFailed,
    InvalidVersion,
}

pub fn decode_nvenc_api_version(raw: u32) -> Result<NvencApiVersion, NvencProbeError> {
    // NVIDIA encodes NVENCAPI_VERSION as:
    // major | (minor << 24).
    let major_raw = raw & 0x00ff_ffff;
    let minor_raw = raw >> 24;
    if major_raw == 0 || major_raw > u8::MAX as u32 || minor_raw > u8::MAX as u32 {
        return Err(NvencProbeError::InvalidVersion);
    }
    Ok(NvencApiVersion {
        raw,
        major: major_raw as u8,
        minor: minor_raw as u8,
    })
}

pub fn query_nvenc_max_supported_version() -> Result<NvencApiVersion, NvencProbeError> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::query_nvenc_max_supported_version()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(NvencProbeError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{decode_nvenc_api_version, NvencApiVersion, NvencProbeError};
    use std::ffi::{c_char, c_void};
    use std::mem;
    use std::ptr;

    type Hmodule = isize;
    type NvencStatus = i32;
    type GetMaxSupportedVersion = unsafe extern "system" fn(*mut u32) -> NvencStatus;

    const NV_ENC_SUCCESS: NvencStatus = 0;
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryExW(file_name: *const u16, file: isize, flags: u32) -> Hmodule;
        fn GetProcAddress(module: Hmodule, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: Hmodule) -> i32;
    }

    struct OwnedModule(Hmodule);

    impl Drop for OwnedModule {
        fn drop(&mut self) {
            if self.0 != 0 {
                // SAFETY: this wrapper uniquely owns the LoadLibraryExW module.
                unsafe {
                    let _ = FreeLibrary(self.0);
                }
            }
        }
    }

    pub(super) fn query_nvenc_max_supported_version(
    ) -> Result<NvencApiVersion, NvencProbeError> {
        let name: Vec<u16> = "nvEncodeAPI64.dll".encode_utf16().chain(Some(0)).collect();
        // nvEncodeAPI64.dll is supplied by the NVIDIA display driver. Restrict
        // resolution to System32 so a renter-writable current directory cannot
        // substitute a same-named DLL.
        // SAFETY: name is NUL-terminated; optional file handle is null/zero.
        let raw = unsafe {
            LoadLibraryExW(name.as_ptr(), 0, LOAD_LIBRARY_SEARCH_SYSTEM32)
        };
        if raw == 0 {
            return Err(NvencProbeError::LibraryMissing);
        }
        let module = OwnedModule(raw);

        const SYMBOL: &[u8] = b"NvEncodeAPIGetMaxSupportedVersion\0";
        // SAFETY: module is live and SYMBOL is a static NUL-terminated C string.
        let address = unsafe { GetProcAddress(module.0, SYMBOL.as_ptr().cast::<c_char>()) };
        if address.is_null() {
            return Err(NvencProbeError::SymbolMissing);
        }

        // SAFETY: NVIDIA documents this exported symbol as
        // NVENCSTATUS NvEncodeAPIGetMaxSupportedVersion(uint32_t*).
        let get_version: GetMaxSupportedVersion = unsafe { mem::transmute(address) };
        let mut version = 0u32;
        // SAFETY: version is a valid writable DWORD for the documented entrypoint.
        let status = unsafe { get_version(ptr::addr_of_mut!(version)) };
        if status != NV_ENC_SUCCESS {
            return Err(NvencProbeError::VersionQueryFailed);
        }
        decode_nvenc_api_version(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_version_encoding_is_decoded_strictly() {
        assert_eq!(
            decode_nvenc_api_version(13 | (1 << 24)),
            Ok(NvencApiVersion {
                raw: 13 | (1 << 24),
                major: 13,
                minor: 1,
            })
        );
        assert_eq!(
            decode_nvenc_api_version(0),
            Err(NvencProbeError::InvalidVersion)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_probe_fails_closed() {
        assert_eq!(
            query_nvenc_max_supported_version(),
            Err(NvencProbeError::WindowsRequired)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_probe_never_fabricates_success_without_driver_api() {
        match query_nvenc_max_supported_version() {
            Ok(version) => {
                assert!(version.major > 0);
                assert_ne!(version.raw, 0);
            }
            Err(
                NvencProbeError::LibraryMissing
                | NvencProbeError::SymbolMissing
                | NvencProbeError::VersionQueryFailed,
            ) => {}
            Err(other) => panic!("unexpected NVENC probe error: {other:?}"),
        }
    }
}
