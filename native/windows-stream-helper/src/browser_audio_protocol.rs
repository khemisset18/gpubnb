//! Browser-facing PCM audio envelope bound to the video capture clock.
//!
//! Audio packets use the same authenticated WebSocket as video. The host-side
//! worker includes both the audio QPC position and the associated video QPC
//! position so the player can correct drift without exposing host identifiers.

use gpubnb_windows_platform::media::AudioSampleFormat;

pub const BROWSER_AUDIO_PROTOCOL_VERSION: u16 = 1;
pub const BROWSER_AUDIO_HEADER_SIZE: usize = 64;
pub const BROWSER_AUDIO_PACKET_MAX_BYTES: usize = 512 * 1024;
const BROWSER_AUDIO_MAGIC: [u8; 4] = *b"GBNA";
const BROWSER_AUDIO_FLAG_SILENT: u32 = 1 << 0;
const BROWSER_AUDIO_FLAG_DISCONTINUITY: u32 = 1 << 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserAudioPacketHeader {
    pub protocol_version: u16,
    pub sample_format: AudioSampleFormat,
    pub stream_epoch: u64,
    pub frame_sequence: u64,
    pub audio_qpc_position_100ns: u64,
    pub video_qpc_position_100ns: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u32,
    pub silent: bool,
    pub discontinuity: bool,
    pub payload_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserAudioError {
    InvalidLength,
    Magic,
    Version,
    Format,
    Epoch,
    FrameSequence,
    Timestamp,
    SampleRate,
    Channels,
    FrameCount,
    Flags,
    PayloadLength,
    Silence,
}

fn read_u32(frame: &[u8], offset: usize) -> Result<u32, BrowserAudioError> {
    let bytes: [u8; 4] = frame
        .get(offset..offset + 4)
        .ok_or(BrowserAudioError::InvalidLength)?
        .try_into()
        .map_err(|_| BrowserAudioError::InvalidLength)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(frame: &[u8], offset: usize) -> Result<u64, BrowserAudioError> {
    let bytes: [u8; 8] = frame
        .get(offset..offset + 8)
        .ok_or(BrowserAudioError::InvalidLength)?
        .try_into()
        .map_err(|_| BrowserAudioError::InvalidLength)?;
    Ok(u64::from_le_bytes(bytes))
}

fn sample_format_id(format: AudioSampleFormat) -> u16 {
    match format {
        AudioSampleFormat::IeeeFloat32 => 1,
        AudioSampleFormat::PcmUint8 => 2,
        AudioSampleFormat::PcmInt16 => 3,
        AudioSampleFormat::PcmInt24 => 4,
        AudioSampleFormat::PcmInt32 => 5,
    }
}

fn sample_format_from_id(value: u16) -> Result<AudioSampleFormat, BrowserAudioError> {
    match value {
        1 => Ok(AudioSampleFormat::IeeeFloat32),
        2 => Ok(AudioSampleFormat::PcmUint8),
        3 => Ok(AudioSampleFormat::PcmInt16),
        4 => Ok(AudioSampleFormat::PcmInt24),
        5 => Ok(AudioSampleFormat::PcmInt32),
        _ => Err(BrowserAudioError::Format),
    }
}

fn bytes_per_sample(format: AudioSampleFormat) -> usize {
    match format {
        AudioSampleFormat::IeeeFloat32 | AudioSampleFormat::PcmInt32 => 4,
        AudioSampleFormat::PcmUint8 => 1,
        AudioSampleFormat::PcmInt16 => 2,
        AudioSampleFormat::PcmInt24 => 3,
    }
}

fn validate(header: BrowserAudioPacketHeader, payload_len: usize) -> Result<(), BrowserAudioError> {
    if header.protocol_version != BROWSER_AUDIO_PROTOCOL_VERSION {
        return Err(BrowserAudioError::Version);
    }
    if header.stream_epoch == 0 {
        return Err(BrowserAudioError::Epoch);
    }
    if header.frame_sequence == 0 {
        return Err(BrowserAudioError::FrameSequence);
    }
    if header.video_qpc_position_100ns == 0
        || (header.audio_qpc_position_100ns == 0 && !header.discontinuity)
        || (header.audio_qpc_position_100ns != 0
            && header.audio_qpc_position_100ns > header.video_qpc_position_100ns)
    {
        return Err(BrowserAudioError::Timestamp);
    }
    if !(8_000..=192_000).contains(&header.sample_rate) {
        return Err(BrowserAudioError::SampleRate);
    }
    if !(1..=8).contains(&header.channels) {
        return Err(BrowserAudioError::Channels);
    }
    if header.frames == 0 {
        return Err(BrowserAudioError::FrameCount);
    }
    let expected = (header.frames as usize)
        .checked_mul(usize::from(header.channels))
        .and_then(|samples| samples.checked_mul(bytes_per_sample(header.sample_format)))
        .ok_or(BrowserAudioError::PayloadLength)?;
    if header.payload_bytes == 0
        || header.payload_bytes as usize > BROWSER_AUDIO_PACKET_MAX_BYTES
        || header.payload_bytes as usize != payload_len
        || expected != payload_len
    {
        return Err(BrowserAudioError::PayloadLength);
    }
    Ok(())
}

pub fn encode_browser_audio_header(
    header: BrowserAudioPacketHeader,
) -> Result<[u8; BROWSER_AUDIO_HEADER_SIZE], BrowserAudioError> {
    validate(header, header.payload_bytes as usize)?;
    let mut out = [0u8; BROWSER_AUDIO_HEADER_SIZE];
    out[0..4].copy_from_slice(&BROWSER_AUDIO_MAGIC);
    out[4..6].copy_from_slice(&header.protocol_version.to_le_bytes());
    out[6..8].copy_from_slice(&sample_format_id(header.sample_format).to_le_bytes());
    out[8..16].copy_from_slice(&header.stream_epoch.to_le_bytes());
    out[16..24].copy_from_slice(&header.frame_sequence.to_le_bytes());
    out[24..32].copy_from_slice(&header.audio_qpc_position_100ns.to_le_bytes());
    out[32..40].copy_from_slice(&header.video_qpc_position_100ns.to_le_bytes());
    out[40..44].copy_from_slice(&header.sample_rate.to_le_bytes());
    out[44..46].copy_from_slice(&header.channels.to_le_bytes());
    out[46..48].copy_from_slice(&0u16.to_le_bytes());
    out[48..52].copy_from_slice(&header.frames.to_le_bytes());
    let flags = (if header.silent {
        BROWSER_AUDIO_FLAG_SILENT
    } else {
        0
    }) | (if header.discontinuity {
        BROWSER_AUDIO_FLAG_DISCONTINUITY
    } else {
        0
    });
    out[52..56].copy_from_slice(&flags.to_le_bytes());
    out[56..60].copy_from_slice(&header.payload_bytes.to_le_bytes());
    // 60..64 are reserved and intentionally remain zero.
    Ok(out)
}

pub fn decode_browser_audio_packet(
    packet: &[u8],
) -> Result<(BrowserAudioPacketHeader, &[u8]), BrowserAudioError> {
    if packet.len() < BROWSER_AUDIO_HEADER_SIZE {
        return Err(BrowserAudioError::InvalidLength);
    }
    let header_bytes = &packet[..BROWSER_AUDIO_HEADER_SIZE];
    if header_bytes[0..4] != BROWSER_AUDIO_MAGIC {
        return Err(BrowserAudioError::Magic);
    }
    if header_bytes[46..48] != [0, 0] || header_bytes[60..64] != [0, 0, 0, 0] {
        return Err(BrowserAudioError::Flags);
    }
    let flags = read_u32(header_bytes, 52)?;
    if flags & !(BROWSER_AUDIO_FLAG_SILENT | BROWSER_AUDIO_FLAG_DISCONTINUITY) != 0 {
        return Err(BrowserAudioError::Flags);
    }
    let payload = &packet[BROWSER_AUDIO_HEADER_SIZE..];
    let header = BrowserAudioPacketHeader {
        protocol_version: u16::from_le_bytes([header_bytes[4], header_bytes[5]]),
        sample_format: sample_format_from_id(u16::from_le_bytes([
            header_bytes[6],
            header_bytes[7],
        ]))?,
        stream_epoch: read_u64(header_bytes, 8)?,
        frame_sequence: read_u64(header_bytes, 16)?,
        audio_qpc_position_100ns: read_u64(header_bytes, 24)?,
        video_qpc_position_100ns: read_u64(header_bytes, 32)?,
        sample_rate: read_u32(header_bytes, 40)?,
        channels: u16::from_le_bytes([header_bytes[44], header_bytes[45]]),
        frames: read_u32(header_bytes, 48)?,
        silent: flags & BROWSER_AUDIO_FLAG_SILENT != 0,
        discontinuity: flags & BROWSER_AUDIO_FLAG_DISCONTINUITY != 0,
        payload_bytes: read_u32(header_bytes, 56)?,
    };
    validate(header, payload.len())?;
    if packet.len() != BROWSER_AUDIO_HEADER_SIZE + header.payload_bytes as usize {
        return Err(BrowserAudioError::InvalidLength);
    }
    if header.silent {
        let sample = if header.sample_format == AudioSampleFormat::PcmUint8 {
            0x80
        } else {
            0
        };
        if payload.iter().any(|byte| *byte != sample) {
            return Err(BrowserAudioError::Silence);
        }
    }
    Ok((header, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> BrowserAudioPacketHeader {
        BrowserAudioPacketHeader {
            protocol_version: BROWSER_AUDIO_PROTOCOL_VERSION,
            sample_format: AudioSampleFormat::IeeeFloat32,
            stream_epoch: 3,
            frame_sequence: 9,
            audio_qpc_position_100ns: 800,
            video_qpc_position_100ns: 900,
            sample_rate: 48_000,
            channels: 2,
            frames: 2,
            silent: false,
            discontinuity: false,
            payload_bytes: 16,
        }
    }

    #[test]
    fn audio_packet_header_and_payload_round_trip_with_av_clock_fence() {
        let header = header();
        let encoded = encode_browser_audio_header(header).expect("audio header");
        let mut packet = encoded.to_vec();
        packet.extend_from_slice(&[0x5a; 16]);
        let (decoded, payload) = decode_browser_audio_packet(&packet).expect("audio packet");
        assert_eq!(decoded, header);
        assert_eq!(payload, [0x5a; 16]);
    }

    #[test]
    fn invalid_size_clock_format_and_silence_are_rejected() {
        let mut invalid = header();
        invalid.video_qpc_position_100ns = 0;
        assert_eq!(
            encode_browser_audio_header(invalid).err(),
            Some(BrowserAudioError::Timestamp)
        );

        let header = encode_browser_audio_header(header()).expect("header");
        let mut wrong_format = header.to_vec();
        wrong_format[6..8].copy_from_slice(&99u16.to_le_bytes());
        assert_eq!(
            decode_browser_audio_packet(&wrong_format),
            Err(BrowserAudioError::Format)
        );

        let mut wrong_silence = header.to_vec();
        wrong_silence[52..56].copy_from_slice(&BROWSER_AUDIO_FLAG_SILENT.to_le_bytes());
        wrong_silence.extend_from_slice(&[0x7f; 16]);
        assert_eq!(
            decode_browser_audio_packet(&wrong_silence).err(),
            Some(BrowserAudioError::Silence)
        );
    }
}
