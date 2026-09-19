//! Bounded worker -> service media frame contract.
//!
//! H.264 payloads never travel over the 512-byte privileged control pipe.  The
//! control pipe carries only commands and proofs; a separately ACL/PID/SID-fenced
//! local media pipe carries one fixed-size identity header followed by one bounded
//! encoded payload.  Every frame is bound to the same generation, WTS session,
//! IddCx display nonce, exact adapter LUID and control-command sequence as its
//! WorkerMediaProof.

use crate::worker_protocol::{
    WORKER_MEDIA_REQUIRED_PROOF_FLAGS, WorkerDisplaySpec, WorkerMediaProof,
};

pub const MEDIA_TRANSPORT_PROTOCOL_VERSION: u16 = 1;
pub const MEDIA_FRAME_HEADER_SIZE: usize = 80;
pub const MEDIA_H264_FRAME_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MEDIA_CODEC_H264: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerMediaFrameHeader {
    pub protocol_version: u16,
    pub codec: u8,
    pub generation: u64,
    pub command_sequence: u64,
    pub windows_session_id: u32,
    pub adapter_luid: u64,
    pub display_nonce: [u8; 16],
    pub frame_sequence: u64,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub payload_bytes: u32,
    pub proof_flags: u32,
}

// Intentionally no Debug/Clone derive: encoded renter pixels must not be
// accidentally dumped into service diagnostics or duplicated by convenience APIs.
pub struct BoundMediaFrame {
    pub header: WorkerMediaFrameHeader,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaFrameError {
    InvalidLength,
    ProtocolVersion,
    HeaderSize,
    Codec,
    Reserved,
    Generation,
    Sequence,
    WindowsSession,
    Adapter,
    DisplayNonce,
    Dimensions,
    RefreshRate,
    FrameSequence,
    PayloadLength,
    ProofFlags,
    EmptyPayload,
}

fn read_u32(frame: &[u8], offset: usize) -> Result<u32, MediaFrameError> {
    let bytes: [u8; 4] = frame
        .get(offset..offset + 4)
        .ok_or(MediaFrameError::InvalidLength)?
        .try_into()
        .map_err(|_| MediaFrameError::InvalidLength)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(frame: &[u8], offset: usize) -> Result<u64, MediaFrameError> {
    let bytes: [u8; 8] = frame
        .get(offset..offset + 8)
        .ok_or(MediaFrameError::InvalidLength)?
        .try_into()
        .map_err(|_| MediaFrameError::InvalidLength)?;
    Ok(u64::from_le_bytes(bytes))
}

fn validate_header_fields(header: WorkerMediaFrameHeader) -> Result<(), MediaFrameError> {
    if header.protocol_version != MEDIA_TRANSPORT_PROTOCOL_VERSION {
        return Err(MediaFrameError::ProtocolVersion);
    }
    if header.codec != MEDIA_CODEC_H264 {
        return Err(MediaFrameError::Codec);
    }
    if header.generation == 0 {
        return Err(MediaFrameError::Generation);
    }
    if header.command_sequence == 0 {
        return Err(MediaFrameError::Sequence);
    }
    if header.windows_session_id == 0 {
        return Err(MediaFrameError::WindowsSession);
    }
    if header.adapter_luid == 0 {
        return Err(MediaFrameError::Adapter);
    }
    if header.display_nonce == [0; 16] {
        return Err(MediaFrameError::DisplayNonce);
    }
    if !(640..=7680).contains(&header.width) || !(480..=4320).contains(&header.height) {
        return Err(MediaFrameError::Dimensions);
    }
    if !(30..=240).contains(&header.refresh_hz) {
        return Err(MediaFrameError::RefreshRate);
    }
    if header.frame_sequence == 0 {
        return Err(MediaFrameError::FrameSequence);
    }
    if header.payload_bytes == 0 || header.payload_bytes as usize > MEDIA_H264_FRAME_MAX_BYTES {
        return Err(MediaFrameError::PayloadLength);
    }
    if header.proof_flags != WORKER_MEDIA_REQUIRED_PROOF_FLAGS {
        return Err(MediaFrameError::ProofFlags);
    }
    Ok(())
}

pub fn encode_worker_media_frame_header(
    header: WorkerMediaFrameHeader,
) -> Result<[u8; MEDIA_FRAME_HEADER_SIZE], MediaFrameError> {
    validate_header_fields(header)?;

    let mut out = [0u8; MEDIA_FRAME_HEADER_SIZE];
    out[0..2].copy_from_slice(&header.protocol_version.to_le_bytes());
    out[2..4].copy_from_slice(&(MEDIA_FRAME_HEADER_SIZE as u16).to_le_bytes());
    out[4] = header.codec;
    // 5..8 are reserved and intentionally remain zero.
    out[8..16].copy_from_slice(&header.generation.to_le_bytes());
    out[16..24].copy_from_slice(&header.command_sequence.to_le_bytes());
    out[24..28].copy_from_slice(&header.windows_session_id.to_le_bytes());
    out[28..36].copy_from_slice(&header.adapter_luid.to_le_bytes());
    out[36..52].copy_from_slice(&header.display_nonce);
    out[52..60].copy_from_slice(&header.frame_sequence.to_le_bytes());
    out[60..64].copy_from_slice(&header.width.to_le_bytes());
    out[64..68].copy_from_slice(&header.height.to_le_bytes());
    out[68..72].copy_from_slice(&header.refresh_hz.to_le_bytes());
    out[72..76].copy_from_slice(&header.payload_bytes.to_le_bytes());
    out[76..80].copy_from_slice(&header.proof_flags.to_le_bytes());
    Ok(out)
}

pub fn decode_worker_media_frame_header(
    frame: &[u8],
) -> Result<WorkerMediaFrameHeader, MediaFrameError> {
    if frame.len() != MEDIA_FRAME_HEADER_SIZE {
        return Err(MediaFrameError::InvalidLength);
    }
    let protocol_version = u16::from_le_bytes([frame[0], frame[1]]);
    if protocol_version != MEDIA_TRANSPORT_PROTOCOL_VERSION {
        return Err(MediaFrameError::ProtocolVersion);
    }
    let header_size = u16::from_le_bytes([frame[2], frame[3]]) as usize;
    if header_size != MEDIA_FRAME_HEADER_SIZE {
        return Err(MediaFrameError::HeaderSize);
    }
    if frame[5..8].iter().any(|byte| *byte != 0) {
        return Err(MediaFrameError::Reserved);
    }
    let display_nonce: [u8; 16] = frame[36..52]
        .try_into()
        .map_err(|_| MediaFrameError::InvalidLength)?;
    let header = WorkerMediaFrameHeader {
        protocol_version,
        codec: frame[4],
        generation: read_u64(frame, 8)?,
        command_sequence: read_u64(frame, 16)?,
        windows_session_id: read_u32(frame, 24)?,
        adapter_luid: read_u64(frame, 28)?,
        display_nonce,
        frame_sequence: read_u64(frame, 52)?,
        width: read_u32(frame, 60)?,
        height: read_u32(frame, 64)?,
        refresh_hz: read_u32(frame, 68)?,
        payload_bytes: read_u32(frame, 72)?,
        proof_flags: read_u32(frame, 76)?,
    };
    validate_header_fields(header)?;
    Ok(header)
}

pub fn validate_worker_media_frame_header(
    expected_generation: u64,
    expected_command_sequence: u64,
    expected_windows_session_id: u32,
    expected_display: WorkerDisplaySpec,
    proof: WorkerMediaProof,
    header: WorkerMediaFrameHeader,
) -> Result<(), MediaFrameError> {
    validate_header_fields(header)?;
    if header.generation != expected_generation || header.generation != proof.generation {
        return Err(MediaFrameError::Generation);
    }
    if header.command_sequence != expected_command_sequence
        || header.command_sequence != proof.command_sequence
    {
        return Err(MediaFrameError::Sequence);
    }
    if header.windows_session_id != expected_windows_session_id
        || header.windows_session_id != proof.windows_session_id
    {
        return Err(MediaFrameError::WindowsSession);
    }
    if header.adapter_luid != expected_display.adapter_luid
        || header.adapter_luid != proof.adapter_luid
    {
        return Err(MediaFrameError::Adapter);
    }
    if header.display_nonce != expected_display.display_nonce
        || header.display_nonce != proof.display_nonce
    {
        return Err(MediaFrameError::DisplayNonce);
    }
    if header.width != expected_display.width
        || header.height != expected_display.height
        || header.width != proof.width
        || header.height != proof.height
    {
        return Err(MediaFrameError::Dimensions);
    }
    if header.refresh_hz != expected_display.refresh_hz || header.refresh_hz != proof.refresh_hz {
        return Err(MediaFrameError::RefreshRate);
    }
    if header.frame_sequence != proof.frame_sequence {
        return Err(MediaFrameError::FrameSequence);
    }
    if header.payload_bytes != proof.encoded_bytes {
        return Err(MediaFrameError::PayloadLength);
    }
    if header.proof_flags != proof.proof_flags {
        return Err(MediaFrameError::ProofFlags);
    }
    Ok(())
}

pub fn bind_worker_media_payload(
    header: WorkerMediaFrameHeader,
    payload: Vec<u8>,
) -> Result<BoundMediaFrame, MediaFrameError> {
    validate_header_fields(header)?;
    if payload.is_empty() {
        return Err(MediaFrameError::EmptyPayload);
    }
    if payload.len() != header.payload_bytes as usize || payload.len() > MEDIA_H264_FRAME_MAX_BYTES
    {
        return Err(MediaFrameError::PayloadLength);
    }
    // Reject a trivially forged "encoded" frame without attempting to become an
    // H.264 parser here. The trusted NVENC DLL is the codec authority; this layer
    // binds its non-empty bytes to the authenticated proof and session fences.
    if payload.iter().all(|byte| *byte == 0) {
        return Err(MediaFrameError::EmptyPayload);
    }
    Ok(BoundMediaFrame {
        header,
        bytes: payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_protocol::WORKER_PROTOCOL_VERSION;

    fn display() -> WorkerDisplaySpec {
        WorkerDisplaySpec {
            protocol_version: WORKER_PROTOCOL_VERSION,
            generation: 7,
            command_sequence: 1,
            windows_session_id: 42,
            adapter_luid: 0x1122_3344_5566_7788,
            display_nonce: [0xA5; 16],
            width: 1920,
            height: 1080,
            refresh_hz: 60,
        }
    }

    fn proof() -> WorkerMediaProof {
        WorkerMediaProof {
            protocol_version: WORKER_PROTOCOL_VERSION,
            generation: 7,
            command_sequence: 2,
            windows_session_id: 42,
            adapter_luid: display().adapter_luid,
            display_nonce: display().display_nonce,
            width: 1920,
            height: 1080,
            refresh_hz: 60,
            frame_sequence: 9,
            encoded_bytes: 5,
            proof_flags: WORKER_MEDIA_REQUIRED_PROOF_FLAGS,
        }
    }

    fn header() -> WorkerMediaFrameHeader {
        let proof = proof();
        WorkerMediaFrameHeader {
            protocol_version: MEDIA_TRANSPORT_PROTOCOL_VERSION,
            codec: MEDIA_CODEC_H264,
            generation: proof.generation,
            command_sequence: proof.command_sequence,
            windows_session_id: proof.windows_session_id,
            adapter_luid: proof.adapter_luid,
            display_nonce: proof.display_nonce,
            frame_sequence: proof.frame_sequence,
            width: proof.width,
            height: proof.height,
            refresh_hz: proof.refresh_hz,
            payload_bytes: proof.encoded_bytes,
            proof_flags: proof.proof_flags,
        }
    }

    #[test]
    fn header_round_trip_is_fixed_and_reserved_bytes_are_zero() {
        let encoded = encode_worker_media_frame_header(header()).expect("header");
        assert_eq!(encoded.len(), MEDIA_FRAME_HEADER_SIZE);
        assert_eq!(
            &encoded[2..4],
            &(MEDIA_FRAME_HEADER_SIZE as u16).to_le_bytes()
        );
        assert_eq!(&encoded[5..8], &[0, 0, 0]);
        assert_eq!(decode_worker_media_frame_header(&encoded), Ok(header()));
    }

    #[test]
    fn frame_is_bound_to_control_proof_and_display_identity() {
        assert_eq!(
            validate_worker_media_frame_header(7, 2, 42, display(), proof(), header()),
            Ok(())
        );

        let mut wrong = header();
        wrong.generation = 8;
        assert_eq!(
            validate_worker_media_frame_header(7, 2, 42, display(), proof(), wrong),
            Err(MediaFrameError::Generation)
        );

        let mut wrong = header();
        wrong.display_nonce = [0xB6; 16];
        assert_eq!(
            validate_worker_media_frame_header(7, 2, 42, display(), proof(), wrong),
            Err(MediaFrameError::DisplayNonce)
        );
    }

    #[test]
    fn payload_is_bounded_exact_and_nonzero() {
        assert!(bind_worker_media_payload(header(), vec![1, 2, 3, 4, 5]).is_ok());
        assert_eq!(
            bind_worker_media_payload(header(), vec![1, 2, 3, 4]),
            Err(MediaFrameError::PayloadLength)
        );
        assert_eq!(
            bind_worker_media_payload(header(), vec![0; 5]),
            Err(MediaFrameError::EmptyPayload)
        );
    }

    #[test]
    fn oversized_declared_payload_is_rejected_before_allocation() {
        let mut oversized = header();
        oversized.payload_bytes = (MEDIA_H264_FRAME_MAX_BYTES as u32) + 1;
        assert_eq!(
            encode_worker_media_frame_header(oversized),
            Err(MediaFrameError::PayloadLength)
        );
    }
}
