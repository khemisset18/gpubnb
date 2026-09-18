//! Strong identity linkage for Windows virtual-display -> DXGI -> NVENC proof.
//!
//! Boolean readiness flags alone are insufficient: every stage must refer to the
//! same renter generation, WTS session, virtual display and render adapter, and
//! the encoded output must come from the exact captured frame on the leased GPU.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Bgra8Unorm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodeCodec {
    H264,
    Hevc,
    Av1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualDisplayProof {
    pub generation: u64,
    pub windows_session_id: u32,
    pub display_nonce: [u8; 16],
    pub adapter_luid: u64,
    pub provider_desktop_excluded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureFrameProof {
    pub generation: u64,
    pub windows_session_id: u32,
    pub display_nonce: [u8; 16],
    pub adapter_luid: u64,
    pub frame_sequence: u64,
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NvencProof {
    pub generation: u64,
    pub adapter_luid: u64,
    pub gpu_uuid: String,
    pub input_frame_sequence: u64,
    pub codec: EncodeCodec,
    pub encoded_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphicsProofError {
    Generation,
    WindowsSession,
    DisplayIdentity,
    Adapter,
    ProviderDesktop,
    Frame,
    Dimensions,
    PixelFormat,
    Gpu,
    EncodedOutput,
}

fn canonical_gpu_uuid(value: &str) -> bool {
    if !value.starts_with("GPU-") {
        return false;
    }
    let uuid = &value[4..];
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| {
            let hyphen = matches!(index, 8 | 13 | 18 | 23);
            (hyphen && byte == b'-') || (!hyphen && byte.is_ascii_hexdigit())
        })
}

pub fn validate_graphics_proof_chain(
    expected_generation: u64,
    expected_windows_session_id: u32,
    expected_gpu_uuid: &str,
    display: VirtualDisplayProof,
    capture: CaptureFrameProof,
    encode: &NvencProof,
) -> Result<(), GraphicsProofError> {
    if expected_generation == 0
        || display.generation != expected_generation
        || capture.generation != expected_generation
        || encode.generation != expected_generation
    {
        return Err(GraphicsProofError::Generation);
    }
    if expected_windows_session_id == 0
        || display.windows_session_id != expected_windows_session_id
        || capture.windows_session_id != expected_windows_session_id
    {
        return Err(GraphicsProofError::WindowsSession);
    }
    if display.display_nonce == [0; 16] || capture.display_nonce != display.display_nonce {
        return Err(GraphicsProofError::DisplayIdentity);
    }
    if display.adapter_luid == 0
        || capture.adapter_luid != display.adapter_luid
        || encode.adapter_luid != display.adapter_luid
    {
        return Err(GraphicsProofError::Adapter);
    }
    if !display.provider_desktop_excluded {
        return Err(GraphicsProofError::ProviderDesktop);
    }
    if capture.frame_sequence == 0 || encode.input_frame_sequence != capture.frame_sequence {
        return Err(GraphicsProofError::Frame);
    }
    if capture.width == 0 || capture.height == 0 {
        return Err(GraphicsProofError::Dimensions);
    }
    if capture.format != PixelFormat::Bgra8Unorm {
        return Err(GraphicsProofError::PixelFormat);
    }
    if !canonical_gpu_uuid(expected_gpu_uuid)
        || !encode.gpu_uuid.eq_ignore_ascii_case(expected_gpu_uuid)
    {
        return Err(GraphicsProofError::Gpu);
    }
    if encode.encoded_bytes == 0 {
        return Err(GraphicsProofError::EncodedOutput);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPU: &str = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a";
    const NONCE: [u8; 16] = [0xA5; 16];

    fn display() -> VirtualDisplayProof {
        VirtualDisplayProof {
            generation: 7,
            windows_session_id: 42,
            display_nonce: NONCE,
            adapter_luid: 0x1122_3344_5566_7788,
            provider_desktop_excluded: true,
        }
    }

    fn capture() -> CaptureFrameProof {
        CaptureFrameProof {
            generation: 7,
            windows_session_id: 42,
            display_nonce: NONCE,
            adapter_luid: 0x1122_3344_5566_7788,
            frame_sequence: 11,
            width: 1920,
            height: 1080,
            format: PixelFormat::Bgra8Unorm,
        }
    }

    fn encode() -> NvencProof {
        NvencProof {
            generation: 7,
            adapter_luid: 0x1122_3344_5566_7788,
            gpu_uuid: GPU.to_owned(),
            input_frame_sequence: 11,
            codec: EncodeCodec::H264,
            encoded_bytes: 4096,
        }
    }

    #[test]
    fn exact_display_capture_encode_chain_is_accepted() {
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture(), &encode()),
            Ok(())
        );
    }

    #[test]
    fn cross_display_capture_is_rejected() {
        let mut capture = capture();
        capture.display_nonce[0] ^= 1;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture, &encode()),
            Err(GraphicsProofError::DisplayIdentity)
        );
    }

    #[test]
    fn cross_adapter_or_gpu_encode_is_rejected() {
        let mut encode = encode();
        encode.adapter_luid += 1;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture(), &encode),
            Err(GraphicsProofError::Adapter)
        );

        let mut encode = encode();
        encode.gpu_uuid = "GPU-11111111-1111-1111-1111-111111111111".to_owned();
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture(), &encode),
            Err(GraphicsProofError::Gpu)
        );
    }

    #[test]
    fn stale_generation_or_wrong_wts_session_is_rejected() {
        let mut display = display();
        display.generation = 6;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display, capture(), &encode()),
            Err(GraphicsProofError::Generation)
        );

        let mut capture = capture();
        capture.windows_session_id = 43;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture, &encode()),
            Err(GraphicsProofError::WindowsSession)
        );
    }

    #[test]
    fn provider_desktop_and_empty_encode_fail_closed() {
        let mut display = display();
        display.provider_desktop_excluded = false;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display, capture(), &encode()),
            Err(GraphicsProofError::ProviderDesktop)
        );

        let mut encode = encode();
        encode.encoded_bytes = 0;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture(), &encode),
            Err(GraphicsProofError::EncodedOutput)
        );
    }

    #[test]
    fn encoded_frame_must_be_the_exact_captured_frame() {
        let mut encode = encode();
        encode.input_frame_sequence += 1;
        assert_eq!(
            validate_graphics_proof_chain(7, 42, GPU, display(), capture(), &encode),
            Err(GraphicsProofError::Frame)
        );
    }
}
