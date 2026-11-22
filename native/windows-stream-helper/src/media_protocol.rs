//! Bounded worker -> service media frame contract.
//!
//! H.264 payloads never travel over the 512-byte privileged control pipe.  The
//! control pipe carries only commands and proofs; a separately ACL/PID/SID-fenced
//! local media pipe carries one fixed-size identity header followed by one bounded
//! encoded payload.  Every frame is bound to the same generation, WTS session,
//! IddCx display nonce, exact adapter LUID and control-command sequence as its
//! WorkerMediaProof.

use crate::worker_protocol::{
    WORKER_CONSOLE_PROOF_PROTOCOL_VERSION, WORKER_CONSOLE_REQUIRED_PROOF_FLAGS,
    WORKER_MEDIA_REQUIRED_PROOF_FLAGS, WORKER_PROTOCOL_VERSION, WorkerDisplaySpec,
    WorkerMediaProof,
};
use gpubnb_windows_platform::media::{AudioPacket, AudioSampleFormat};

pub const MEDIA_TRANSPORT_PROTOCOL_VERSION: u16 = 3;
pub const MEDIA_CONSOLE_TRANSPORT_PROTOCOL_VERSION: u16 = 4;
pub const MEDIA_FRAME_HEADER_SIZE: usize = 88;
pub const MEDIA_H264_FRAME_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MEDIA_CODEC_H264: u8 = 1;
pub const MEDIA_FRAME_FLAG_KEYFRAME: u8 = 1 << 0;
pub const WORKER_AUDIO_BATCH_PROTOCOL_VERSION: u16 = 1;
pub const WORKER_AUDIO_BATCH_HEADER_SIZE: usize = 64;
pub const WORKER_AUDIO_PACKET_HEADER_SIZE: usize = 48;
pub const WORKER_AUDIO_PACKET_MAX_BYTES: usize = 512 * 1024;
pub const WORKER_AUDIO_BATCH_MAX_PACKETS: usize = 4;
pub const WORKER_AUDIO_BATCH_MAX_BYTES: usize = WORKER_AUDIO_BATCH_HEADER_SIZE
    + WORKER_AUDIO_BATCH_MAX_PACKETS
        * (WORKER_AUDIO_PACKET_HEADER_SIZE + WORKER_AUDIO_PACKET_MAX_BYTES);
const WORKER_AUDIO_BATCH_MAGIC: [u8; 4] = *b"GBAU";
const WORKER_AUDIO_FLAG_SILENT: u32 = 1 << 0;
const WORKER_AUDIO_FLAG_DISCONTINUITY: u32 = 1 << 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerMediaFrameHeader {
    pub protocol_version: u16,
    pub codec: u8,
    pub frame_flags: u8,
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
    /// QPC time (100 ns) sampled immediately after capture/encoding. Audio
    /// loopback timestamps use the same clock domain for browser A/V sync.
    pub qpc_position_100ns: u64,
}

// Intentionally no Debug/Clone derive: encoded renter pixels must not be
// accidentally dumped into service diagnostics or duplicated by convenience APIs.
pub struct BoundMediaFrame {
    pub header: WorkerMediaFrameHeader,
    pub bytes: Vec<u8>,
    pub audio_packets: Vec<BoundAudioPacket>,
    /// Process identity whose descendant tree is the source of every attached
    /// process-loopback packet. It remains Host-private and never reaches the
    /// browser-facing protocol.
    pub audio_target_identity: Option<AudioTargetProcessIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioTargetProcessIdentity {
    pub process_id: u32,
    pub creation_time_100ns: u64,
}

/// One PCM packet proven to belong to this video's renter process generation.
/// Raw game audio intentionally has no Debug/Clone implementation.
pub struct BoundAudioPacket {
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

impl BoundMediaFrame {
    pub const fn is_keyframe(&self) -> bool {
        self.header.frame_flags & MEDIA_FRAME_FLAG_KEYFRAME != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaFrameError {
    InvalidLength,
    ProtocolVersion,
    HeaderSize,
    Codec,
    FrameFlags,
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
    AudioPacket,
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
    match (header.protocol_version, header.proof_flags) {
        (MEDIA_TRANSPORT_PROTOCOL_VERSION, WORKER_MEDIA_REQUIRED_PROOF_FLAGS)
        | (MEDIA_CONSOLE_TRANSPORT_PROTOCOL_VERSION, WORKER_CONSOLE_REQUIRED_PROOF_FLAGS) => {}
        (MEDIA_TRANSPORT_PROTOCOL_VERSION | MEDIA_CONSOLE_TRANSPORT_PROTOCOL_VERSION, _) => {
            return Err(MediaFrameError::ProofFlags);
        }
        _ => return Err(MediaFrameError::ProtocolVersion),
    }
    if header.codec != MEDIA_CODEC_H264 {
        return Err(MediaFrameError::Codec);
    }
    if header.frame_flags & !MEDIA_FRAME_FLAG_KEYFRAME != 0 {
        return Err(MediaFrameError::FrameFlags);
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
    if header.qpc_position_100ns == 0 {
        return Err(MediaFrameError::FrameSequence);
    }
    if header.payload_bytes == 0 || header.payload_bytes as usize > MEDIA_H264_FRAME_MAX_BYTES {
        return Err(MediaFrameError::PayloadLength);
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
    out[5] = header.frame_flags;
    // 6..8 are reserved and intentionally remain zero.
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
    out[80..88].copy_from_slice(&header.qpc_position_100ns.to_le_bytes());
    Ok(out)
}

pub fn decode_worker_media_frame_header(
    frame: &[u8],
) -> Result<WorkerMediaFrameHeader, MediaFrameError> {
    if frame.len() != MEDIA_FRAME_HEADER_SIZE {
        return Err(MediaFrameError::InvalidLength);
    }
    let protocol_version = u16::from_le_bytes([frame[0], frame[1]]);
    if !matches!(
        protocol_version,
        MEDIA_TRANSPORT_PROTOCOL_VERSION | MEDIA_CONSOLE_TRANSPORT_PROTOCOL_VERSION
    ) {
        return Err(MediaFrameError::ProtocolVersion);
    }
    let header_size = u16::from_le_bytes([frame[2], frame[3]]) as usize;
    if header_size != MEDIA_FRAME_HEADER_SIZE {
        return Err(MediaFrameError::HeaderSize);
    }
    if frame[6..8].iter().any(|byte| *byte != 0) {
        return Err(MediaFrameError::Reserved);
    }
    let display_nonce: [u8; 16] = frame[36..52]
        .try_into()
        .map_err(|_| MediaFrameError::InvalidLength)?;
    let header = WorkerMediaFrameHeader {
        protocol_version,
        codec: frame[4],
        frame_flags: frame[5],
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
        qpc_position_100ns: read_u64(frame, 80)?,
    };
    validate_header_fields(header)?;
    Ok(header)
}

fn validate_media_frame_header_domain(
    expected_generation: u64,
    expected_command_sequence: u64,
    expected_windows_session_id: u32,
    expected_display: WorkerDisplaySpec,
    proof: WorkerMediaProof,
    header: WorkerMediaFrameHeader,
    console: bool,
) -> Result<(), MediaFrameError> {
    let expected_version = if console {
        MEDIA_CONSOLE_TRANSPORT_PROTOCOL_VERSION
    } else {
        MEDIA_TRANSPORT_PROTOCOL_VERSION
    };
    let expected_proof_version = if console {
        WORKER_CONSOLE_PROOF_PROTOCOL_VERSION
    } else {
        WORKER_PROTOCOL_VERSION
    };
    if header.protocol_version != expected_version
        || proof.protocol_version != expected_proof_version
    {
        return Err(MediaFrameError::ProtocolVersion);
    }
    validate_header_fields(header)?;
    validate_media_frame_identity(
        expected_generation,
        expected_command_sequence,
        expected_windows_session_id,
        expected_display,
        proof,
        header,
    )
}

pub fn validate_worker_media_frame_header(
    expected_generation: u64,
    expected_command_sequence: u64,
    expected_windows_session_id: u32,
    expected_display: WorkerDisplaySpec,
    proof: WorkerMediaProof,
    header: WorkerMediaFrameHeader,
) -> Result<(), MediaFrameError> {
    validate_media_frame_header_domain(
        expected_generation,
        expected_command_sequence,
        expected_windows_session_id,
        expected_display,
        proof,
        header,
        false,
    )
}

pub fn validate_worker_console_media_frame_header(
    expected_generation: u64,
    expected_command_sequence: u64,
    expected_windows_session_id: u32,
    expected_display: WorkerDisplaySpec,
    proof: WorkerMediaProof,
    header: WorkerMediaFrameHeader,
) -> Result<(), MediaFrameError> {
    validate_media_frame_header_domain(
        expected_generation,
        expected_command_sequence,
        expected_windows_session_id,
        expected_display,
        proof,
        header,
        true,
    )
}

fn validate_media_frame_identity(
    expected_generation: u64,
    expected_command_sequence: u64,
    expected_windows_session_id: u32,
    expected_display: WorkerDisplaySpec,
    proof: WorkerMediaProof,
    header: WorkerMediaFrameHeader,
) -> Result<(), MediaFrameError> {
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
        audio_packets: Vec::new(),
        audio_target_identity: None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerAudioBatchFence {
    pub generation: u64,
    pub command_sequence: u64,
    pub windows_session_id: u32,
    pub video_frame_sequence: u64,
    pub video_qpc_position_100ns: u64,
    pub target_process_id: u32,
    pub target_process_creation_time_100ns: u64,
}

fn audio_sample_format_id(format: AudioSampleFormat) -> u16 {
    match format {
        AudioSampleFormat::IeeeFloat32 => 1,
        AudioSampleFormat::PcmUint8 => 2,
        AudioSampleFormat::PcmInt16 => 3,
        AudioSampleFormat::PcmInt24 => 4,
        AudioSampleFormat::PcmInt32 => 5,
    }
}

fn audio_sample_format_from_id(value: u16) -> Result<AudioSampleFormat, MediaFrameError> {
    match value {
        1 => Ok(AudioSampleFormat::IeeeFloat32),
        2 => Ok(AudioSampleFormat::PcmUint8),
        3 => Ok(AudioSampleFormat::PcmInt16),
        4 => Ok(AudioSampleFormat::PcmInt24),
        5 => Ok(AudioSampleFormat::PcmInt32),
        _ => Err(MediaFrameError::AudioPacket),
    }
}

fn audio_bytes_per_sample(format: AudioSampleFormat) -> usize {
    match format {
        AudioSampleFormat::IeeeFloat32 | AudioSampleFormat::PcmInt32 => 4,
        AudioSampleFormat::PcmUint8 => 1,
        AudioSampleFormat::PcmInt16 => 2,
        AudioSampleFormat::PcmInt24 => 3,
    }
}

fn validate_audio_packet(packet: &AudioPacket) -> Result<(), MediaFrameError> {
    let expected_bytes = (packet.frames as usize)
        .checked_mul(packet.channels as usize)
        .and_then(|frames| frames.checked_mul(audio_bytes_per_sample(packet.sample_format)))
        .ok_or(MediaFrameError::AudioPacket)?;
    let silence_sample = if packet.sample_format == AudioSampleFormat::PcmUint8 {
        0x80
    } else {
        0
    };
    if !(8_000..=192_000).contains(&packet.sample_rate)
        || !(1..=8).contains(&packet.channels)
        || packet.frames == 0
        || packet.bytes.is_empty()
        || packet.bytes.len() > WORKER_AUDIO_PACKET_MAX_BYTES
        || packet.bytes.len() != expected_bytes
        || (!packet.discontinuity && packet.qpc_position_100ns == 0)
        || (packet.silent && packet.bytes.iter().any(|byte| *byte != silence_sample))
    {
        return Err(MediaFrameError::AudioPacket);
    }
    Ok(())
}

pub fn encode_worker_audio_batch(
    fence: WorkerAudioBatchFence,
    packets: &[AudioPacket],
) -> Result<Vec<u8>, MediaFrameError> {
    if fence.generation == 0
        || fence.command_sequence == 0
        || fence.windows_session_id == 0
        || fence.video_frame_sequence == 0
        || fence.video_qpc_position_100ns == 0
        || fence.target_process_id == 0
        || fence.target_process_creation_time_100ns == 0
        || packets.len() > WORKER_AUDIO_BATCH_MAX_PACKETS
    {
        return Err(MediaFrameError::AudioPacket);
    }
    let total_bytes =
        packets
            .iter()
            .try_fold(WORKER_AUDIO_BATCH_HEADER_SIZE, |total, packet| {
                validate_audio_packet(packet)?;
                if packet.qpc_position_100ns != 0
                    && packet.qpc_position_100ns > fence.video_qpc_position_100ns
                {
                    return Err(MediaFrameError::AudioPacket);
                }
                total
                    .checked_add(WORKER_AUDIO_PACKET_HEADER_SIZE)
                    .and_then(|value| value.checked_add(packet.bytes.len()))
                    .ok_or(MediaFrameError::AudioPacket)
            })?;
    if total_bytes > WORKER_AUDIO_BATCH_MAX_BYTES {
        return Err(MediaFrameError::AudioPacket);
    }

    let mut out = Vec::with_capacity(total_bytes);
    out.extend_from_slice(&WORKER_AUDIO_BATCH_MAGIC);
    out.extend_from_slice(&WORKER_AUDIO_BATCH_PROTOCOL_VERSION.to_le_bytes());
    out.extend_from_slice(&(packets.len() as u16).to_le_bytes());
    out.extend_from_slice(&fence.generation.to_le_bytes());
    out.extend_from_slice(&fence.command_sequence.to_le_bytes());
    out.extend_from_slice(&fence.windows_session_id.to_le_bytes());
    out.extend_from_slice(&fence.video_frame_sequence.to_le_bytes());
    out.extend_from_slice(&fence.video_qpc_position_100ns.to_le_bytes());
    out.extend_from_slice(&fence.target_process_id.to_le_bytes());
    out.extend_from_slice(&fence.target_process_creation_time_100ns.to_le_bytes());
    out.extend_from_slice(&[0; 8]);

    for packet in packets {
        let payload_bytes =
            u32::try_from(packet.bytes.len()).map_err(|_| MediaFrameError::AudioPacket)?;
        let flags = (if packet.silent {
            WORKER_AUDIO_FLAG_SILENT
        } else {
            0
        }) | (if packet.discontinuity {
            WORKER_AUDIO_FLAG_DISCONTINUITY
        } else {
            0
        });
        out.extend_from_slice(&(WORKER_AUDIO_PACKET_HEADER_SIZE as u32).to_le_bytes());
        out.extend_from_slice(&packet.sample_rate.to_le_bytes());
        out.extend_from_slice(&packet.channels.to_le_bytes());
        out.extend_from_slice(&audio_sample_format_id(packet.sample_format).to_le_bytes());
        out.extend_from_slice(&packet.frames.to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&payload_bytes.to_le_bytes());
        out.extend_from_slice(&packet.device_position_frames.to_le_bytes());
        out.extend_from_slice(&packet.qpc_position_100ns.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&packet.bytes);
    }
    Ok(out)
}

pub fn decode_worker_audio_batch(
    frame: &[u8],
    expected: WorkerMediaFrameHeader,
) -> Result<(WorkerAudioBatchFence, Vec<BoundAudioPacket>), MediaFrameError> {
    if frame.len() < WORKER_AUDIO_BATCH_HEADER_SIZE || frame.len() > WORKER_AUDIO_BATCH_MAX_BYTES {
        return Err(MediaFrameError::AudioPacket);
    }
    if frame[0..4] != WORKER_AUDIO_BATCH_MAGIC
        || u16::from_le_bytes([frame[4], frame[5]]) != WORKER_AUDIO_BATCH_PROTOCOL_VERSION
        || frame[56..64].iter().any(|byte| *byte != 0)
    {
        return Err(MediaFrameError::AudioPacket);
    }
    let count = u16::from_le_bytes([frame[6], frame[7]]) as usize;
    let fence = WorkerAudioBatchFence {
        generation: read_u64(frame, 8)?,
        command_sequence: read_u64(frame, 16)?,
        windows_session_id: read_u32(frame, 24)?,
        video_frame_sequence: read_u64(frame, 28)?,
        video_qpc_position_100ns: read_u64(frame, 36)?,
        target_process_id: read_u32(frame, 44)?,
        target_process_creation_time_100ns: read_u64(frame, 48)?,
    };
    if count > WORKER_AUDIO_BATCH_MAX_PACKETS
        || fence.generation != expected.generation
        || fence.command_sequence != expected.command_sequence
        || fence.windows_session_id != expected.windows_session_id
        || fence.video_frame_sequence != expected.frame_sequence
        || fence.video_qpc_position_100ns != expected.qpc_position_100ns
        || fence.target_process_id == 0
        || fence.target_process_creation_time_100ns == 0
    {
        return Err(MediaFrameError::AudioPacket);
    }

    let mut packets = Vec::with_capacity(count);
    let mut offset = WORKER_AUDIO_BATCH_HEADER_SIZE;
    for _ in 0..count {
        let header_end = offset
            .checked_add(WORKER_AUDIO_PACKET_HEADER_SIZE)
            .ok_or(MediaFrameError::AudioPacket)?;
        let header = frame
            .get(offset..header_end)
            .ok_or(MediaFrameError::AudioPacket)?;
        if read_u32(header, 0)? as usize != WORKER_AUDIO_PACKET_HEADER_SIZE
            || header[40..48].iter().any(|byte| *byte != 0)
        {
            return Err(MediaFrameError::AudioPacket);
        }
        let sample_rate = read_u32(header, 4)?;
        let channels = u16::from_le_bytes([header[8], header[9]]);
        let sample_format =
            audio_sample_format_from_id(u16::from_le_bytes([header[10], header[11]]))?;
        let frames = read_u32(header, 12)?;
        let flags = read_u32(header, 16)?;
        let payload_bytes = read_u32(header, 20)? as usize;
        let device_position_frames = read_u64(header, 24)?;
        let qpc_position_100ns = read_u64(header, 32)?;
        if flags & !(WORKER_AUDIO_FLAG_SILENT | WORKER_AUDIO_FLAG_DISCONTINUITY) != 0
            || payload_bytes == 0
            || payload_bytes > WORKER_AUDIO_PACKET_MAX_BYTES
        {
            return Err(MediaFrameError::AudioPacket);
        }
        offset = header_end;
        let payload_end = offset
            .checked_add(payload_bytes)
            .ok_or(MediaFrameError::AudioPacket)?;
        let bytes = frame
            .get(offset..payload_end)
            .ok_or(MediaFrameError::AudioPacket)?
            .to_vec();
        let packet = BoundAudioPacket {
            sample_rate,
            channels,
            sample_format,
            frames,
            device_position_frames,
            qpc_position_100ns,
            silent: flags & WORKER_AUDIO_FLAG_SILENT != 0,
            discontinuity: flags & WORKER_AUDIO_FLAG_DISCONTINUITY != 0,
            bytes,
        };
        validate_bound_audio_packet(&packet)?;
        if packet.qpc_position_100ns != 0
            && packet.qpc_position_100ns > fence.video_qpc_position_100ns
        {
            return Err(MediaFrameError::AudioPacket);
        }
        packets.push(packet);
        offset = payload_end;
    }
    if offset != frame.len() {
        return Err(MediaFrameError::AudioPacket);
    }
    Ok((fence, packets))
}

fn validate_bound_audio_packet(packet: &BoundAudioPacket) -> Result<(), MediaFrameError> {
    let expected_bytes = (packet.frames as usize)
        .checked_mul(packet.channels as usize)
        .and_then(|frames| frames.checked_mul(audio_bytes_per_sample(packet.sample_format)))
        .ok_or(MediaFrameError::AudioPacket)?;
    let silence_sample = if packet.sample_format == AudioSampleFormat::PcmUint8 {
        0x80
    } else {
        0
    };
    if !(8_000..=192_000).contains(&packet.sample_rate)
        || !(1..=8).contains(&packet.channels)
        || packet.frames == 0
        || packet.bytes.is_empty()
        || packet.bytes.len() > WORKER_AUDIO_PACKET_MAX_BYTES
        || packet.bytes.len() != expected_bytes
        || (!packet.discontinuity && packet.qpc_position_100ns == 0)
        || (packet.silent && packet.bytes.iter().any(|byte| *byte != silence_sample))
    {
        return Err(MediaFrameError::AudioPacket);
    }
    Ok(())
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
            frame_flags: MEDIA_FRAME_FLAG_KEYFRAME,
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
            qpc_position_100ns: 123_456_789,
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
        assert_eq!(encoded[5], MEDIA_FRAME_FLAG_KEYFRAME);
        assert_eq!(&encoded[6..8], &[0, 0]);
        assert_eq!(
            decode_worker_media_frame_header(&encoded)
                .unwrap()
                .qpc_position_100ns,
            123_456_789
        );
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
        assert!(matches!(
            bind_worker_media_payload(header(), vec![1, 2, 3, 4]),
            Err(MediaFrameError::PayloadLength)
        ));
        assert!(matches!(
            bind_worker_media_payload(header(), vec![0; 5]),
            Err(MediaFrameError::EmptyPayload)
        ));
    }

    #[test]
    fn unknown_frame_flags_are_rejected() {
        let mut invalid = header();
        invalid.frame_flags = 0x80;
        assert_eq!(
            encode_worker_media_frame_header(invalid),
            Err(MediaFrameError::FrameFlags)
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

    #[test]
    fn audio_batch_is_bounded_and_fenced_to_the_video_frame_and_game_generation() {
        let video = header();
        let fence = WorkerAudioBatchFence {
            generation: video.generation,
            command_sequence: video.command_sequence,
            windows_session_id: video.windows_session_id,
            video_frame_sequence: video.frame_sequence,
            video_qpc_position_100ns: video.qpc_position_100ns,
            target_process_id: 4_321,
            target_process_creation_time_100ns: 987_654_321,
        };
        let packet = AudioPacket {
            sample_rate: 48_000,
            channels: 2,
            sample_format: AudioSampleFormat::IeeeFloat32,
            frames: 2,
            device_position_frames: 1_024,
            qpc_position_100ns: 123_456_788,
            silent: false,
            discontinuity: false,
            bytes: vec![0x7f; 16],
        };
        let wire = encode_worker_audio_batch(fence, &[packet]).expect("audio batch");
        let (decoded_fence, decoded) =
            decode_worker_audio_batch(&wire, video).expect("decode audio batch");
        assert_eq!(decoded_fence, fence);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].sample_rate, 48_000);
        assert_eq!(decoded[0].channels, 2);
        assert_eq!(decoded[0].frames, 2);
        assert_eq!(decoded[0].qpc_position_100ns, 123_456_788);
        assert_eq!(decoded[0].bytes, [0x7f; 16]);

        let mut stale = video;
        stale.frame_sequence += 1;
        assert!(matches!(
            decode_worker_audio_batch(&wire, stale),
            Err(MediaFrameError::AudioPacket)
        ));
    }

    #[test]
    fn empty_audio_batch_is_explicit_and_malformed_audio_never_falls_back() {
        let video = header();
        let fence = WorkerAudioBatchFence {
            generation: video.generation,
            command_sequence: video.command_sequence,
            windows_session_id: video.windows_session_id,
            video_frame_sequence: video.frame_sequence,
            video_qpc_position_100ns: video.qpc_position_100ns,
            target_process_id: 4_321,
            target_process_creation_time_100ns: 987_654_321,
        };
        let empty = encode_worker_audio_batch(fence, &[]).expect("empty audio batch");
        let (_, packets) = decode_worker_audio_batch(&empty, video).expect("decode empty batch");
        assert!(packets.is_empty());

        let mut invalid = empty;
        invalid[56] = 1;
        assert!(matches!(
            decode_worker_audio_batch(&invalid, video),
            Err(MediaFrameError::AudioPacket)
        ));
        assert!(matches!(
            encode_worker_audio_batch(
                WorkerAudioBatchFence {
                    target_process_id: 0,
                    ..fence
                },
                &[]
            ),
            Err(MediaFrameError::AudioPacket)
        ));
    }
}
