//! Trusted GPUbnb Windows media DLL boundary.
//!
//! The native media DLL owns the one-frame DXGI -> NVENC qualification probe.
//! Rust never accepts a renter-controlled DLL path: production always uses the
//! fixed Program Files location and verifies Authenticode before loading it.

use crate::gpu_identity::parse_nvidia_gpu_uuid;
use crate::open_application_for_verification;
use std::path::Path;

pub const MEDIA_ABI_VERSION: u32 = 1;
pub const MEDIA_REQUEST_SIZE: usize = 64;
pub const MEDIA_RESULT_SIZE: usize = 64;
pub const MEDIA_PROOF_EXACT_GPU: u32 = 1 << 0;
pub const MEDIA_PROOF_DISPLAY_FOUND: u32 = 1 << 1;
pub const MEDIA_PROOF_CAPTURED_FRAME: u32 = 1 << 2;
pub const MEDIA_PROOF_NVENC_BITSTREAM: u32 = 1 << 3;
pub const MEDIA_REQUIRED_PROOFS: u32 = MEDIA_PROOF_EXACT_GPU
    | MEDIA_PROOF_DISPLAY_FOUND
    | MEDIA_PROOF_CAPTURED_FRAME
    | MEDIA_PROOF_NVENC_BITSTREAM;

const TRUSTED_MEDIA_DLL: &str = r"C:\Program Files\GPUbnb\GPUbnbWindowsMedia.dll";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaProbeRequest<'a> {
    pub gpu_uuid: &'a str,
    pub adapter_luid: u64,
    pub display_nonce: [u8; 16],
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub capture_timeout_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaProbeResult {
    pub proof_flags: u32,
    pub failed_stage: u32,
    pub adapter_luid: u64,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub encoded_bytes: u32,
    pub frame_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaProbeError {
    WindowsRequired,
    InvalidRequest,
    DllUnavailable,
    DllUntrusted,
    SymbolMissing,
    ProbeFailed,
    InvalidResult,
    MissingProof,
}

fn encode_request(request: MediaProbeRequest<'_>) -> Result<[u8; MEDIA_REQUEST_SIZE], MediaProbeError> {
    if request.adapter_luid == 0
        || request.display_nonce == [0; 16]
        || !(640..=7680).contains(&request.width)
        || !(480..=4320).contains(&request.height)
        || !(30..=240).contains(&request.refresh_hz)
        || request.capture_timeout_ms == 0
        || request.capture_timeout_ms > 30_000
    {
        return Err(MediaProbeError::InvalidRequest);
    }
    let uuid = parse_nvidia_gpu_uuid(request.gpu_uuid)
        .map_err(|_| MediaProbeError::InvalidRequest)?;

    let mut wire = [0u8; MEDIA_REQUEST_SIZE];
    wire[0..4].copy_from_slice(&(MEDIA_REQUEST_SIZE as u32).to_le_bytes());
    wire[4..8].copy_from_slice(&MEDIA_ABI_VERSION.to_le_bytes());
    wire[8..16].copy_from_slice(&request.adapter_luid.to_le_bytes());
    wire[16..32].copy_from_slice(&uuid);
    wire[32..48].copy_from_slice(&request.display_nonce);
    wire[48..52].copy_from_slice(&request.width.to_le_bytes());
    wire[52..56].copy_from_slice(&request.height.to_le_bytes());
    wire[56..60].copy_from_slice(&request.refresh_hz.to_le_bytes());
    wire[60..64].copy_from_slice(&request.capture_timeout_ms.to_le_bytes());
    Ok(wire)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, MediaProbeError> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or(MediaProbeError::InvalidResult)?
        .try_into()
        .map_err(|_| MediaProbeError::InvalidResult)?;
    Ok(u32::from_le_bytes(raw))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, MediaProbeError> {
    let raw: [u8; 8] = bytes
        .get(offset..offset + 8)
        .ok_or(MediaProbeError::InvalidResult)?
        .try_into()
        .map_err(|_| MediaProbeError::InvalidResult)?;
    Ok(u64::from_le_bytes(raw))
}

fn decode_result(
    wire: &[u8; MEDIA_RESULT_SIZE],
    expected: MediaProbeRequest<'_>,
) -> Result<MediaProbeResult, MediaProbeError> {
    if read_u32(wire, 0)? != MEDIA_RESULT_SIZE as u32
        || read_u32(wire, 4)? != MEDIA_ABI_VERSION
    {
        return Err(MediaProbeError::InvalidResult);
    }

    let result = MediaProbeResult {
        proof_flags: read_u32(wire, 8)?,
        failed_stage: read_u32(wire, 12)?,
        adapter_luid: read_u64(wire, 16)?,
        width: read_u32(wire, 24)?,
        height: read_u32(wire, 28)?,
        refresh_hz: read_u32(wire, 32)?,
        encoded_bytes: read_u32(wire, 36)?,
        frame_sequence: read_u64(wire, 40)?,
    };

    if result.failed_stage != 0
        || result.adapter_luid != expected.adapter_luid
        || result.width != expected.width
        || result.height != expected.height
        || result.refresh_hz != expected.refresh_hz
        || result.frame_sequence == 0
        || result.encoded_bytes == 0
    {
        return Err(MediaProbeError::InvalidResult);
    }
    if result.proof_flags & MEDIA_REQUIRED_PROOFS != MEDIA_REQUIRED_PROOFS {
        return Err(MediaProbeError::MissingProof);
    }
    Ok(result)
}

pub fn probe_media_frame(request: MediaProbeRequest<'_>) -> Result<MediaProbeResult, MediaProbeError> {
    let wire = encode_request(request)?;

    #[cfg(target_os = "windows")]
    {
        windows_impl::probe_media_frame(&wire, request)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = wire;
        Err(MediaProbeError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::ffi::{c_char, c_void};
    use std::mem;
    use std::os::windows::ffi::OsStrExt;

    type Hmodule = isize;
    type Hresult = i32;
    type ProbeFn = unsafe extern "system" fn(*const c_void, *mut c_void) -> Hresult;

    const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
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
                // SAFETY: this wrapper uniquely owns the loaded DLL module.
                unsafe {
                    let _ = FreeLibrary(self.0);
                }
            }
        }
    }

    pub(super) fn probe_media_frame(
        wire: &[u8; MEDIA_REQUEST_SIZE],
        expected: MediaProbeRequest<'_>,
    ) -> Result<MediaProbeResult, MediaProbeError> {
        let path = Path::new(TRUSTED_MEDIA_DLL);
        let verified =
            open_application_for_verification(path).map_err(|_| MediaProbeError::DllUnavailable)?;
        let allowed_signer = trusted_media_signer()?;
        verified
            .verify_signer_allowed_sha256(&[allowed_signer])
            .map_err(|_| MediaProbeError::DllUntrusted)?;

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: path is fixed, absolute and NUL-terminated. Resolution is
        // restricted to the DLL directory and System32 for its dependencies.
        let raw = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                0,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if raw == 0 {
            return Err(MediaProbeError::DllUnavailable);
        }
        let module = OwnedModule(raw);

        const SYMBOL: &[u8] = b"GPUbnbProbeMediaFrame\0";
        // SAFETY: module is live and SYMBOL is static/NUL-terminated.
        let address = unsafe { GetProcAddress(module.0, SYMBOL.as_ptr().cast::<c_char>()) };
        if address.is_null() {
            return Err(MediaProbeError::SymbolMissing);
        }
        // SAFETY: the DLL ABI is pinned by Media.h and the exported stdcall symbol.
        let probe: ProbeFn = unsafe { mem::transmute(address) };

        let mut result = [0u8; MEDIA_RESULT_SIZE];
        // SAFETY: input/output buffers are exactly the fixed 64-byte ABI sizes.
        let hr = unsafe {
            probe(
                wire.as_ptr().cast::<c_void>(),
                result.as_mut_ptr().cast::<c_void>(),
            )
        };
        if hr < 0 {
            return Err(MediaProbeError::ProbeFailed);
        }
        decode_result(&result, expected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPU: &str = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a";

    fn request() -> MediaProbeRequest<'static> {
        MediaProbeRequest {
            gpu_uuid: GPU,
            adapter_luid: 0x1122_3344_5566_7788,
            display_nonce: [0xA5; 16],
            width: 1920,
            height: 1080,
            refresh_hz: 60,
            capture_timeout_ms: 5_000,
        }
    }

    #[test]
    fn signer_policy_is_fail_closed_when_missing_or_malformed() {
        match TRUSTED_MEDIA_SIGNER_SHA256_HEX {
            None => assert_eq!(trusted_media_signer(), Err(MediaProbeError::DllUntrusted)),
            Some(value) if value.len() != 64 => {
                assert_eq!(trusted_media_signer(), Err(MediaProbeError::DllUntrusted))
            }
            Some(_) => assert!(trusted_media_signer().is_ok()),
        }
    }

    #[test]
    fn request_wire_matches_cpp_abi() {
        let wire = encode_request(request()).expect("valid media request");
        assert_eq!(wire.len(), 64);
        assert_eq!(&wire[0..4], &64u32.to_le_bytes());
        assert_eq!(&wire[4..8], &1u32.to_le_bytes());
        assert_eq!(&wire[8..16], &0x1122_3344_5566_7788u64.to_le_bytes());
        assert_eq!(&wire[48..52], &1920u32.to_le_bytes());
        assert_eq!(&wire[52..56], &1080u32.to_le_bytes());
        assert_eq!(&wire[56..60], &60u32.to_le_bytes());
    }

    #[test]
    fn result_requires_all_identity_and_encode_proofs() {
        let expected = request();
        let mut wire = [0u8; MEDIA_RESULT_SIZE];
        wire[0..4].copy_from_slice(&64u32.to_le_bytes());
        wire[4..8].copy_from_slice(&MEDIA_ABI_VERSION.to_le_bytes());
        wire[8..12].copy_from_slice(&MEDIA_REQUIRED_PROOFS.to_le_bytes());
        wire[16..24].copy_from_slice(&expected.adapter_luid.to_le_bytes());
        wire[24..28].copy_from_slice(&expected.width.to_le_bytes());
        wire[28..32].copy_from_slice(&expected.height.to_le_bytes());
        wire[32..36].copy_from_slice(&expected.refresh_hz.to_le_bytes());
        wire[36..40].copy_from_slice(&4096u32.to_le_bytes());
        wire[40..48].copy_from_slice(&1u64.to_le_bytes());

        let result = decode_result(&wire, expected).expect("valid proof");
        assert_eq!(result.encoded_bytes, 4096);
        assert_eq!(result.frame_sequence, 1);

        wire[8..12].copy_from_slice(&(MEDIA_REQUIRED_PROOFS & !MEDIA_PROOF_NVENC_BITSTREAM).to_le_bytes());
        assert_eq!(
            decode_result(&wire, expected),
            Err(MediaProbeError::MissingProof)
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_probe_fails_closed() {
        assert_eq!(
            probe_media_frame(request()),
            Err(MediaProbeError::WindowsRequired)
        );
    }
}
