//! Safe service-side contract for one GPUbnb-owned IddCx monitor.
//!
//! This module performs no DeviceIoControl call yet. It deliberately defines the
//! identity/mode proof that a future privileged control path must satisfy before a
//! virtual monitor may be plugged in.

pub const IDD_CONTROL_VERSION: u32 = 1;
pub const IDD_CONTROL_REQUEST_SIZE: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum VirtualDisplayOperation {
    PlugMonitor = 1,
    UnplugMonitor = 2,
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
    fn qualified_virtual_display_request_is_accepted() {
        assert_eq!(validate_virtual_display_request(valid()), Ok(()));
    }

    #[test]
    fn identity_fields_fail_closed_independently() {
        let cases = [
            (
                VirtualDisplayRequest { generation: 0, ..valid() },
                VirtualDisplayRequestError::Generation,
            ),
            (
                VirtualDisplayRequest { windows_session_id: 0, ..valid() },
                VirtualDisplayRequestError::WindowsSession,
            ),
            (
                VirtualDisplayRequest { render_adapter_luid: 0, ..valid() },
                VirtualDisplayRequestError::RenderAdapter,
            ),
            (
                VirtualDisplayRequest { display_nonce: [0; 16], ..valid() },
                VirtualDisplayRequestError::DisplayNonce,
            ),
        ];
        for (request, expected) in cases {
            assert_eq!(validate_virtual_display_request(request), Err(expected));
        }
    }

    #[test]
    fn absurd_or_tiny_modes_are_rejected() {
        for (width, height) in [(0, 1080), (639, 480), (1920, 479), (7681, 4320), (7680, 4321)] {
            let request = VirtualDisplayRequest { width, height, ..valid() };
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
                validate_virtual_display_request(VirtualDisplayRequest { refresh_hz, ..valid() }),
                Err(VirtualDisplayRequestError::RefreshRate)
            );
        }
    }
}
