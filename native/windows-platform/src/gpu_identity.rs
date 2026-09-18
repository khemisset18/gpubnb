//! Exact NVIDIA GPU UUID -> Windows graphics LUID binding.
//!
//! The renter contract names a physical NVIDIA device by immutable GPU UUID.
//! DXGI/IddCx/NVENC bind graphics work by adapter LUID. CUDA exposes both
//! identifiers for the same enumerated device, so this module provides the
//! fail-closed bridge between the two namespaces without trusting ordinal order.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NvidiaGraphicsIdentity {
    pub uuid: [u8; 16],
    pub luid: u64,
    pub node_mask: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuIdentityError {
    WindowsRequired,
    InvalidUuid,
    DriverMissing,
    SymbolMissing,
    DriverInitFailed,
    DeviceEnumerationFailed,
    DeviceQueryFailed,
    DeviceNotFound,
    InvalidLuid,
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub fn parse_nvidia_gpu_uuid(value: &str) -> Result<[u8; 16], GpuIdentityError> {
    if value.len() != 40 || !value.starts_with("GPU-") {
        return Err(GpuIdentityError::InvalidUuid);
    }
    let raw = value.as_bytes();
    for index in [12usize, 17, 22, 27] {
        if raw[index] != b'-' {
            return Err(GpuIdentityError::InvalidUuid);
        }
    }

    let mut compact = [0u8; 32];
    let mut used = 0usize;
    for byte in &raw[4..] {
        if *byte == b'-' {
            continue;
        }
        if used >= compact.len() || hex_nibble(*byte).is_none() {
            return Err(GpuIdentityError::InvalidUuid);
        }
        compact[used] = *byte;
        used += 1;
    }
    if used != compact.len() {
        return Err(GpuIdentityError::InvalidUuid);
    }

    let mut uuid = [0u8; 16];
    for (index, slot) in uuid.iter_mut().enumerate() {
        let high = hex_nibble(compact[index * 2]).ok_or(GpuIdentityError::InvalidUuid)?;
        let low = hex_nibble(compact[index * 2 + 1]).ok_or(GpuIdentityError::InvalidUuid)?;
        *slot = (high << 4) | low;
    }
    Ok(uuid)
}

pub fn resolve_nvidia_uuid_to_luid(
    gpu_uuid: &str,
) -> Result<NvidiaGraphicsIdentity, GpuIdentityError> {
    let uuid = parse_nvidia_gpu_uuid(gpu_uuid)?;
    #[cfg(target_os = "windows")]
    {
        windows_impl::resolve(uuid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = uuid;
        Err(GpuIdentityError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{GpuIdentityError, NvidiaGraphicsIdentity};
    use std::ffi::{c_char, c_void};
    use std::mem;
    use std::ptr;

    type Hmodule = isize;
    type CuResult = i32;
    type CuDevice = i32;
    type CuInit = unsafe extern "system" fn(u32) -> CuResult;
    type CuDeviceGetCount = unsafe extern "system" fn(*mut i32) -> CuResult;
    type CuDeviceGet = unsafe extern "system" fn(*mut CuDevice, i32) -> CuResult;
    type CuDeviceGetUuid = unsafe extern "system" fn(*mut CuUuid, CuDevice) -> CuResult;
    type CuDeviceGetLuid =
        unsafe extern "system" fn(*mut c_char, *mut u32, CuDevice) -> CuResult;

    const CUDA_SUCCESS: CuResult = 0;
    const MAX_CUDA_DEVICES: i32 = 256;
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

    #[repr(C)]
    struct CuUuid {
        bytes: [u8; 16],
    }

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

    unsafe fn symbol<T: Copy>(module: Hmodule, names: &[&[u8]]) -> Result<T, GpuIdentityError> {
        for name in names {
            // SAFETY: module is live and every candidate is a static NUL-terminated symbol.
            let address = unsafe { GetProcAddress(module, name.as_ptr().cast::<c_char>()) };
            if !address.is_null() {
                // SAFETY: caller supplies the documented CUDA function-pointer type.
                return Ok(unsafe { mem::transmute_copy::<*mut c_void, T>(&address) });
            }
        }
        Err(GpuIdentityError::SymbolMissing)
    }

    pub(super) fn resolve(uuid: [u8; 16]) -> Result<NvidiaGraphicsIdentity, GpuIdentityError> {
        let name: Vec<u16> = "nvcuda.dll".encode_utf16().chain(Some(0)).collect();
        // Load only the display-driver copy from System32; never search a renter-writable cwd.
        // SAFETY: name is NUL-terminated and optional file handle is null.
        let raw = unsafe { LoadLibraryExW(name.as_ptr(), 0, LOAD_LIBRARY_SEARCH_SYSTEM32) };
        if raw == 0 {
            return Err(GpuIdentityError::DriverMissing);
        }
        let module = OwnedModule(raw);

        // SAFETY: each requested symbol is called with its documented CUDA ABI.
        let cu_init: CuInit = unsafe { symbol(module.0, &[b"cuInit\0"])? };
        let cu_device_get_count: CuDeviceGetCount =
            unsafe { symbol(module.0, &[b"cuDeviceGetCount\0"])? };
        let cu_device_get: CuDeviceGet = unsafe { symbol(module.0, &[b"cuDeviceGet\0"])? };
        let cu_device_get_uuid: CuDeviceGetUuid = unsafe {
            symbol(
                module.0,
                &[b"cuDeviceGetUuid_v2\0", b"cuDeviceGetUuid\0"],
            )?
        };
        let cu_device_get_luid: CuDeviceGetLuid =
            unsafe { symbol(module.0, &[b"cuDeviceGetLuid\0"])? };

        // SAFETY: zero flags is the documented initialization mode.
        if unsafe { cu_init(0) } != CUDA_SUCCESS {
            return Err(GpuIdentityError::DriverInitFailed);
        }

        let mut count = 0i32;
        // SAFETY: count is a valid writable integer.
        if unsafe { cu_device_get_count(ptr::addr_of_mut!(count)) } != CUDA_SUCCESS
            || !(0..=MAX_CUDA_DEVICES).contains(&count)
        {
            return Err(GpuIdentityError::DeviceEnumerationFailed);
        }

        for ordinal in 0..count {
            let mut device = 0;
            // SAFETY: device is writable and ordinal is bounded by the driver-provided count.
            if unsafe { cu_device_get(ptr::addr_of_mut!(device), ordinal) } != CUDA_SUCCESS {
                return Err(GpuIdentityError::DeviceQueryFailed);
            }

            let mut candidate = CuUuid { bytes: [0; 16] };
            // SAFETY: candidate is exactly the documented 16-byte CUuuid output.
            if unsafe { cu_device_get_uuid(ptr::addr_of_mut!(candidate), device) } != CUDA_SUCCESS {
                return Err(GpuIdentityError::DeviceQueryFailed);
            }
            if candidate.bytes != uuid {
                continue;
            }

            let mut luid = [0u8; 8];
            let mut node_mask = 0u32;
            // SAFETY: CUDA documents an 8-byte LUID output plus a writable node mask.
            if unsafe {
                cu_device_get_luid(
                    luid.as_mut_ptr().cast::<c_char>(),
                    ptr::addr_of_mut!(node_mask),
                    device,
                )
            } != CUDA_SUCCESS
            {
                return Err(GpuIdentityError::DeviceQueryFailed);
            }

            // Windows LUID is an opaque 8-byte graphics identifier. All supported
            // Windows targets are little-endian, matching the u64 wire form used by GPUbnb.
            let luid = u64::from_le_bytes(luid);
            if luid == 0 {
                return Err(GpuIdentityError::InvalidLuid);
            }
            return Ok(NvidiaGraphicsIdentity {
                uuid,
                luid,
                node_mask,
            });
        }

        Err(GpuIdentityError::DeviceNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_gpu_uuid_parses_to_exact_driver_bytes() {
        assert_eq!(
            parse_nvidia_gpu_uuid("GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"),
            Ok([
                0xe8, 0x30, 0x1c, 0x16, 0x2a, 0x14, 0x2b, 0x3f,
                0xf0, 0x57, 0xb2, 0x1f, 0x3b, 0x00, 0x52, 0x4a,
            ])
        );
    }

    #[test]
    fn malformed_or_noncanonical_gpu_uuid_is_rejected() {
        for value in [
            "",
            "GPU-EXACT",
            "gpu-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            "GPU-e8301c162a14-2b3f-f057-b21f3b00524a",
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524z",
        ] {
            assert_eq!(
                parse_nvidia_gpu_uuid(value),
                Err(GpuIdentityError::InvalidUuid)
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn mapping_fails_closed_off_windows() {
        assert_eq!(
            resolve_nvidia_uuid_to_luid("GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"),
            Err(GpuIdentityError::WindowsRequired)
        );
    }
}
