//! Safe service-side contract for one GPUbnb-owned IddCx monitor.
//!
//! This module performs no DeviceIoControl call yet. It deliberately defines the
//! identity/mode proof that a future privileged control path must satisfy before a
//! virtual monitor may be plugged in.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualDisplayRequest {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> VirtualDisplayRequest {
        VirtualDisplayRequest {
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
