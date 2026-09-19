//! Browser-facing H.264 chunk envelope for the Windows-native media plane.
//!
//! Internal GPU/LUID/display proof fields deliberately never cross this boundary.
//! One encoded NVENC frame may be split into multiple WebSocket binary messages so
//! the transport remains well below the existing 4 MiB gateway frame ceiling.

pub const BROWSER_MEDIA_PROTOCOL_VERSION: u16 = 1;
pub const BROWSER_MEDIA_HEADER_SIZE: usize = 44;
pub const BROWSER_MEDIA_FRAME_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const BROWSER_MEDIA_CHUNK_MAX_BYTES: usize = 1024 * 1024;
pub const BROWSER_MEDIA_CODEC_H264: u8 = 1;
pub const BROWSER_MEDIA_FLAG_KEYFRAME: u8 = 0x01;
const BROWSER_MEDIA_MAGIC: [u8; 4] = *b"GBNM";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserMediaChunkHeader {
    pub protocol_version: u16,
    pub codec: u8,
    pub flags: u8,
    pub stream_epoch: u64,
    pub frame_sequence: u64,
    pub width: u32,
    pub height: u32,
    pub frame_bytes: u32,
    pub chunk_offset: u32,
    pub chunk_bytes: u32,
}

impl BrowserMediaChunkHeader {
    pub const fn is_keyframe(self) -> bool {
        self.flags & BROWSER_MEDIA_FLAG_KEYFRAME != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserMediaChunk {
    pub offset: usize,
    pub len: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserMediaError {
    InvalidLength,
    Magic,
    ProtocolVersion,
    Codec,
    Flags,
    StreamEpoch,
    FrameSequence,
    Dimensions,
    FrameLength,
    ChunkLength,
    ChunkRange,
}

fn read_u32(frame: &[u8], offset: usize) -> Result<u32, BrowserMediaError> {
    let bytes: [u8; 4] = frame
        .get(offset..offset + 4)
        .ok_or(BrowserMediaError::InvalidLength)?
        .try_into()
        .map_err(|_| BrowserMediaError::InvalidLength)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(frame: &[u8], offset: usize) -> Result<u64, BrowserMediaError> {
    let bytes: [u8; 8] = frame
        .get(offset..offset + 8)
        .ok_or(BrowserMediaError::InvalidLength)?
        .try_into()
        .map_err(|_| BrowserMediaError::InvalidLength)?;
    Ok(u64::from_le_bytes(bytes))
}

fn validate_header(header: BrowserMediaChunkHeader) -> Result<(), BrowserMediaError> {
    if header.protocol_version != BROWSER_MEDIA_PROTOCOL_VERSION {
        return Err(BrowserMediaError::ProtocolVersion);
    }
    if header.codec != BROWSER_MEDIA_CODEC_H264 {
        return Err(BrowserMediaError::Codec);
    }
    if header.flags & !BROWSER_MEDIA_FLAG_KEYFRAME != 0 {
        return Err(BrowserMediaError::Flags);
    }
    if header.stream_epoch == 0 {
        return Err(BrowserMediaError::StreamEpoch);
    }
    if header.frame_sequence == 0 {
        return Err(BrowserMediaError::FrameSequence);
    }
    if !(640..=7680).contains(&header.width) || !(480..=4320).contains(&header.height) {
        return Err(BrowserMediaError::Dimensions);
    }
    if header.frame_bytes == 0 || header.frame_bytes as usize > BROWSER_MEDIA_FRAME_MAX_BYTES {
        return Err(BrowserMediaError::FrameLength);
    }
    if header.chunk_bytes == 0 || header.chunk_bytes as usize > BROWSER_MEDIA_CHUNK_MAX_BYTES {
        return Err(BrowserMediaError::ChunkLength);
    }

    let end = header
        .chunk_offset
        .checked_add(header.chunk_bytes)
        .ok_or(BrowserMediaError::ChunkRange)?;
    if header.chunk_offset >= header.frame_bytes || end > header.frame_bytes {
        return Err(BrowserMediaError::ChunkRange);
    }
    Ok(())
}

pub fn encode_browser_media_header(
    header: BrowserMediaChunkHeader,
) -> Result<[u8; BROWSER_MEDIA_HEADER_SIZE], BrowserMediaError> {
    validate_header(header)?;

    let mut out = [0u8; BROWSER_MEDIA_HEADER_SIZE];
    out[0..4].copy_from_slice(&BROWSER_MEDIA_MAGIC);
    out[4..6].copy_from_slice(&header.protocol_version.to_le_bytes());
    out[6] = header.codec;
    out[7] = header.flags;
    out[8..16].copy_from_slice(&header.stream_epoch.to_le_bytes());
    out[16..24].copy_from_slice(&header.frame_sequence.to_le_bytes());
    out[24..28].copy_from_slice(&header.width.to_le_bytes());
    out[28..32].copy_from_slice(&header.height.to_le_bytes());
    out[32..36].copy_from_slice(&header.frame_bytes.to_le_bytes());
    out[36..40].copy_from_slice(&header.chunk_offset.to_le_bytes());
    out[40..44].copy_from_slice(&header.chunk_bytes.to_le_bytes());
    Ok(out)
}

pub fn decode_browser_media_header(
    frame: &[u8],
) -> Result<BrowserMediaChunkHeader, BrowserMediaError> {
    if frame.len() != BROWSER_MEDIA_HEADER_SIZE {
        return Err(BrowserMediaError::InvalidLength);
    }
    if frame[0..4] != BROWSER_MEDIA_MAGIC {
        return Err(BrowserMediaError::Magic);
    }

    let header = BrowserMediaChunkHeader {
        protocol_version: u16::from_le_bytes([frame[4], frame[5]]),
        codec: frame[6],
        flags: frame[7],
        stream_epoch: read_u64(frame, 8)?,
        frame_sequence: read_u64(frame, 16)?,
        width: read_u32(frame, 24)?,
        height: read_u32(frame, 28)?,
        frame_bytes: read_u32(frame, 32)?,
        chunk_offset: read_u32(frame, 36)?,
        chunk_bytes: read_u32(frame, 40)?,
    };
    validate_header(header)?;
    Ok(header)
}

pub fn browser_media_chunk_plan(
    frame_bytes: usize,
) -> Result<Vec<BrowserMediaChunk>, BrowserMediaError> {
    if frame_bytes == 0 || frame_bytes > BROWSER_MEDIA_FRAME_MAX_BYTES {
        return Err(BrowserMediaError::FrameLength);
    }

    let mut chunks = Vec::with_capacity(frame_bytes.div_ceil(BROWSER_MEDIA_CHUNK_MAX_BYTES));
    let mut offset = 0usize;
    while offset < frame_bytes {
        let len = (frame_bytes - offset).min(BROWSER_MEDIA_CHUNK_MAX_BYTES);
        chunks.push(BrowserMediaChunk { offset, len });
        offset = offset
            .checked_add(len)
            .ok_or(BrowserMediaError::ChunkRange)?;
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> BrowserMediaChunkHeader {
        BrowserMediaChunkHeader {
            protocol_version: BROWSER_MEDIA_PROTOCOL_VERSION,
            codec: BROWSER_MEDIA_CODEC_H264,
            flags: BROWSER_MEDIA_FLAG_KEYFRAME,
            stream_epoch: 3,
            frame_sequence: 7,
            width: 3840,
            height: 2160,
            frame_bytes: 2_500_000,
            chunk_offset: 1_048_576,
            chunk_bytes: 1_048_576,
        }
    }

    #[test]
    fn fixed_header_round_trips_without_internal_gpu_identity() {
        let value = header();
        let encoded = encode_browser_media_header(value).expect("encode header");
        assert_eq!(encoded.len(), BROWSER_MEDIA_HEADER_SIZE);
        assert_eq!(&encoded[0..4], b"GBNM");
        assert_eq!(decode_browser_media_header(&encoded), Ok(value));
    }

    #[test]
    fn epoch_sequence_and_keyframe_flag_are_explicit() {
        assert!(header().is_keyframe());

        let mut non_keyframe = header();
        non_keyframe.flags = 0;
        assert!(!non_keyframe.is_keyframe());
        assert!(encode_browser_media_header(non_keyframe).is_ok());

        let mut invalid = header();
        invalid.flags = 0x80;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::Flags)
        );

        let mut invalid = header();
        invalid.stream_epoch = 0;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::StreamEpoch)
        );

        let mut invalid = header();
        invalid.frame_sequence = 0;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::FrameSequence)
        );
    }

    #[test]
    fn chunk_plan_covers_frame_exactly_without_exceeding_one_mib() {
        for frame_bytes in [
            1usize,
            BROWSER_MEDIA_CHUNK_MAX_BYTES,
            BROWSER_MEDIA_CHUNK_MAX_BYTES + 1,
            2_500_000,
            BROWSER_MEDIA_FRAME_MAX_BYTES,
        ] {
            let chunks = browser_media_chunk_plan(frame_bytes).expect("chunk plan");
            assert!(!chunks.is_empty());
            assert_eq!(chunks.first().expect("first").offset, 0);
            assert_eq!(
                chunks.iter().map(|chunk| chunk.len).sum::<usize>(),
                frame_bytes
            );

            let mut expected_offset = 0usize;
            for chunk in chunks {
                assert_eq!(chunk.offset, expected_offset);
                assert!((1..=BROWSER_MEDIA_CHUNK_MAX_BYTES).contains(&chunk.len));
                expected_offset += chunk.len;
            }
            assert_eq!(expected_offset, frame_bytes);
        }
    }

    #[test]
    fn frame_and_chunk_bounds_fail_before_transport() {
        for frame_bytes in [0, BROWSER_MEDIA_FRAME_MAX_BYTES + 1] {
            assert_eq!(
                browser_media_chunk_plan(frame_bytes),
                Err(BrowserMediaError::FrameLength)
            );
        }

        let mut invalid = header();
        invalid.chunk_bytes = 0;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::ChunkLength)
        );

        let mut invalid = header();
        invalid.chunk_bytes = (BROWSER_MEDIA_CHUNK_MAX_BYTES as u32) + 1;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::ChunkLength)
        );

        let mut invalid = header();
        invalid.chunk_offset = invalid.frame_bytes - 10;
        invalid.chunk_bytes = 11;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::ChunkRange)
        );
    }

    #[test]
    fn codec_dimensions_and_frame_size_are_strict() {
        let mut invalid = header();
        invalid.width = 639;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::Dimensions)
        );

        let mut invalid = header();
        invalid.codec = 2;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::Codec)
        );

        let mut invalid = header();
        invalid.frame_bytes = (BROWSER_MEDIA_FRAME_MAX_BYTES as u32) + 1;
        assert_eq!(
            encode_browser_media_header(invalid),
            Err(BrowserMediaError::FrameLength)
        );
    }

    #[test]
    fn malformed_wire_header_is_rejected() {
        let encoded = encode_browser_media_header(header()).expect("header");
        for cut in 0..BROWSER_MEDIA_HEADER_SIZE {
            assert_eq!(
                decode_browser_media_header(&encoded[..cut]),
                Err(BrowserMediaError::InvalidLength)
            );
        }

        let mut wrong_magic = encoded;
        wrong_magic[0] ^= 0xff;
        assert_eq!(
            decode_browser_media_header(&wrong_magic),
            Err(BrowserMediaError::Magic)
        );
    }
}
