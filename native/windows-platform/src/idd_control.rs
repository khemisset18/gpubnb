//! Safe service-side contract for one GPUbnb-owned IddCx monitor.
//!
//! This module defines the fixed control ABI and, on Windows, discovers the
//! GPUbnb IddCx device interface and sends only the inert ValidateOnly probe with DeviceIoControl.

use crate::PlatformError;
use crate::gpu_identity::resolve_nvidia_uuid_to_luid;

pub const IDD_CONTROL_VERSION: u32 = 1;
pub const IDD_CONTROL_REQUEST_SIZE: usize = 64;

// Physical qualification gate mirrored from the UMDF driver. Both sides must
// remain false until an explicitly promoted, physically qualified build.
pub const IDD_MONITOR_MUTATION_ENABLED: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum VirtualDisplayOperation {
    PlugMonitor = 1,
    UnplugMonitor = 2,
    ValidateOnly = 3,
}

pub struct VirtualDisplayLease {
    request: VirtualDisplayRequest,
    #[cfg(target_os = "windows")]
    handle: windows_impl::OwnedControlHandle,
    active: bool,
}

impl VirtualDisplayLease {
    pub const fn request(&self) -> VirtualDisplayRequest {
        self.request
    }

    pub fn close(mut self) -> Result<(), PlatformError> {
        if !self.active {
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            let unplug = VirtualDisplayRequest {
                operation: VirtualDisplayOperation::UnplugMonitor,
                ..self.request
            };
            let wire = encode_virtual_display_request(unplug)
                .map_err(|_| PlatformError::IddControlFailed)?;
            windows_impl::send_control(&self.handle, &wire)?;
            self.active = false;
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(PlatformError::WindowsRequired)
        }
    }
}

impl Drop for VirtualDisplayLease {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        #[cfg(target_os = "windows")]
        {
            let unplug = VirtualDisplayRequest {
                operation: VirtualDisplayOperation::UnplugMonitor,
                ..self.request
            };
            if let Ok(wire) = encode_virtual_display_request(unplug) {
                let _ = windows_impl::send_control(&self.handle, &wire);
            }
            // Even if the explicit unplug fails, dropping the retained control
            // handle triggers the driver's owner-file cleanup backstop.
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualDisplayRequest {
    pub operation: VirtualDisplayOperation,
    pub generation: u64,
    pub windows_session_id: u32,
    pub render_adapter_luid: u64,
    pub display_nonce: [u8; 16],
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VirtualDisplayRequestError {
    Generation,
    WindowsSession,
    RenderAdapter,
    DisplayNonce,
    Dimensions,
    RefreshRate,
}

pub fn display_container_id_from_nonce(
    mut nonce: [u8; 16],
) -> Result<[u8; 16], VirtualDisplayRequestError> {
    if nonce == [0; 16] {
        return Err(VirtualDisplayRequestError::DisplayNonce);
    }

    // Match GPUbnbContainerIdFromNonce in the IddCx driver byte-for-byte.
    // GUID Data3 occupies bytes 6..8 in native little-endian layout; set UUID
    // version 4 in the high nibble. Data4[0] is byte 8; set RFC 4122 variant.
    nonce[7] = (nonce[7] & 0x0f) | 0x40;
    nonce[8] = (nonce[8] & 0x3f) | 0x80;
    Ok(nonce)
}

pub fn validate_virtual_display_request(
    request: VirtualDisplayRequest,
) -> Result<(), VirtualDisplayRequestError> {
    if request.generation == 0 {
        return Err(VirtualDisplayRequestError::Generation);
    }
    if request.windows_session_id == 0 {
        return Err(VirtualDisplayRequestError::WindowsSession);
    }
    if request.render_adapter_luid == 0 {
        return Err(VirtualDisplayRequestError::RenderAdapter);
    }
    if request.display_nonce == [0; 16] {
        return Err(VirtualDisplayRequestError::DisplayNonce);
    }
    if !(640..=7680).contains(&request.width) || !(480..=4320).contains(&request.height) {
        return Err(VirtualDisplayRequestError::Dimensions);
    }
    if !(30..=240).contains(&request.refresh_hz) {
        return Err(VirtualDisplayRequestError::RefreshRate);
    }
    Ok(())
}

pub fn encode_virtual_display_request(
    request: VirtualDisplayRequest,
) -> Result<[u8; IDD_CONTROL_REQUEST_SIZE], VirtualDisplayRequestError> {
    validate_virtual_display_request(request)?;

    let mut out = [0u8; IDD_CONTROL_REQUEST_SIZE];
    out[0..4].copy_from_slice(&(IDD_CONTROL_REQUEST_SIZE as u32).to_le_bytes());
    out[4..8].copy_from_slice(&IDD_CONTROL_VERSION.to_le_bytes());
    out[8..12].copy_from_slice(&(request.operation as u32).to_le_bytes());
    out[12..16].copy_from_slice(&request.windows_session_id.to_le_bytes());
    out[16..24].copy_from_slice(&request.generation.to_le_bytes());
    out[24..32].copy_from_slice(&request.render_adapter_luid.to_le_bytes());
    out[32..48].copy_from_slice(&request.display_nonce);
    out[48..52].copy_from_slice(&request.width.to_le_bytes());
    out[52..56].copy_from_slice(&request.height.to_le_bytes());
    out[56..60].copy_from_slice(&request.refresh_hz.to_le_bytes());
    // 60..64 is reserved and intentionally remains zero.
    Ok(out)
}

pub fn activate_virtual_display_lease(
    gpu_uuid: &str,
    request: VirtualDisplayRequest,
) -> Result<VirtualDisplayLease, PlatformError> {
    if request.operation != VirtualDisplayOperation::PlugMonitor {
        return Err(PlatformError::IddUnsafeOperation);
    }
    if !IDD_MONITOR_MUTATION_ENABLED {
        return Err(PlatformError::IddUnsafeOperation);
    }
    let identity = resolve_nvidia_uuid_to_luid(gpu_uuid)
        .map_err(|_| PlatformError::GpuGraphicsIdentityUnavailable)?;
    if identity.luid != request.render_adapter_luid {
        return Err(PlatformError::GpuGraphicsIdentityMismatch);
    }
    let wire =
        encode_virtual_display_request(request).map_err(|_| PlatformError::IddControlFailed)?;

    #[cfg(target_os = "windows")]
    {
        let handle = windows_impl::open_control()?;
        windows_impl::send_control(&handle, &wire)?;
        Ok(VirtualDisplayLease {
            request,
            handle,
            active: true,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = wire;
        Err(PlatformError::WindowsRequired)
    }
}

pub fn probe_idd_control_contract(request: VirtualDisplayRequest) -> Result<(), PlatformError> {
    if request.operation != VirtualDisplayOperation::ValidateOnly {
        return Err(PlatformError::IddUnsafeOperation);
    }
    let wire =
        encode_virtual_display_request(request).map_err(|_| PlatformError::IddControlFailed)?;

    #[cfg(target_os = "windows")]
    {
        windows_impl::send_validate_only(&wire)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = wire;
        Err(PlatformError::WindowsRequired)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::IDD_CONTROL_REQUEST_SIZE;
    use crate::PlatformError;
    use std::ffi::{OsStr, c_void};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type Handle = isize;

    const CR_SUCCESS: u32 = 0;
    const CM_GET_DEVICE_INTERFACE_LIST_PRESENT: u32 = 0;
    const MAX_INTERFACE_CHARS: u32 = 32_768;
    const INVALID_HANDLE_VALUE: Handle = -1;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const IOCTL_GPUBNB_IDD_CONTROL: u32 = 0x0022_A000;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL: Guid = Guid {
        data1: 0x3f4c6f31,
        data2: 0x4e7c,
        data3: 0x4de7,
        data4: [0x9f, 0xd8, 0x72, 0x18, 0xb3, 0x88, 0x1a, 0x55],
    };

    #[link(name = "cfgmgr32")]
    unsafe extern "system" {
        fn CM_Get_Device_Interface_List_SizeW(
            length: *mut u32,
            interface_class_guid: *const Guid,
            device_id: *const u16,
            flags: u32,
        ) -> u32;
        fn CM_Get_Device_Interface_ListW(
            interface_class_guid: *const Guid,
            device_id: *const u16,
            buffer: *mut u16,
            buffer_len: u32,
            flags: u32,
        ) -> u32;
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
        fn DeviceIoControl(
            device: Handle,
            io_control_code: u32,
            input_buffer: *mut c_void,
            input_buffer_size: u32,
            output_buffer: *mut c_void,
            output_buffer_size: u32,
            bytes_returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    pub(super) struct OwnedControlHandle(Handle);

    impl Drop for OwnedControlHandle {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns a CreateFileW device handle.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn parse_multi_sz(buffer: &[u16]) -> Result<Vec<String>, PlatformError> {
        let mut values = Vec::new();
        let mut start = 0usize;
        while start < buffer.len() {
            let relative_end = buffer[start..]
                .iter()
                .position(|unit| *unit == 0)
                .ok_or(PlatformError::IddInterfaceQueryFailed)?;
            if relative_end == 0 {
                break;
            }
            let end = start + relative_end;
            let value = String::from_utf16(&buffer[start..end])
                .map_err(|_| PlatformError::IddInterfaceQueryFailed)?;
            values.push(value);
            start = end + 1;
        }
        Ok(values)
    }

    fn discover_single_interface() -> Result<String, PlatformError> {
        for _ in 0..3 {
            let mut length = 0u32;
            // SAFETY: length is a valid out pointer; optional device id is null.
            let size_status = unsafe {
                CM_Get_Device_Interface_List_SizeW(
                    &mut length,
                    &GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL,
                    ptr::null(),
                    CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
                )
            };
            if size_status != CR_SUCCESS {
                return Err(PlatformError::IddInterfaceQueryFailed);
            }
            if length <= 1 {
                return Err(PlatformError::IddInterfaceMissing);
            }
            if length > MAX_INTERFACE_CHARS {
                return Err(PlatformError::IddInterfaceQueryFailed);
            }

            let mut buffer = vec![0u16; length as usize];
            // SAFETY: buffer contains exactly length writable UTF-16 elements.
            let list_status = unsafe {
                CM_Get_Device_Interface_ListW(
                    &GUID_DEVINTERFACE_GPUBNB_IDD_CONTROL,
                    ptr::null(),
                    buffer.as_mut_ptr(),
                    length,
                    CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
                )
            };
            if list_status != CR_SUCCESS {
                // The interface set can change between size/list calls. Retry the
                // complete query with a fresh size rather than trusting stale data.
                continue;
            }

            let values = parse_multi_sz(&buffer)?;
            return match values.as_slice() {
                [] => Err(PlatformError::IddInterfaceMissing),
                [only] => Ok(only.clone()),
                _ => Err(PlatformError::IddInterfaceAmbiguous),
            };
        }
        Err(PlatformError::IddInterfaceQueryFailed)
    }

    fn wide(value: &OsStr) -> Result<Vec<u16>, PlatformError> {
        let encoded: Vec<u16> = value.encode_wide().chain(Some(0)).collect();
        if encoded.len() <= 1
            || encoded
                .iter()
                .take(encoded.len() - 1)
                .any(|unit| *unit == 0)
        {
            return Err(PlatformError::IddInterfaceQueryFailed);
        }
        Ok(encoded)
    }

    pub(super) fn open_control() -> Result<OwnedControlHandle, PlatformError> {
        let interface = discover_single_interface()?;
        let wide_interface = wide(OsStr::new(&interface))?;

        // SAFETY: path is NUL-terminated. No handles are inherited and sharing is
        // disabled because the control plane expects one authoritative service.
        let raw = unsafe {
            CreateFileW(
                wide_interface.as_ptr(),
                GENERIC_WRITE,
                0,
                ptr::null_mut(),
                OPEN_EXISTING,
                0,
                0,
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(PlatformError::IddControlOpenFailed);
        }
        Ok(OwnedControlHandle(raw))
    }

    pub(super) fn send_control(
        handle: &OwnedControlHandle,
        wire: &[u8; IDD_CONTROL_REQUEST_SIZE],
    ) -> Result<(), PlatformError> {
        let mut bytes_returned = 0u32;
        // SAFETY: wire is an exact fixed-size input buffer and the IOCTL has no
        // output payload. The call is synchronous and handle remains live.
        let ok = unsafe {
            DeviceIoControl(
                handle.0,
                IOCTL_GPUBNB_IDD_CONTROL,
                wire.as_ptr().cast_mut().cast::<c_void>(),
                IDD_CONTROL_REQUEST_SIZE as u32,
                ptr::null_mut(),
                0,
                &mut bytes_returned,
                ptr::null_mut(),
            )
        };
        if ok == 0 || bytes_returned != 0 {
            return Err(PlatformError::IddControlFailed);
        }
        Ok(())
    }

    pub(super) fn send_validate_only(
        wire: &[u8; IDD_CONTROL_REQUEST_SIZE],
    ) -> Result<(), PlatformError> {
        let handle = open_control()?;
        send_control(&handle, wire)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn multi_sz_parser_requires_unambiguous_entries() {
            let one: Vec<u16> = OsStr::new(r"\\?\gpubnb#control")
                .encode_wide()
                .chain([0, 0])
                .collect();
            assert_eq!(
                parse_multi_sz(&one),
                Ok(vec![r"\\?\gpubnb#control".to_owned()])
            );

            let malformed = vec![b'a' as u16, b'b' as u16];
            assert_eq!(
                parse_multi_sz(&malformed),
                Err(PlatformError::IddInterfaceQueryFailed)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> VirtualDisplayRequest {
        VirtualDisplayRequest {
            operation: VirtualDisplayOperation::PlugMonitor,
            generation: 7,
            windows_session_id: 42,
            render_adapter_luid: 0x1122_3344_5566_7788,
            display_nonce: [0xA5; 16],
            width: 1920,
            height: 1080,
            refresh_hz: 60,
        }
    }

    #[test]
    fn activation_requires_plug_operation() {
        for operation in [
            VirtualDisplayOperation::ValidateOnly,
            VirtualDisplayOperation::UnplugMonitor,
        ] {
            assert_eq!(
                activate_virtual_display_lease("GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", VirtualDisplayRequest {
                    operation,
                    ..valid()
                })
                .err(),
                Some(PlatformError::IddUnsafeOperation)
            );
        }
    }

    #[test]
    fn activation_is_hard_disabled_before_physical_qualification() {
        assert!(!IDD_MONITOR_MUTATION_ENABLED);
        assert_eq!(
            activate_virtual_display_lease("GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", valid()).err(),
            Some(PlatformError::IddUnsafeOperation)
        );
    }

    #[test]
    fn unsafe_operations_are_blocked_before_platform_access() {
        for operation in [
            VirtualDisplayOperation::PlugMonitor,
            VirtualDisplayOperation::UnplugMonitor,
        ] {
            assert_eq!(
                probe_idd_control_contract(VirtualDisplayRequest {
                    operation,
                    ..valid()
                }),
                Err(PlatformError::IddUnsafeOperation)
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn validate_only_probe_fails_closed_off_windows() {
        assert_eq!(
            probe_idd_control_contract(VirtualDisplayRequest {
                operation: VirtualDisplayOperation::ValidateOnly,
                ..valid()
            }),
            Err(PlatformError::WindowsRequired)
        );
    }

    #[test]
    fn container_id_derivation_matches_driver_layout() {
        let nonce = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0xf8, 0xff, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10,
        ];
        let id = display_container_id_from_nonce(nonce).expect("container id");
        assert_eq!(id[0..7], nonce[0..7]);
        assert_eq!(id[7], 0x48);
        assert_eq!(id[8], 0xbf);
        assert_eq!(id[9..], nonce[9..]);
        assert_eq!(
            display_container_id_from_nonce([0; 16]),
            Err(VirtualDisplayRequestError::DisplayNonce)
        );
    }

    #[test]
    fn control_wire_layout_matches_driver_abi() {
        let request = valid();
        let wire = encode_virtual_display_request(request).expect("encode request");
        assert_eq!(wire.len(), 64);
        assert_eq!(u32::from_le_bytes(wire[0..4].try_into().unwrap()), 64);
        assert_eq!(u32::from_le_bytes(wire[4..8].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wire[8..12].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(wire[12..16].try_into().unwrap()),
            request.windows_session_id
        );
        assert_eq!(
            u64::from_le_bytes(wire[16..24].try_into().unwrap()),
            request.generation
        );
        assert_eq!(
            u64::from_le_bytes(wire[24..32].try_into().unwrap()),
            request.render_adapter_luid
        );
        assert_eq!(&wire[32..48], &request.display_nonce);
        assert_eq!(u32::from_le_bytes(wire[48..52].try_into().unwrap()), 1920);
        assert_eq!(u32::from_le_bytes(wire[52..56].try_into().unwrap()), 1080);
        assert_eq!(u32::from_le_bytes(wire[56..60].try_into().unwrap()), 60);
        assert_eq!(&wire[60..64], &[0, 0, 0, 0]);
    }

    #[test]
    fn validate_only_operation_has_distinct_wire_value() {
        let request = VirtualDisplayRequest {
            operation: VirtualDisplayOperation::ValidateOnly,
            ..valid()
        };
        let wire = encode_virtual_display_request(request).expect("encode validate-only");
        assert_eq!(u32::from_le_bytes(wire[8..12].try_into().unwrap()), 3);
    }

    #[test]
    fn qualified_virtual_display_request_is_accepted() {
        assert_eq!(validate_virtual_display_request(valid()), Ok(()));
    }

    #[test]
    fn identity_fields_fail_closed_independently() {
        let cases = [
            (
                VirtualDisplayRequest {
                    generation: 0,
                    ..valid()
                },
                VirtualDisplayRequestError::Generation,
            ),
            (
                VirtualDisplayRequest {
                    windows_session_id: 0,
                    ..valid()
                },
                VirtualDisplayRequestError::WindowsSession,
            ),
            (
                VirtualDisplayRequest {
                    render_adapter_luid: 0,
                    ..valid()
                },
                VirtualDisplayRequestError::RenderAdapter,
            ),
            (
                VirtualDisplayRequest {
                    display_nonce: [0; 16],
                    ..valid()
                },
                VirtualDisplayRequestError::DisplayNonce,
            ),
        ];
        for (request, expected) in cases {
            assert_eq!(validate_virtual_display_request(request), Err(expected));
        }
    }

    #[test]
    fn absurd_or_tiny_modes_are_rejected() {
        for (width, height) in [
            (0, 1080),
            (639, 480),
            (1920, 479),
            (7681, 4320),
            (7680, 4321),
        ] {
            let request = VirtualDisplayRequest {
                width,
                height,
                ..valid()
            };
            assert_eq!(
                validate_virtual_display_request(request),
                Err(VirtualDisplayRequestError::Dimensions)
            );
        }
    }

    #[test]
    fn refresh_rate_is_bounded() {
        for refresh_hz in [0, 29, 241, u32::MAX] {
            assert_eq!(
                validate_virtual_display_request(VirtualDisplayRequest {
                    refresh_hz,
                    ..valid()
                }),
                Err(VirtualDisplayRequestError::RefreshRate)
            );
        }
    }
}
