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
    PacketLength,
    FrameOrder,
    FrameMismatch,
    KeyframeRequired,
    Timeout,
    InvalidTimeout,
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

pub const BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS: u64 = 2_000;

/// One complete browser-facing H.264 access unit.
///
/// Intentionally no Debug/Clone implementation: encoded renter pixels should not
/// be duplicated or emitted through diagnostics by convenience derives.
pub struct CompletedBrowserMediaFrame {
    pub stream_epoch: u64,
    pub frame_sequence: u64,
    pub width: u32,
    pub height: u32,
    pub keyframe: bool,
    pub bytes: Vec<u8>,
}

struct PendingBrowserMediaFrame {
    stream_epoch: u64,
    frame_sequence: u64,
    width: u32,
    height: u32,
    frame_bytes: u32,
    flags: u8,
    next_offset: u32,
    started_at_ms: u64,
    bytes: Vec<u8>,
}

/// Strict single-frame reassembler for binary WebSocket media messages.
///
/// A caller supplies a monotonic millisecond clock. Only one bounded frame may be
/// incomplete at once. Any malformed ordering, timeout, or metadata mismatch
/// discards partial bytes and requires a fresh keyframe before decoding resumes.
pub struct BrowserMediaReassembler {
    pending: Option<PendingBrowserMediaFrame>,
    last_completed: Option<(u64, u64)>,
    require_keyframe: bool,
    timeout_ms: u64,
}

impl BrowserMediaReassembler {
    pub fn new(timeout_ms: u64) -> Result<Self, BrowserMediaError> {
        if timeout_ms == 0 {
            return Err(BrowserMediaError::InvalidTimeout);
        }
        Ok(Self {
            pending: None,
            last_completed: None,
            require_keyframe: true,
            timeout_ms,
        })
    }

    fn reject<T>(&mut self, error: BrowserMediaError) -> Result<T, BrowserMediaError> {
        self.pending = None;
        self.require_keyframe = true;
        Err(error)
    }

    pub fn reset(&mut self) {
        self.pending = None;
        self.require_keyframe = true;
    }

    pub fn push_chunk(
        &mut self,
        packet: &[u8],
        now_ms: u64,
    ) -> Result<Option<CompletedBrowserMediaFrame>, BrowserMediaError> {
        if let Some(pending) = self.pending.as_ref()
            && now_ms.saturating_sub(pending.started_at_ms) > self.timeout_ms
        {
            return self.reject(BrowserMediaError::Timeout);
        }

        if packet.len() < BROWSER_MEDIA_HEADER_SIZE {
            return self.reject(BrowserMediaError::PacketLength);
        }

        let header = match decode_browser_media_header(&packet[..BROWSER_MEDIA_HEADER_SIZE]) {
            Ok(header) => header,
            Err(error) => return self.reject(error),
        };
        let expected_packet_bytes =
            match BROWSER_MEDIA_HEADER_SIZE.checked_add(header.chunk_bytes as usize) {
                Some(value) => value,
                None => return self.reject(BrowserMediaError::PacketLength),
            };
        if packet.len() != expected_packet_bytes {
            return self.reject(BrowserMediaError::PacketLength);
        }
        let payload = &packet[BROWSER_MEDIA_HEADER_SIZE..];

        if let Some(pending) = self.pending.as_ref()
            && (header.stream_epoch != pending.stream_epoch
                || header.frame_sequence != pending.frame_sequence)
        {
            // A strictly newer epoch invalidates any partial frame immediately.
            // It may start only with a fresh keyframe at offset zero.
            if header.stream_epoch > pending.stream_epoch
                && header.chunk_offset == 0
                && header.is_keyframe()
            {
                self.pending = None;
                self.require_keyframe = true;
            } else {
                return self.reject(BrowserMediaError::FrameOrder);
            }
        }

        if let Some(pending) = self.pending.as_ref() {
            if header.width != pending.width
                || header.height != pending.height
                || header.frame_bytes != pending.frame_bytes
                || header.flags != pending.flags
            {
                return self.reject(BrowserMediaError::FrameMismatch);
            }
            if header.chunk_offset != pending.next_offset {
                return self.reject(BrowserMediaError::FrameOrder);
            }
        } else {
            if header.chunk_offset != 0 {
                return self.reject(BrowserMediaError::FrameOrder);
            }

            if let Some((last_epoch, last_sequence)) = self.last_completed {
                if header.stream_epoch < last_epoch {
                    return self.reject(BrowserMediaError::FrameOrder);
                }
                if header.stream_epoch == last_epoch {
                    let Some(expected_sequence) = last_sequence.checked_add(1) else {
                        return self.reject(BrowserMediaError::FrameOrder);
                    };
                    if header.frame_sequence != expected_sequence {
                        return self.reject(BrowserMediaError::FrameOrder);
                    }
                } else {
                    self.require_keyframe = true;
                }
            }

            if self.require_keyframe && !header.is_keyframe() {
                return self.reject(BrowserMediaError::KeyframeRequired);
            }

            self.pending = Some(PendingBrowserMediaFrame {
                stream_epoch: header.stream_epoch,
                frame_sequence: header.frame_sequence,
                width: header.width,
                height: header.height,
                frame_bytes: header.frame_bytes,
                flags: header.flags,
                next_offset: 0,
                started_at_ms: now_ms,
                bytes: Vec::with_capacity(header.frame_bytes as usize),
            });
        }

        let pending_snapshot = self.pending.as_ref().expect("pending frame established");
        let next_offset = match pending_snapshot.next_offset.checked_add(header.chunk_bytes) {
            Some(value) => value,
            None => return self.reject(BrowserMediaError::ChunkRange),
        };
        let frame_bytes = pending_snapshot.frame_bytes;
        if next_offset > frame_bytes {
            return self.reject(BrowserMediaError::ChunkRange);
        }

        {
            let pending = self.pending.as_mut().expect("pending frame established");
            pending.bytes.extend_from_slice(payload);
            pending.next_offset = next_offset;
        }

        if next_offset < frame_bytes {
            return Ok(None);
        }
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.bytes.len() != frame_bytes as usize)
        {
            return self.reject(BrowserMediaError::ChunkRange);
        }

        let completed = self.pending.take().expect("completed pending frame");
        self.last_completed = Some((completed.stream_epoch, completed.frame_sequence));
        self.require_keyframe = false;
        Ok(Some(CompletedBrowserMediaFrame {
            stream_epoch: completed.stream_epoch,
            frame_sequence: completed.frame_sequence,
            width: completed.width,
            height: completed.height,
            keyframe: completed.flags & BROWSER_MEDIA_FLAG_KEYFRAME != 0,
            bytes: completed.bytes,
        }))
    }
}

impl Default for BrowserMediaReassembler {
    fn default() -> Self {
        Self::new(BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS)
            .expect("default browser media timeout is non-zero")
    }
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

    fn packet(mut value: BrowserMediaChunkHeader, payload: &[u8]) -> Vec<u8> {
        value.chunk_bytes = payload.len() as u32;
        let mut out = encode_browser_media_header(value)
            .expect("browser header")
            .to_vec();
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn bounded_reassembler_emits_only_complete_contiguous_frames() {
        let mut reassembler = BrowserMediaReassembler::new(1_000).expect("reassembler");
        let mut first = header();
        first.stream_epoch = 1;
        first.frame_sequence = 1;
        first.frame_bytes = 6;
        first.chunk_offset = 0;
        first.flags = BROWSER_MEDIA_FLAG_KEYFRAME;

        assert!(
            reassembler
                .push_chunk(&packet(first, b"abc"), 10)
                .expect("first chunk")
                .is_none()
        );

        let mut second = first;
        second.chunk_offset = 3;
        let frame = reassembler
            .push_chunk(&packet(second, b"def"), 20)
            .expect("second chunk")
            .expect("complete frame");
        assert_eq!(frame.stream_epoch, 1);
        assert_eq!(frame.frame_sequence, 1);
        assert!(frame.keyframe);
        assert_eq!(frame.bytes, b"abcdef");
    }

    #[test]
    fn duplicate_gap_or_sequence_jump_discards_partial_state_and_requires_keyframe() {
        let mut reassembler = BrowserMediaReassembler::new(1_000).expect("reassembler");
        let mut first = header();
        first.stream_epoch = 1;
        first.frame_sequence = 1;
        first.frame_bytes = 6;
        first.chunk_offset = 0;
        first.flags = BROWSER_MEDIA_FLAG_KEYFRAME;
        assert!(
            reassembler
                .push_chunk(&packet(first, b"abc"), 10)
                .expect("first chunk")
                .is_none()
        );
        assert!(matches!(
            reassembler.push_chunk(&packet(first, b"abc"), 11),
            Err(BrowserMediaError::FrameOrder)
        ));

        let mut non_keyframe = first;
        non_keyframe.frame_sequence = 2;
        non_keyframe.frame_bytes = 3;
        non_keyframe.chunk_offset = 0;
        non_keyframe.flags = 0;
        assert!(matches!(
            reassembler.push_chunk(&packet(non_keyframe, b"xyz"), 12),
            Err(BrowserMediaError::KeyframeRequired)
        ));

        let mut recovery = non_keyframe;
        recovery.flags = BROWSER_MEDIA_FLAG_KEYFRAME;
        let frame = reassembler
            .push_chunk(&packet(recovery, b"xyz"), 13)
            .expect("recovery frame")
            .expect("complete recovery");
        assert_eq!(frame.frame_sequence, 2);

        let mut gap = recovery;
        gap.frame_sequence = 4;
        assert!(matches!(
            reassembler.push_chunk(&packet(gap, b"123"), 14),
            Err(BrowserMediaError::FrameOrder)
        ));
    }

    #[test]
    fn newer_epoch_invalidates_partial_frame_and_requires_fresh_keyframe() {
        let mut reassembler = BrowserMediaReassembler::new(1_000).expect("reassembler");
        let mut old = header();
        old.stream_epoch = 7;
        old.frame_sequence = 9;
        old.frame_bytes = 6;
        old.chunk_offset = 0;
        old.flags = BROWSER_MEDIA_FLAG_KEYFRAME;
        assert!(
            reassembler
                .push_chunk(&packet(old, b"abc"), 1)
                .expect("old chunk")
                .is_none()
        );

        let mut next = old;
        next.stream_epoch = 8;
        next.frame_sequence = 1;
        next.frame_bytes = 3;
        next.flags = 0;
        assert!(matches!(
            reassembler.push_chunk(&packet(next, b"new"), 2),
            Err(BrowserMediaError::FrameOrder) | Err(BrowserMediaError::KeyframeRequired)
        ));

        next.flags = BROWSER_MEDIA_FLAG_KEYFRAME;
        let frame = reassembler
            .push_chunk(&packet(next, b"new"), 3)
            .expect("new epoch")
            .expect("complete keyframe");
        assert_eq!(frame.stream_epoch, 8);
        assert_eq!(frame.bytes, b"new");
    }

    #[test]
    fn incomplete_frame_times_out_without_emitting_pixels() {
        let mut reassembler = BrowserMediaReassembler::new(50).expect("reassembler");
        let mut first = header();
        first.stream_epoch = 1;
        first.frame_sequence = 1;
        first.frame_bytes = 6;
        first.chunk_offset = 0;
        first.flags = BROWSER_MEDIA_FLAG_KEYFRAME;
        assert!(
            reassembler
                .push_chunk(&packet(first, b"abc"), 10)
                .expect("partial")
                .is_none()
        );

        let mut second = first;
        second.chunk_offset = 3;
        assert!(matches!(
            reassembler.push_chunk(&packet(second, b"def"), 61),
            Err(BrowserMediaError::Timeout)
        ));
    }

    #[test]
    fn packet_length_is_exactly_header_plus_declared_chunk() {
        let mut reassembler = BrowserMediaReassembler::default();
        let mut value = header();
        value.stream_epoch = 1;
        value.frame_sequence = 1;
        value.frame_bytes = 3;
        value.chunk_offset = 0;
        value.chunk_bytes = 3;
        let mut malformed = encode_browser_media_header(value).expect("header").to_vec();
        malformed.extend_from_slice(b"ab");
        assert!(matches!(
            reassembler.push_chunk(&malformed, 1),
            Err(BrowserMediaError::PacketLength)
        ));
    }
}
