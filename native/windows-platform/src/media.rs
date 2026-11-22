//! Trusted GPUbnb Windows media DLL boundary.
//!
//! The native media DLL owns the exact-monitor capture -> exact-NVIDIA D3D11
//! copy -> NVENC qualification path. Rust never accepts a renter-controlled DLL
//! path: production always uses the fixed Program Files location and verifies
//! Authenticode before loading it.

use crate::gpu_identity::parse_nvidia_gpu_uuid;
#[cfg(target_os = "windows")]
use crate::open_application_for_verification;
#[cfg(target_os = "windows")]
use std::path::Path;

pub const MEDIA_ABI_VERSION: u32 = 2;
// This ABI is deliberately independent from the IddCx/virtualDisplay contract.
// No production caller may treat its proof_flags as MEDIA_REQUIRED_PROOFS.
pub const CONSOLE_MEDIA_ABI_VERSION: u32 = 3;
pub const CONSOLE_MEDIA_REQUEST_SIZE: usize = 80;
pub const CONSOLE_MEDIA_FRAME_RESULT_SIZE: usize = 64;
pub const CONSOLE_MEDIA_REQUIRED_PROOFS: u32 = 0x0f;
pub const MEDIA_REQUEST_SIZE: usize = 64;
pub const MEDIA_RESULT_SIZE: usize = 64;
pub const MEDIA_FRAME_RESULT_SIZE: usize = 64;
pub const MEDIA_DIAGNOSTIC_SIZE: usize = 64;
pub const MEDIA_DIAGNOSTIC_VERSION: u32 = 1;
pub const MAX_ENCODED_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MEDIA_PROOF_EXACT_GPU: u32 = 1 << 0;
pub const MEDIA_PROOF_DISPLAY_FOUND: u32 = 1 << 1;
pub const MEDIA_PROOF_CAPTURED_FRAME: u32 = 1 << 2;
pub const MEDIA_PROOF_NVENC_BITSTREAM: u32 = 1 << 3;
pub const MEDIA_FRAME_FLAG_KEYFRAME: u32 = 1 << 0;
pub const AUDIO_CAPTURE_ABI_VERSION: u32 = 1;
pub const AUDIO_CAPTURE_REQUEST_SIZE: usize = 32;
pub const AUDIO_PACKET_RESULT_SIZE: usize = 64;
pub const MAX_AUDIO_PACKET_BYTES: usize = 512 * 1024;
pub const MEDIA_REQUIRED_PROOFS: u32 = MEDIA_PROOF_EXACT_GPU
    | MEDIA_PROOF_DISPLAY_FOUND
    | MEDIA_PROOF_CAPTURED_FRAME
    | MEDIA_PROOF_NVENC_BITSTREAM;

#[cfg(target_os = "windows")]
const TRUSTED_MEDIA_DLL: &str = r"C:\Program Files\GPUbnb\GPUbnbWindowsMedia.dll";

#[cfg(any(target_os = "windows", test))]
const TRUSTED_MEDIA_SIGNER_SHA256_HEX: Option<&str> =
    option_env!("GPUBNB_WINDOWS_MEDIA_SIGNER_SHA256");

#[cfg(any(target_os = "windows", test))]
fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(any(target_os = "windows", test))]
fn trusted_media_signer() -> Result<[u8; 32], MediaProbeError> {
    let value = TRUSTED_MEDIA_SIGNER_SHA256_HEX.ok_or(MediaProbeError::DllUntrusted)?;
    if value.len() != 64 {
        return Err(MediaProbeError::DllUntrusted);
    }
    let bytes = value.as_bytes();
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        let high = hex_nibble(bytes[index * 2]).ok_or(MediaProbeError::DllUntrusted)?;
        let low = hex_nibble(bytes[index * 2 + 1]).ok_or(MediaProbeError::DllUntrusted)?;
        *slot = (high << 4) | low;
    }
    if out == [0; 32] {
        return Err(MediaProbeError::DllUntrusted);
    }
    Ok(out)
}

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
pub struct MediaFailureDiagnostic {
    pub failed_stage: u32,
    pub hresult: i32,
    pub nvenc_status: i32,
    pub proof_flags: u32,
    pub adapter_luid: u64,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
}

// Encoded renter pixels are deliberately neither Debug nor Clone: diagnostics
// must not accidentally print or duplicate H.264 payloads.
pub struct EncodedMediaFrame {
    pub bytes: Vec<u8>,
    pub frame_sequence: u64,
    pub proof_flags: u32,
    pub frame_flags: u32,
    pub adapter_luid: u64,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
}

impl EncodedMediaFrame {
    pub const fn is_keyframe(&self) -> bool {
        self.frame_flags & MEDIA_FRAME_FLAG_KEYFRAME != 0
    }
}

/// Driverless console WGC+NVENC proof. Distinct type prevents accidental
/// promotion to an IddCx virtual-display / browser READY proof.
pub struct ConsoleMediaSession {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    expected: ConsoleMediaProbeRequestOwned,
    #[cfg(target_os = "windows")]
    inner: windows_impl::PersistentSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConsoleMediaProbeRequest<'a> {
    pub gpu_uuid: &'a str,
    pub adapter_luid: u64,
    pub windows_session_id: u32,
    pub session_nonce: [u8; 16],
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub capture_timeout_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ConsoleMediaProbeRequestOwned {
    adapter_luid: u64,
    windows_session_id: u32,
    width: u32,
    height: u32,
    refresh_hz: u32,
}

pub struct ConsoleEncodedMediaFrame {
    pub bytes: Vec<u8>,
    pub frame_sequence: u64,
    pub proof_flags: u32,
    pub frame_flags: u32,
    pub adapter_luid: u64,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
}

impl ConsoleMediaSession {
    pub fn read_frame(&mut self) -> Result<ConsoleEncodedMediaFrame, MediaProbeError> {
        #[cfg(target_os = "windows")]
        {
            windows_impl::read_console_frame(&mut self.inner, self.expected)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(MediaProbeError::WindowsRequired)
        }
    }
}

pub struct MediaSession {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    expected: MediaProbeRequestOwned,
    #[cfg(target_os = "windows")]
    inner: windows_impl::PersistentSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MediaProbeRequestOwned {
    adapter_luid: u64,
    display_nonce: [u8; 16],
    width: u32,
    height: u32,
    refresh_hz: u32,
    capture_timeout_ms: u32,
}

impl MediaSession {
    pub fn read_frame(&mut self) -> Result<EncodedMediaFrame, MediaProbeError> {
        #[cfg(target_os = "windows")]
        {
            windows_impl::read_persistent_frame(&mut self.inner, self.expected)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(MediaProbeError::WindowsRequired)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaProbeError {
    WindowsRequired,
    InvalidRequest,
    DllUnavailable,
    DllUntrusted,
    SymbolMissing,
    ProbeFailed,
    CaptureTimeout,
    CaptureAccessLost,
    DeviceLost,
    InvalidResult,
    MissingProof,
    Diagnostic(MediaFailureDiagnostic),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioCaptureRequest {
    pub windows_session_id: u32,
    pub target_process_id: u32,
    pub read_timeout_ms: u32,
    /// FILETIME creation timestamp (100 ns units since 1601-01-01 UTC) from
    /// the process handle returned by the authorized game launcher.
    pub target_process_creation_time_100ns: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSampleFormat {
    IeeeFloat32,
    PcmUint8,
    PcmInt16,
    PcmInt24,
    PcmInt32,
}

impl AudioSampleFormat {
    const fn bytes_per_sample(self) -> usize {
        match self {
            Self::IeeeFloat32 | Self::PcmInt32 => 4,
            Self::PcmUint8 => 1,
            Self::PcmInt16 => 2,
            Self::PcmInt24 => 3,
        }
    }

    fn from_abi(value: u16) -> Result<Self, MediaProbeError> {
        match value {
            1 => Ok(Self::IeeeFloat32),
            2 => Ok(Self::PcmUint8),
            3 => Ok(Self::PcmInt16),
            4 => Ok(Self::PcmInt24),
            5 => Ok(Self::PcmInt32),
            _ => Err(MediaProbeError::InvalidResult),
        }
    }
}

/// One bounded renter-process PCM packet. Raw samples are intentionally not
/// Debug/Clone so logs cannot accidentally include captured game audio.
pub struct AudioPacket {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: AudioSampleFormat,
    pub frames: u32,
    pub device_position_frames: u64,
    pub qpc_position_100ns: u64,
    pub silent: bool,
    pub discontinuity: bool,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AudioCaptureIdentity {
    windows_session_id: u32,
    target_process_id: u32,
}

/// Process-scoped WASAPI capture loaded only from the fixed, signer-verified
/// GPUbnb media DLL. It never opens the system-wide output mix.
pub struct AudioCaptureSession {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    expected: AudioCaptureIdentity,
    #[cfg(target_os = "windows")]
    inner: windows_impl::PersistentAudioSession,
}

impl AudioCaptureSession {
    pub fn open(request: AudioCaptureRequest) -> Result<Self, MediaProbeError> {
        let wire = encode_audio_capture_request(request)?;
        let expected = AudioCaptureIdentity {
            windows_session_id: request.windows_session_id,
            target_process_id: request.target_process_id,
        };
        #[cfg(target_os = "windows")]
        {
            let inner = windows_impl::open_audio_capture_session(&wire, expected)?;
            Ok(Self { expected, inner })
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (wire, expected);
            Err(MediaProbeError::WindowsRequired)
        }
    }

    /// Returns `None` when WASAPI has no complete packet before its short read
    /// deadline. Any target/session/format failure is an error; callers must
    /// revoke audio instead of falling back to the owner's output mix.
    pub fn read_packet(&mut self) -> Result<Option<AudioPacket>, MediaProbeError> {
        #[cfg(target_os = "windows")]
        {
            windows_impl::read_audio_capture_packet(&mut self.inner, self.expected)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(MediaProbeError::WindowsRequired)
        }
    }

    /// Stops the process-loopback client on its owning worker thread and
    /// reports failure to the session lifecycle instead of hiding it in Drop.
    pub fn close(self) -> Result<(), MediaProbeError> {
        #[cfg(target_os = "windows")]
        {
            let mut session = self;
            windows_impl::close_audio_capture_session(&mut session.inner)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = self;
            Err(MediaProbeError::WindowsRequired)
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn encode_audio_capture_request(
    request: AudioCaptureRequest,
) -> Result<[u8; AUDIO_CAPTURE_REQUEST_SIZE], MediaProbeError> {
    if request.windows_session_id == 0
        || request.target_process_id == 0
        || !(10..=150).contains(&request.read_timeout_ms)
        || request.target_process_creation_time_100ns == 0
    {
        return Err(MediaProbeError::InvalidRequest);
    }
    let mut wire = [0u8; AUDIO_CAPTURE_REQUEST_SIZE];
    wire[0..4].copy_from_slice(&(AUDIO_CAPTURE_REQUEST_SIZE as u32).to_le_bytes());
    wire[4..8].copy_from_slice(&AUDIO_CAPTURE_ABI_VERSION.to_le_bytes());
    wire[8..12].copy_from_slice(&request.windows_session_id.to_le_bytes());
    wire[12..16].copy_from_slice(&request.target_process_id.to_le_bytes());
    wire[16..20].copy_from_slice(&request.read_timeout_ms.to_le_bytes());
    // 20..24 is the strict-zero reserved field.
    wire[24..32].copy_from_slice(&request.target_process_creation_time_100ns.to_le_bytes());
    Ok(wire)
}

#[cfg(any(target_os = "windows", test))]
fn decode_audio_packet(
    result: &[u8; AUDIO_PACKET_RESULT_SIZE],
    payload: &[u8],
    expected: AudioCaptureIdentity,
) -> Result<AudioPacket, MediaProbeError> {
    if read_u32(result, 0)? != AUDIO_PACKET_RESULT_SIZE as u32
        || read_u32(result, 4)? != AUDIO_CAPTURE_ABI_VERSION
        || read_u32(result, 8)? != expected.windows_session_id
        || read_u32(result, 12)? != expected.target_process_id
    {
        return Err(MediaProbeError::InvalidResult);
    }
    let sample_rate = read_u32(result, 16)?;
    let channels = u16::from_le_bytes([result[20], result[21]]);
    let sample_format = AudioSampleFormat::from_abi(u16::from_le_bytes([result[22], result[23]]))?;
    let frames = read_u32(result, 24)?;
    let payload_bytes = read_u32(result, 28)? as usize;
    let device_position_frames = read_u64(result, 32)?;
    let qpc_position_100ns = read_u64(result, 40)?;
    let flags = read_u32(result, 48)?;
    let expected_bytes = (frames as usize)
        .checked_mul(channels as usize)
        .and_then(|value| value.checked_mul(sample_format.bytes_per_sample()))
        .ok_or(MediaProbeError::InvalidResult)?;
    if !(8_000..=192_000).contains(&sample_rate)
        || !(1..=8).contains(&channels)
        || frames == 0
        || payload_bytes == 0
        || payload_bytes > MAX_AUDIO_PACKET_BYTES
        || payload_bytes != expected_bytes
        || payload.len() != payload_bytes
        || flags & !0x03 != 0
        || (52..64).step_by(4).any(|offset| read_u32(result, offset).ok() != Some(0))
    {
        return Err(MediaProbeError::InvalidResult);
    }
    let silent = flags & 0x01 != 0;
    let discontinuity = flags & 0x02 != 0;
    if silent {
        let silence_sample = if sample_format == AudioSampleFormat::PcmUint8 {
            0x80
        } else {
            0
        };
        if payload.iter().any(|byte| *byte != silence_sample) {
            return Err(MediaProbeError::InvalidResult);
        }
    }
    Ok(AudioPacket {
        sample_rate,
        channels,
        sample_format,
        frames,
        device_position_frames,
        qpc_position_100ns,
        silent,
        discontinuity,
        bytes: payload.to_vec(),
    })
}

#[cfg(any(target_os = "windows", test))]
fn classify_probe_hresult(hr: i32) -> MediaProbeError {
    // DXGI HRESULT values are stable Win32 ABI constants. Keep the mapping here
    // so higher layers can revoke only the proofs affected by the failure.
    match hr as u32 {
        0x887A0027 => MediaProbeError::CaptureTimeout, // DXGI_ERROR_WAIT_TIMEOUT
        0x887A0026 => MediaProbeError::CaptureAccessLost, // DXGI_ERROR_ACCESS_LOST
        0x887A0005..=0x887A0007 => MediaProbeError::DeviceLost, // REMOVED / HUNG / RESET
        _ => MediaProbeError::ProbeFailed,
    }
}

fn encode_request(
    request: MediaProbeRequest<'_>,
) -> Result<[u8; MEDIA_REQUEST_SIZE], MediaProbeError> {
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
    let uuid =
        parse_nvidia_gpu_uuid(request.gpu_uuid).map_err(|_| MediaProbeError::InvalidRequest)?;

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

#[cfg(any(target_os = "windows", test))]
fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, MediaProbeError> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or(MediaProbeError::InvalidResult)?
        .try_into()
        .map_err(|_| MediaProbeError::InvalidResult)?;
    Ok(u32::from_le_bytes(raw))
}

#[cfg(any(target_os = "windows", test))]
fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, MediaProbeError> {
    let raw: [u8; 8] = bytes
        .get(offset..offset + 8)
        .ok_or(MediaProbeError::InvalidResult)?
        .try_into()
        .map_err(|_| MediaProbeError::InvalidResult)?;
    Ok(u64::from_le_bytes(raw))
}

#[cfg(any(target_os = "windows", test))]
fn decode_diagnostic(
    wire: &[u8; MEDIA_DIAGNOSTIC_SIZE],
    expected: MediaProbeRequestOwned,
) -> Result<MediaFailureDiagnostic, MediaProbeError> {
    if read_u32(wire, 0)? != MEDIA_DIAGNOSTIC_SIZE as u32
        || read_u32(wire, 4)? != MEDIA_DIAGNOSTIC_VERSION
    {
        return Err(MediaProbeError::InvalidResult);
    }

    let failed_stage = read_u32(wire, 8)?;
    let hresult = read_u32(wire, 12)? as i32;
    let nvenc_status = read_u32(wire, 16)? as i32;
    let proof_flags = read_u32(wire, 20)?;
    let adapter_luid = read_u64(wire, 24)?;
    let width = read_u32(wire, 32)?;
    let height = read_u32(wire, 36)?;
    let refresh_hz = read_u32(wire, 40)?;

    if !(1..=9).contains(&failed_stage)
        || hresult >= 0
        || proof_flags & !MEDIA_REQUIRED_PROOFS != 0
        || adapter_luid != expected.adapter_luid
        || width != expected.width
        || height != expected.height
        || refresh_hz != expected.refresh_hz
    {
        return Err(MediaProbeError::InvalidResult);
    }
    for offset in [44usize, 48, 52, 56, 60] {
        if read_u32(wire, offset)? != 0 {
            return Err(MediaProbeError::InvalidResult);
        }
    }

    Ok(MediaFailureDiagnostic {
        failed_stage,
        hresult,
        nvenc_status,
        proof_flags,
        adapter_luid,
        width,
        height,
        refresh_hz,
    })
}

#[cfg(any(target_os = "windows", test))]
fn decode_result(
    wire: &[u8; MEDIA_RESULT_SIZE],
    expected: MediaProbeRequest<'_>,
) -> Result<MediaProbeResult, MediaProbeError> {
    if read_u32(wire, 0)? != MEDIA_RESULT_SIZE as u32 || read_u32(wire, 4)? != MEDIA_ABI_VERSION {
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

fn encode_console_request(
    request: ConsoleMediaProbeRequest<'_>,
) -> Result<[u8; CONSOLE_MEDIA_REQUEST_SIZE], MediaProbeError> {
    if request.adapter_luid == 0
        || request.windows_session_id == 0
        || request.windows_session_id == u32::MAX
        || request.session_nonce == [0; 16]
        || !(640..=7680).contains(&request.width)
        || !(480..=4320).contains(&request.height)
        || !(30..=240).contains(&request.refresh_hz)
        || request.capture_timeout_ms == 0
        || request.capture_timeout_ms > 30_000
    {
        return Err(MediaProbeError::InvalidRequest);
    }
    let uuid =
        parse_nvidia_gpu_uuid(request.gpu_uuid).map_err(|_| MediaProbeError::InvalidRequest)?;
    let mut wire = [0u8; CONSOLE_MEDIA_REQUEST_SIZE];
    wire[0..4].copy_from_slice(&(CONSOLE_MEDIA_REQUEST_SIZE as u32).to_le_bytes());
    wire[4..8].copy_from_slice(&CONSOLE_MEDIA_ABI_VERSION.to_le_bytes());
    wire[8..16].copy_from_slice(&request.adapter_luid.to_le_bytes());
    wire[16..32].copy_from_slice(&uuid);
    wire[32..48].copy_from_slice(&request.session_nonce);
    wire[48..52].copy_from_slice(&request.windows_session_id.to_le_bytes());
    wire[52..56].copy_from_slice(&request.width.to_le_bytes());
    wire[56..60].copy_from_slice(&request.height.to_le_bytes());
    wire[60..64].copy_from_slice(&request.refresh_hz.to_le_bytes());
    wire[64..68].copy_from_slice(&request.capture_timeout_ms.to_le_bytes());
    // Remaining 12 bytes are strict-zero reserved fields in the C++ ABI.
    Ok(wire)
}

/// This never grants GPUbnb browser authority or changes Stage 4 preflight:
/// it just returns a typed, isolated media object when the signed DLL can
/// confirm a dedicated unlocked console and single physical monitor.
pub fn open_console_media_session(
    request: ConsoleMediaProbeRequest<'_>,
) -> Result<ConsoleMediaSession, MediaProbeError> {
    let wire = encode_console_request(request)?;
    let expected = ConsoleMediaProbeRequestOwned {
        adapter_luid: request.adapter_luid,
        windows_session_id: request.windows_session_id,
        width: request.width,
        height: request.height,
        refresh_hz: request.refresh_hz,
    };
    #[cfg(target_os = "windows")]
    {
        let inner = windows_impl::open_console_persistent_session(&wire, expected)?;
        Ok(ConsoleMediaSession { expected, inner })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (wire, expected);
        Err(MediaProbeError::WindowsRequired)
    }
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ConsoleFrameMetadata {
    proof_flags: u32,
    encoded_bytes: usize,
    frame_sequence: u64,
    frame_flags: u32,
}

#[cfg(any(target_os = "windows", test))]
fn decode_console_frame_header(
    result: &[u8; CONSOLE_MEDIA_FRAME_RESULT_SIZE],
    expected: ConsoleMediaProbeRequestOwned,
    buffer_capacity: usize,
) -> Result<ConsoleFrameMetadata, MediaProbeError> {
    if read_u32(result, 0)? != CONSOLE_MEDIA_FRAME_RESULT_SIZE as u32
        || read_u32(result, 4)? != CONSOLE_MEDIA_ABI_VERSION
        || read_u32(result, 12)? != 0
        || read_u64(result, 16)? != expected.adapter_luid
        || read_u32(result, 24)? != expected.width
        || read_u32(result, 28)? != expected.height
        || read_u32(result, 32)? != expected.refresh_hz
        || read_u32(result, 56)? != 0
        || read_u32(result, 60)? != 0
    {
        return Err(MediaProbeError::InvalidResult);
    }
    let proof_flags = read_u32(result, 8)?;
    let encoded_bytes = read_u32(result, 36)? as usize;
    let frame_sequence = read_u64(result, 40)?;
    let required_capacity = read_u32(result, 48)? as usize;
    let frame_flags = read_u32(result, 52)?;
    if proof_flags != CONSOLE_MEDIA_REQUIRED_PROOFS
        || frame_sequence == 0
        || encoded_bytes == 0
        || encoded_bytes != required_capacity
        || encoded_bytes > buffer_capacity
        || frame_flags & !MEDIA_FRAME_FLAG_KEYFRAME != 0
    {
        return Err(MediaProbeError::InvalidResult);
    }
    Ok(ConsoleFrameMetadata {
        proof_flags,
        encoded_bytes,
        frame_sequence,
        frame_flags,
    })
}

pub fn open_media_session(request: MediaProbeRequest<'_>) -> Result<MediaSession, MediaProbeError> {
    let wire = encode_request(request)?;
    let expected = MediaProbeRequestOwned {
        adapter_luid: request.adapter_luid,
        display_nonce: request.display_nonce,
        width: request.width,
        height: request.height,
        refresh_hz: request.refresh_hz,
        capture_timeout_ms: request.capture_timeout_ms,
    };

    #[cfg(target_os = "windows")]
    {
        let inner = windows_impl::open_persistent_session(&wire, expected)?;
        Ok(MediaSession { expected, inner })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (wire, expected);
        Err(MediaProbeError::WindowsRequired)
    }
}

pub fn probe_media_frame(
    request: MediaProbeRequest<'_>,
) -> Result<MediaProbeResult, MediaProbeError> {
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
    type OpenFn = unsafe extern "system" fn(*const c_void, *mut *mut c_void) -> Hresult;
    type ReadFrameFn = unsafe extern "system" fn(*mut c_void, *mut u8, u32, *mut c_void) -> Hresult;
    type DiagnosticFn = unsafe extern "system" fn(*mut c_void) -> Hresult;
    type CloseFn = unsafe extern "system" fn(*mut c_void);
    type AudioOpenFn = unsafe extern "system" fn(*const c_void, *mut *mut c_void) -> Hresult;
    type AudioReadFn = unsafe extern "system" fn(*mut c_void, *mut u8, u32, *mut c_void) -> Hresult;
    type AudioCloseFn = unsafe extern "system" fn(*mut c_void) -> Hresult;

    const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryExW(file_name: *const u16, file: isize, flags: u32) -> Hmodule;
        fn GetProcAddress(module: Hmodule, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: Hmodule) -> i32;
    }

    pub(super) struct PersistentSession {
        raw: *mut c_void,
        read: ReadFrameFn,
        diagnostic: DiagnosticFn,
        close: CloseFn,
        _module: OwnedModule,
    }

    impl Drop for PersistentSession {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                // SAFETY: raw is uniquely owned by this wrapper and close belongs
                // to the same verified module retained in _module.
                unsafe { (self.close)(self.raw) };
                self.raw = std::ptr::null_mut();
            }
        }
    }

    pub(super) struct PersistentAudioSession {
        raw: *mut c_void,
        read: AudioReadFn,
        close: AudioCloseFn,
        _module: OwnedModule,
    }

    impl Drop for PersistentAudioSession {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                // SAFETY: raw is uniquely owned here and the paired close export
                // belongs to the signer-verified DLL retained in _module.
                let _ = unsafe { (self.close)(self.raw) };
                self.raw = std::ptr::null_mut();
            }
        }
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

    fn load_verified_module() -> Result<OwnedModule, MediaProbeError> {
        let path = Path::new(TRUSTED_MEDIA_DLL);
        let verified =
            open_application_for_verification(path).map_err(|_| MediaProbeError::DllUnavailable)?;
        let allowed_signer = trusted_media_signer()?;
        verified
            .verify_signer_allowed_sha256(&[allowed_signer])
            .map_err(|_| MediaProbeError::DllUntrusted)?;

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: path is fixed/verified/NUL-terminated and dependency search is
        // restricted to the verified DLL directory and System32.
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
        Ok(OwnedModule(raw))
    }

    unsafe fn symbol<T: Copy>(module: Hmodule, name: &[u8]) -> Result<T, MediaProbeError> {
        // SAFETY: module is live and name is a static NUL-terminated symbol.
        let address = unsafe { GetProcAddress(module, name.as_ptr().cast::<c_char>()) };
        if address.is_null() {
            return Err(MediaProbeError::SymbolMissing);
        }
        // SAFETY: caller supplies the exact exported ABI type for this symbol.
        Ok(unsafe { mem::transmute_copy::<*mut c_void, T>(&address) })
    }

    fn error_from_last_diagnostic(
        diagnostic: DiagnosticFn,
        expected: MediaProbeRequestOwned,
        fallback_hr: Hresult,
    ) -> MediaProbeError {
        let mut wire = [0u8; MEDIA_DIAGNOSTIC_SIZE];
        // SAFETY: wire is a writable exact-size diagnostic ABI buffer.
        let diagnostic_hr = unsafe { diagnostic(wire.as_mut_ptr().cast::<c_void>()) };
        if diagnostic_hr >= 0
            && let Ok(value) = decode_diagnostic(&wire, expected)
        {
            // Preserve the complete numeric diagnostic, including an ordinary
            // DXGI no-frame timeout. The worker decides whether a timeout is
            // retryable so a terminal timeout can still reach the service.
            return MediaProbeError::Diagnostic(value);
        }
        classify_probe_hresult(fallback_hr)
    }

    pub(super) fn open_persistent_session(
        wire: &[u8; MEDIA_REQUEST_SIZE],
        expected: MediaProbeRequestOwned,
    ) -> Result<PersistentSession, MediaProbeError> {
        let module = load_verified_module()?;
        let open: OpenFn = unsafe { symbol(module.0, b"GPUbnbMediaOpen\0")? };
        let read: ReadFrameFn = unsafe { symbol(module.0, b"GPUbnbMediaReadFrame\0")? };
        let diagnostic: DiagnosticFn =
            unsafe { symbol(module.0, b"GPUbnbMediaGetLastDiagnostic\0")? };
        let close: CloseFn = unsafe { symbol(module.0, b"GPUbnbMediaClose\0")? };

        let mut raw: *mut c_void = std::ptr::null_mut();
        // SAFETY: wire is the exact fixed ABI input and raw is a writable out pointer.
        let hr = unsafe { open(wire.as_ptr().cast::<c_void>(), &mut raw as *mut *mut c_void) };
        if hr < 0 || raw.is_null() {
            let fallback_hr = if hr < 0 { hr } else { 0x8000_4005u32 as i32 };
            return Err(error_from_last_diagnostic(
                diagnostic,
                expected,
                fallback_hr,
            ));
        }

        Ok(PersistentSession {
            raw,
            read,
            diagnostic,
            close,
            _module: module,
        })
    }

    pub(super) fn open_audio_capture_session(
        wire: &[u8; AUDIO_CAPTURE_REQUEST_SIZE],
        _expected: AudioCaptureIdentity,
    ) -> Result<PersistentAudioSession, MediaProbeError> {
        let module = load_verified_module()?;
        let open: AudioOpenFn = unsafe { symbol(module.0, b"GPUbnbAudioOpenForRenterProcess\0")? };
        let read: AudioReadFn = unsafe { symbol(module.0, b"GPUbnbAudioRead\0")? };
        let close: AudioCloseFn = unsafe { symbol(module.0, b"GPUbnbAudioClose\0")? };
        let mut raw: *mut c_void = std::ptr::null_mut();
        // SAFETY: the fixed-size request is validated and the out pointer is live.
        let hr = unsafe { open(wire.as_ptr().cast::<c_void>(), &mut raw) };
        if hr != 0 || raw.is_null() {
            return Err(if hr < 0 {
                classify_probe_hresult(hr)
            } else {
                MediaProbeError::InvalidResult
            });
        }
        Ok(PersistentAudioSession {
            raw,
            read,
            close,
            _module: module,
        })
    }

    pub(super) fn read_audio_capture_packet(
        session: &mut PersistentAudioSession,
        expected: AudioCaptureIdentity,
    ) -> Result<Option<AudioPacket>, MediaProbeError> {
        let mut payload = vec![0u8; MAX_AUDIO_PACKET_BYTES];
        let mut result = [0u8; AUDIO_PACKET_RESULT_SIZE];
        // SAFETY: session and module are live; input/output buffers match the
        // bounded ABI capacities advertised to the DLL.
        let hr = unsafe {
            (session.read)(
                session.raw,
                payload.as_mut_ptr(),
                payload.len() as u32,
                result.as_mut_ptr().cast::<c_void>(),
            )
        };
        if hr == 1 {
            return Ok(None);
        }
        if hr != 0 {
            return Err(classify_probe_hresult(hr));
        }
        let payload_bytes = read_u32(&result, 28)? as usize;
        if payload_bytes > payload.len() {
            return Err(MediaProbeError::InvalidResult);
        }
        payload.truncate(payload_bytes);
        decode_audio_packet(&result, &payload, expected).map(Some)
    }

    pub(super) fn close_audio_capture_session(
        session: &mut PersistentAudioSession,
    ) -> Result<(), MediaProbeError> {
        if session.raw.is_null() {
            return Ok(());
        }
        // SAFETY: raw is uniquely owned, on its creating thread, and the paired
        // export comes from the retained signer-verified module.
        let hr = unsafe { (session.close)(session.raw) };
        if hr == 0 {
            session.raw = std::ptr::null_mut();
            Ok(())
        } else {
            Err(classify_probe_hresult(hr))
        }
    }

    pub(super) fn open_console_persistent_session(
        wire: &[u8; CONSOLE_MEDIA_REQUEST_SIZE],
        expected: ConsoleMediaProbeRequestOwned,
    ) -> Result<PersistentSession, MediaProbeError> {
        let module = load_verified_module()?;
        let open: OpenFn = unsafe { symbol(module.0, b"GPUbnbConsoleMediaOpen\0")? };
        let read: ReadFrameFn = unsafe { symbol(module.0, b"GPUbnbConsoleMediaReadFrame\0")? };
        let diagnostic: DiagnosticFn =
            unsafe { symbol(module.0, b"GPUbnbMediaGetLastDiagnostic\0")? };
        let close: CloseFn = unsafe { symbol(module.0, b"GPUbnbMediaClose\0")? };
        let mut raw: *mut c_void = std::ptr::null_mut();
        // SAFETY: fixed 80-byte ABI request, same signer-validated DLL,
        // owned opaque session is always closed by the paired export.
        let hr = unsafe { open(wire.as_ptr().cast::<c_void>(), &mut raw) };
        if hr < 0 || raw.is_null() {
            let fallback = if hr < 0 { hr } else { 0x8000_4005u32 as i32 };
            return Err(classify_probe_hresult(fallback));
        }
        let _ = expected;
        Ok(PersistentSession {
            raw,
            read,
            diagnostic,
            close,
            _module: module,
        })
    }

    pub(super) fn read_console_frame(
        session: &mut PersistentSession,
        expected: ConsoleMediaProbeRequestOwned,
    ) -> Result<ConsoleEncodedMediaFrame, MediaProbeError> {
        let mut bytes = vec![0u8; MAX_ENCODED_FRAME_BYTES];
        let mut result = [0u8; CONSOLE_MEDIA_FRAME_RESULT_SIZE];
        // SAFETY: paired verified DLL, live session handle and exact capacities.
        let hr = unsafe {
            (session.read)(
                session.raw,
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                result.as_mut_ptr().cast::<c_void>(),
            )
        };
        if hr < 0 {
            // Do not misparse a console ABI as an IddCx diagnostic proof.
            return Err(classify_probe_hresult(hr));
        }
        let verified = decode_console_frame_header(&result, expected, bytes.len())?;
        bytes.truncate(verified.encoded_bytes);
        Ok(ConsoleEncodedMediaFrame {
            bytes,
            frame_sequence: verified.frame_sequence,
            proof_flags: verified.proof_flags,
            frame_flags: verified.frame_flags,
            adapter_luid: expected.adapter_luid,
            width: expected.width,
            height: expected.height,
            refresh_hz: expected.refresh_hz,
        })
    }

    pub(super) fn read_persistent_frame(
        session: &mut PersistentSession,
        expected: MediaProbeRequestOwned,
    ) -> Result<EncodedMediaFrame, MediaProbeError> {
        let mut bytes = vec![0u8; MAX_ENCODED_FRAME_BYTES];
        let mut result = [0u8; MEDIA_FRAME_RESULT_SIZE];
        // SAFETY: session/raw/module are live; buffers are writable for their exact
        // advertised capacities and the ABI result is exactly 64 bytes.
        let hr = unsafe {
            (session.read)(
                session.raw,
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                result.as_mut_ptr().cast::<c_void>(),
            )
        };
        if hr < 0 {
            return Err(error_from_last_diagnostic(session.diagnostic, expected, hr));
        }
        if read_u32(&result, 0)? != MEDIA_FRAME_RESULT_SIZE as u32
            || read_u32(&result, 4)? != MEDIA_ABI_VERSION
        {
            return Err(MediaProbeError::InvalidResult);
        }
        let proof_flags = read_u32(&result, 8)?;
        let failed_stage = read_u32(&result, 12)?;
        let adapter_luid = read_u64(&result, 16)?;
        let width = read_u32(&result, 24)?;
        let height = read_u32(&result, 28)?;
        let refresh_hz = read_u32(&result, 32)?;
        let encoded_bytes = read_u32(&result, 36)? as usize;
        let frame_sequence = read_u64(&result, 40)?;
        let required_capacity = read_u32(&result, 48)? as usize;
        let frame_flags = read_u32(&result, 52)?;
        let reserved0 = read_u32(&result, 56)?;
        let reserved1 = read_u32(&result, 60)?;

        if failed_stage != 0
            || adapter_luid != expected.adapter_luid
            || width != expected.width
            || height != expected.height
            || refresh_hz != expected.refresh_hz
            || encoded_bytes == 0
            || encoded_bytes != required_capacity
            || encoded_bytes > bytes.len()
            || frame_sequence == 0
            || proof_flags & MEDIA_REQUIRED_PROOFS != MEDIA_REQUIRED_PROOFS
            || frame_flags & !MEDIA_FRAME_FLAG_KEYFRAME != 0
            || reserved0 != 0
            || reserved1 != 0
        {
            return Err(MediaProbeError::InvalidResult);
        }
        bytes.truncate(encoded_bytes);
        Ok(EncodedMediaFrame {
            bytes,
            frame_sequence,
            proof_flags,
            frame_flags,
            adapter_luid,
            width,
            height,
            refresh_hz,
        })
    }

    pub(super) fn probe_media_frame(
        wire: &[u8; MEDIA_REQUEST_SIZE],
        expected: MediaProbeRequest<'_>,
    ) -> Result<MediaProbeResult, MediaProbeError> {
        let module = load_verified_module()?;
        let probe: ProbeFn = unsafe { symbol(module.0, b"GPUbnbProbeMediaFrame\0")? };
        let diagnostic: DiagnosticFn =
            unsafe { symbol(module.0, b"GPUbnbMediaGetLastDiagnostic\0")? };

        let mut result = [0u8; MEDIA_RESULT_SIZE];
        // SAFETY: input/output buffers are exactly the fixed 64-byte ABI sizes.
        let hr = unsafe {
            probe(
                wire.as_ptr().cast::<c_void>(),
                result.as_mut_ptr().cast::<c_void>(),
            )
        };
        if hr < 0 {
            let owned = MediaProbeRequestOwned {
                adapter_luid: expected.adapter_luid,
                display_nonce: expected.display_nonce,
                width: expected.width,
                height: expected.height,
                refresh_hz: expected.refresh_hz,
                capture_timeout_ms: expected.capture_timeout_ms,
            };
            return Err(error_from_last_diagnostic(diagnostic, owned, hr));
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
    fn dxgi_failures_are_classified_for_fail_closed_lifecycle() {
        assert_eq!(
            classify_probe_hresult(0x887A0027u32 as i32),
            MediaProbeError::CaptureTimeout
        );
        assert_eq!(
            classify_probe_hresult(0x887A0026u32 as i32),
            MediaProbeError::CaptureAccessLost
        );
        for hr in [0x887A0005u32, 0x887A0006u32, 0x887A0007u32] {
            assert_eq!(
                classify_probe_hresult(hr as i32),
                MediaProbeError::DeviceLost
            );
        }
        assert_eq!(classify_probe_hresult(-1), MediaProbeError::ProbeFailed);
    }

    #[test]
    fn rust_and_cpp_media_abi_version_and_frame_flags_are_locked_together() {
        const CPP_MEDIA_HEADER: &str = include_str!("../../windows-media/Media.h");
        assert!(CPP_MEDIA_HEADER.contains("#define GPUBNB_WINDOWS_MEDIA_ABI_VERSION 2u"));
        assert!(CPP_MEDIA_HEADER.contains("#define GPUBNB_WINDOWS_MEDIA_DIAGNOSTIC_VERSION 1u"));
        assert!(CPP_MEDIA_HEADER.contains("struct GPUbnbMediaDiagnostic"));
        assert!(CPP_MEDIA_HEADER.contains("GPUbnbMediaGetLastDiagnostic"));
        assert!(CPP_MEDIA_HEADER.contains("uint32_t FrameFlags;"));
        assert_eq!(MEDIA_ABI_VERSION, 2);
        assert_eq!(MEDIA_DIAGNOSTIC_VERSION, 1);
        assert_eq!(MEDIA_FRAME_FLAG_KEYFRAME, 1);
    }

    #[test]
    fn cpp_capture_backend_is_exact_monitor_wgc_not_desktop_duplication() {
        const CPP_MEDIA_SOURCE: &str = include_str!("../../windows-media/Media.cpp");
        assert!(CPP_MEDIA_SOURCE.contains("CreateForMonitor"));
        assert!(CPP_MEDIA_SOURCE.contains("CreateFreeThreaded"));
        assert!(CPP_MEDIA_SOURCE.contains("IsCursorCaptureEnabled(true)"));
        assert!(CPP_MEDIA_SOURCE.contains("item_.Closed("));
        assert!(CPP_MEDIA_SOURCE.contains("DXGI_ERROR_ACCESS_LOST"));
        assert!(CPP_MEDIA_SOURCE.contains("D3D11_QUERY_EVENT"));
        assert!(CPP_MEDIA_SOURCE.contains("NV_ENC_BUFFER_FORMAT_ARGB"));
        assert!(CPP_MEDIA_SOURCE.contains("DXGI_FORMAT_B8G8R8A8_UNORM"));
        assert!(!CPP_MEDIA_SOURCE.contains("DuplicateOutput("));
        assert!(!CPP_MEDIA_SOURCE.contains("IDXGIOutputDuplication"));
    }

    #[test]
    fn console_capture_abi_is_disjoint_from_iddcx_version_two() {
        const CPP: &str = include_str!("../../windows-media/Media.h");
        assert!(CPP.contains("#define GPUBNB_CONSOLE_MEDIA_ABI_VERSION 3u"));
        assert!(CPP.contains("struct GPUbnbConsoleProbeRequest"));
        assert!(CPP.contains("GPUbnbConsoleMediaReadFrame"));
        assert_eq!(CONSOLE_MEDIA_ABI_VERSION, 3);
        assert_ne!(CONSOLE_MEDIA_ABI_VERSION, MEDIA_ABI_VERSION);
        assert_eq!(CONSOLE_MEDIA_FRAME_RESULT_SIZE, 64);
    }

    #[test]
    fn console_request_rejects_missing_identity_and_reserved_bytes_are_zero() {
        let base = ConsoleMediaProbeRequest {
            gpu_uuid: GPU,
            adapter_luid: 0x1122_3344_5566_7788,
            windows_session_id: 42,
            session_nonce: [0x5A; 16],
            width: 1920,
            height: 1080,
            refresh_hz: 60,
            capture_timeout_ms: 250,
        };
        let wire = encode_console_request(base).expect("strict console wire");
        assert_eq!(wire.len(), 80);
        assert_eq!(&wire[0..4], &80u32.to_le_bytes());
        assert_eq!(&wire[4..8], &3u32.to_le_bytes());
        assert_eq!(&wire[48..52], &42u32.to_le_bytes());
        assert_eq!(&wire[68..80], &[0u8; 12]);
        assert_eq!(
            encode_console_request(ConsoleMediaProbeRequest {
                windows_session_id: 0,
                ..base
            }),
            Err(MediaProbeError::InvalidRequest)
        );
        assert_eq!(
            encode_console_request(ConsoleMediaProbeRequest {
                session_nonce: [0u8; 16],
                ..base
            }),
            Err(MediaProbeError::InvalidRequest)
        );
        assert_eq!(
            encode_console_request(ConsoleMediaProbeRequest {
                adapter_luid: 0,
                ..base
            }),
            Err(MediaProbeError::InvalidRequest)
        );
    }

    #[test]
    fn console_result_refuses_any_missing_proof_or_wrong_frame_fence() {
        let expected = ConsoleMediaProbeRequestOwned {
            adapter_luid: 0x1122_3344_5566_7788,
            windows_session_id: 42,
            width: 1920,
            height: 1080,
            refresh_hz: 60,
        };
        let mut wire = [0u8; CONSOLE_MEDIA_FRAME_RESULT_SIZE];
        wire[0..4].copy_from_slice(&(CONSOLE_MEDIA_FRAME_RESULT_SIZE as u32).to_le_bytes());
        wire[4..8].copy_from_slice(&CONSOLE_MEDIA_ABI_VERSION.to_le_bytes());
        wire[8..12].copy_from_slice(&CONSOLE_MEDIA_REQUIRED_PROOFS.to_le_bytes());
        wire[16..24].copy_from_slice(&expected.adapter_luid.to_le_bytes());
        wire[24..28].copy_from_slice(&expected.width.to_le_bytes());
        wire[28..32].copy_from_slice(&expected.height.to_le_bytes());
        wire[32..36].copy_from_slice(&expected.refresh_hz.to_le_bytes());
        wire[36..40].copy_from_slice(&4096u32.to_le_bytes());
        wire[40..48].copy_from_slice(&1u64.to_le_bytes());
        wire[48..52].copy_from_slice(&4096u32.to_le_bytes());
        assert_eq!(
            decode_console_frame_header(&wire, expected, MAX_ENCODED_FRAME_BYTES),
            Ok(ConsoleFrameMetadata {
                proof_flags: CONSOLE_MEDIA_REQUIRED_PROOFS,
                encoded_bytes: 4096,
                frame_sequence: 1,
                frame_flags: 0,
            })
        );

        for (offset, replacement) in [
            (4usize, 2u32), // IddCx version is not console v3.
            (8, 0x07),      // NVENC absent.
            (8, 0x1f),      // Unknown extra flag.
            (12, 9),        // Failed stage must be zero.
            (24, 1280),     // Dimensions cannot drift.
            (36, 0),        // Empty bitstream.
            (48, 8192),     // Capacity mismatch.
            (52, 0x80),     // Unknown frame flag.
            (56, 1),        // Reserved fields must be zero.
        ] {
            let mut bad = wire;
            bad[offset..offset + 4].copy_from_slice(&replacement.to_le_bytes());
            assert_eq!(
                decode_console_frame_header(&bad, expected, MAX_ENCODED_FRAME_BYTES),
                Err(MediaProbeError::InvalidResult)
            );
        }
        assert_eq!(
            decode_console_frame_header(&wire, expected, 1024),
            Err(MediaProbeError::InvalidResult)
        );
    }

    #[test]
    fn persistent_frame_result_layout_is_pinned() {
        assert_eq!(MEDIA_FRAME_RESULT_SIZE, 64);
        assert_eq!(MAX_ENCODED_FRAME_BYTES, 8 * 1024 * 1024);
        assert_eq!(MEDIA_FRAME_FLAG_KEYFRAME, 1);
    }

    fn audio_result(
        expected: AudioCaptureIdentity,
        sample_format: AudioSampleFormat,
        frames: u32,
        flags: u32,
        payload_bytes: u32,
    ) -> [u8; AUDIO_PACKET_RESULT_SIZE] {
        let mut wire = [0u8; AUDIO_PACKET_RESULT_SIZE];
        wire[0..4].copy_from_slice(&(AUDIO_PACKET_RESULT_SIZE as u32).to_le_bytes());
        wire[4..8].copy_from_slice(&AUDIO_CAPTURE_ABI_VERSION.to_le_bytes());
        wire[8..12].copy_from_slice(&expected.windows_session_id.to_le_bytes());
        wire[12..16].copy_from_slice(&expected.target_process_id.to_le_bytes());
        wire[16..20].copy_from_slice(&48_000u32.to_le_bytes());
        wire[20..22].copy_from_slice(&2u16.to_le_bytes());
        wire[22..24].copy_from_slice(
            &(match sample_format {
                AudioSampleFormat::IeeeFloat32 => 1u16,
                AudioSampleFormat::PcmUint8 => 2,
                AudioSampleFormat::PcmInt16 => 3,
                AudioSampleFormat::PcmInt24 => 4,
                AudioSampleFormat::PcmInt32 => 5,
            })
            .to_le_bytes(),
        );
        wire[24..28].copy_from_slice(&frames.to_le_bytes());
        wire[28..32].copy_from_slice(&payload_bytes.to_le_bytes());
        wire[32..40].copy_from_slice(&1234u64.to_le_bytes());
        wire[40..48].copy_from_slice(&5678u64.to_le_bytes());
        wire[48..52].copy_from_slice(&flags.to_le_bytes());
        wire
    }

    #[test]
    fn audio_request_and_cpp_abi_are_pinned() {
        const CPP_MEDIA_HEADER: &str = include_str!("../../windows-media/Media.h");
        assert!(CPP_MEDIA_HEADER.contains("#define GPUBNB_WINDOWS_AUDIO_ABI_VERSION 1u"));
        assert!(CPP_MEDIA_HEADER.contains("struct GPUbnbAudioCaptureRequest"));
        assert!(CPP_MEDIA_HEADER.contains("struct GPUbnbAudioPacketResult"));
        assert!(CPP_MEDIA_HEADER.contains("uint32_t ReadTimeoutMs;"));
        assert!(CPP_MEDIA_HEADER.contains("uint64_t TargetProcessCreationTime100ns;"));
        assert!(CPP_MEDIA_HEADER.contains("GPUbnbAudioOpenForRenterProcess"));
        assert!(CPP_MEDIA_HEADER.contains("GPUbnbAudioRead"));
        assert!(CPP_MEDIA_HEADER.contains("GPUbnbAudioClose"));
        assert!(CPP_MEDIA_HEADER.contains("sizeof(GPUbnbAudioCaptureRequest) == 32"));
        assert!(CPP_MEDIA_HEADER.contains("sizeof(GPUbnbAudioPacketResult) == 64"));
        assert!(CPP_MEDIA_HEADER.contains("GPUBNB_AUDIO_PACKET_MAX_BYTES = 512u * 1024u"));
        assert_eq!(AUDIO_CAPTURE_ABI_VERSION, 1);
        assert_eq!(MAX_AUDIO_PACKET_BYTES, 512 * 1024);

        let request = AudioCaptureRequest {
            windows_session_id: 17,
            target_process_id: 2048,
            read_timeout_ms: 25,
            target_process_creation_time_100ns: 0x1122_3344_5566_7788,
        };
        let wire = encode_audio_capture_request(request).expect("valid audio request");
        assert_eq!(wire.len(), 32);
        assert_eq!(&wire[0..4], &32u32.to_le_bytes());
        assert_eq!(&wire[4..8], &1u32.to_le_bytes());
        assert_eq!(&wire[8..12], &17u32.to_le_bytes());
        assert_eq!(&wire[12..16], &2048u32.to_le_bytes());
        assert_eq!(&wire[16..20], &25u32.to_le_bytes());
        assert_eq!(&wire[20..24], &[0u8; 4]);
        assert_eq!(
            &wire[24..32],
            &0x1122_3344_5566_7788u64.to_le_bytes()
        );

        for invalid in [
            AudioCaptureRequest {
                windows_session_id: 0,
                ..request
            },
            AudioCaptureRequest {
                target_process_id: 0,
                ..request
            },
            AudioCaptureRequest {
                read_timeout_ms: 9,
                ..request
            },
            AudioCaptureRequest {
                read_timeout_ms: 151,
                ..request
            },
            AudioCaptureRequest {
                target_process_creation_time_100ns: 0,
                ..request
            },
        ] {
            assert_eq!(
                encode_audio_capture_request(invalid),
                Err(MediaProbeError::InvalidRequest)
            );
        }
    }

    #[test]
    fn cpp_audio_capture_uses_process_loopback_and_shared_event_buffering() {
        const CPP_AUDIO_SOURCE: &str = include_str!("../../windows-media/Audio.cpp");
        assert!(CPP_AUDIO_SOURCE.contains("GetProcessTimes(targetProcess"));
        assert!(CPP_AUDIO_SOURCE.contains("AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK"));
        assert!(CPP_AUDIO_SOURCE.contains("PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE"));
        assert!(CPP_AUDIO_SOURCE.contains("AUDCLNT_STREAMFLAGS_EVENTCALLBACK"));
        assert!(CPP_AUDIO_SOURCE.contains("capture->readTimeoutMs"));
        assert!(CPP_AUDIO_SOURCE.contains("WaitForMultipleObjects("));
        assert!(CPP_AUDIO_SOURCE.contains("AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR"));
        assert!(CPP_AUDIO_SOURCE.contains(
            "AUDCLNT_STREAMFLAGS_NOPERSIST,\n        0,\n        0,"
        ));
        assert!(!CPP_AUDIO_SOURCE.contains("const REFERENCE_TIME duration"));
    }

    #[test]
    fn audio_packet_validation_binds_identity_format_length_and_timestamps() {
        let expected = AudioCaptureIdentity {
            windows_session_id: 17,
            target_process_id: 2048,
        };
        let payload = vec![0x5a; 16]; // 2 frames * 2 channels * f32.
        let wire = audio_result(expected, AudioSampleFormat::IeeeFloat32, 2, 0x02, 16);
        let packet = decode_audio_packet(&wire, &payload, expected).expect("valid PCM packet");
        assert_eq!(packet.sample_rate, 48_000);
        assert_eq!(packet.channels, 2);
        assert_eq!(packet.sample_format, AudioSampleFormat::IeeeFloat32);
        assert_eq!(packet.frames, 2);
        assert_eq!(packet.device_position_frames, 1234);
        assert_eq!(packet.qpc_position_100ns, 5678);
        assert!(!packet.silent);
        assert!(packet.discontinuity);
        assert_eq!(packet.bytes, payload);

        for (format, bytes_per_sample) in [
            (AudioSampleFormat::IeeeFloat32, 4usize),
            (AudioSampleFormat::PcmUint8, 1),
            (AudioSampleFormat::PcmInt16, 2),
            (AudioSampleFormat::PcmInt24, 3),
            (AudioSampleFormat::PcmInt32, 4),
        ] {
            let payload = vec![0x5a; 4 * bytes_per_sample];
            let result = audio_result(
                expected,
                format,
                2,
                0,
                payload.len() as u32,
            );
            assert_eq!(
                decode_audio_packet(&result, &payload, expected)
                    .expect("supported PCM format")
                    .sample_format,
                format
            );
        }

        assert_eq!(
            decode_audio_packet(&wire, &vec![0x5a; 15], expected).err(),
            Some(MediaProbeError::InvalidResult)
        );
        assert_eq!(
            decode_audio_packet(
                &wire,
                &payload,
                AudioCaptureIdentity {
                    target_process_id: 2049,
                    ..expected
                },
            )
            .err(),
            Some(MediaProbeError::InvalidResult)
        );
        assert_eq!(
            decode_audio_packet(
                &wire,
                &payload,
                AudioCaptureIdentity {
                    windows_session_id: 18,
                    ..expected
                },
            )
            .err(),
            Some(MediaProbeError::InvalidResult)
        );

        for (offset, value) in [(4usize, 2u32), (8, 18), (12, 2049), (48, 4), (52, 1)] {
            let mut invalid = wire;
            invalid[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert_eq!(
                decode_audio_packet(&invalid, &payload, expected).err(),
                Some(MediaProbeError::InvalidResult)
            );
        }

        let mut unknown_format = wire;
        unknown_format[22..24].copy_from_slice(&99u16.to_le_bytes());
        assert_eq!(
            decode_audio_packet(&unknown_format, &payload, expected).err(),
            Some(MediaProbeError::InvalidResult)
        );
    }

    #[test]
    fn audio_silence_is_format_correct_and_non_windows_open_fails_closed() {
        let expected = AudioCaptureIdentity {
            windows_session_id: 17,
            target_process_id: 2048,
        };
        let silent_wire = audio_result(expected, AudioSampleFormat::PcmUint8, 2, 1, 4);
        assert!(decode_audio_packet(&silent_wire, &[0x80; 4], expected)
            .expect("unsigned 8-bit PCM silence")
            .silent);
        assert_eq!(
            decode_audio_packet(&silent_wire, &[0; 4], expected).err(),
            Some(MediaProbeError::InvalidResult)
        );

        #[cfg(not(target_os = "windows"))]
        {
            let request = AudioCaptureRequest {
                windows_session_id: 17,
                target_process_id: 2048,
                read_timeout_ms: 25,
                target_process_creation_time_100ns: 0x1122_3344_5566_7788,
            };
            assert!(matches!(
                AudioCaptureSession::open(request),
                Err(MediaProbeError::WindowsRequired)
            ));
            assert_eq!(
                AudioCaptureSession::open(AudioCaptureRequest {
                    windows_session_id: 0,
                    ..request
                })
                .err(),
                Some(MediaProbeError::InvalidRequest)
            );
        }
    }

    #[test]
    fn diagnostic_wire_is_exact_numeric_failure_evidence() {
        let request = request();
        let expected = MediaProbeRequestOwned {
            adapter_luid: request.adapter_luid,
            display_nonce: request.display_nonce,
            width: request.width,
            height: request.height,
            refresh_hz: request.refresh_hz,
            capture_timeout_ms: request.capture_timeout_ms,
        };
        let mut wire = [0u8; MEDIA_DIAGNOSTIC_SIZE];
        wire[0..4].copy_from_slice(&(MEDIA_DIAGNOSTIC_SIZE as u32).to_le_bytes());
        wire[4..8].copy_from_slice(&MEDIA_DIAGNOSTIC_VERSION.to_le_bytes());
        wire[8..12].copy_from_slice(&9u32.to_le_bytes());
        wire[12..16].copy_from_slice(&0x8000_4005u32.to_le_bytes());
        wire[16..20].copy_from_slice(&10i32.to_le_bytes());
        wire[20..24].copy_from_slice(&MEDIA_PROOF_CAPTURED_FRAME.to_le_bytes());
        wire[24..32].copy_from_slice(&expected.adapter_luid.to_le_bytes());
        wire[32..36].copy_from_slice(&expected.width.to_le_bytes());
        wire[36..40].copy_from_slice(&expected.height.to_le_bytes());
        wire[40..44].copy_from_slice(&expected.refresh_hz.to_le_bytes());

        let diagnostic = decode_diagnostic(&wire, expected).expect("valid diagnostic");
        assert_eq!(diagnostic.failed_stage, 9);
        assert_eq!(diagnostic.hresult as u32, 0x8000_4005);
        assert_eq!(diagnostic.nvenc_status, 10);
        assert_eq!(diagnostic.adapter_luid, expected.adapter_luid);

        wire[44..48].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(
            decode_diagnostic(&wire, expected),
            Err(MediaProbeError::InvalidResult)
        );
    }

    #[test]
    fn request_wire_matches_cpp_abi() {
        let wire = encode_request(request()).expect("valid media request");
        assert_eq!(wire.len(), 64);
        assert_eq!(&wire[0..4], &64u32.to_le_bytes());
        assert_eq!(&wire[4..8], &2u32.to_le_bytes());
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

        wire[8..12]
            .copy_from_slice(&(MEDIA_REQUIRED_PROOFS & !MEDIA_PROOF_NVENC_BITSTREAM).to_le_bytes());
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
