//! Loopback-only browser media transport for controlled physical qualification.

use crate::browser_media_protocol::{
    BROWSER_MEDIA_CODEC_H264, BROWSER_MEDIA_FLAG_KEYFRAME, BROWSER_MEDIA_HEADER_SIZE,
    BROWSER_MEDIA_PROTOCOL_VERSION, BrowserMediaChunkHeader, browser_media_chunk_plan,
    encode_browser_media_header,
};
use crate::local_media_protocol::{
    LOCAL_MEDIA_REQUEST_MAX_BYTES, authenticate_local_media_upgrade,
    validate_accepted_loopback_stream,
};
use crate::service_runtime::QualifiedGraphicsRuntime;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_TIMEOUT: Duration = Duration::from_secs(120);
const IO_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualificationMediaServerError {
    Bind,
    AcceptTimeout,
    Socket,
    Request,
    Upgrade,
    Response,
    Media,
    Protocol,
    InvalidConfiguration,
}

pub struct QualificationMediaServer {
    listener: TcpListener,
    session_id: String,
    stream_epoch: u64,
}

impl QualificationMediaServer {
    pub fn bind(session_id: &str, stream_epoch: u64) -> Result<Self, QualificationMediaServerError> {
        if session_id.is_empty()
            || session_id.len() > 200
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || stream_epoch == 0
        {
            return Err(QualificationMediaServerError::InvalidConfiguration);
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| QualificationMediaServerError::Bind)?;
        let address = listener
            .local_addr()
            .map_err(|_| QualificationMediaServerError::Bind)?;
        if !address.ip().is_loopback() || address.port() == 0 {
            return Err(QualificationMediaServerError::Bind);
        }
        listener
            .set_nonblocking(true)
            .map_err(|_| QualificationMediaServerError::Bind)?;
        Ok(Self {
            listener,
            session_id: session_id.to_owned(),
            stream_epoch,
        })
    }

    pub fn endpoint(&self) -> Result<SocketAddr, QualificationMediaServerError> {
        self.listener
            .local_addr()
            .map_err(|_| QualificationMediaServerError::Bind)
    }

    fn accept(&self) -> Result<TcpStream, QualificationMediaServerError> {
        let deadline = Instant::now() + ACCEPT_TIMEOUT;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => return Ok(stream),
                Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    return Err(QualificationMediaServerError::AcceptTimeout);
                }
                Err(_) => return Err(QualificationMediaServerError::Socket),
            }
        }
    }

    pub fn serve_once(
        &self,
        runtime: &mut QualifiedGraphicsRuntime,
        max_frames: u32,
    ) -> Result<u32, QualificationMediaServerError> {
        if max_frames == 0 || max_frames > 600 {
            return Err(QualificationMediaServerError::InvalidConfiguration);
        }

        let mut stream = self.accept()?;
        validate_accepted_loopback_stream(&stream)
            .map_err(|_| QualificationMediaServerError::Socket)?;
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .map_err(|_| QualificationMediaServerError::Socket)?;
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .map_err(|_| QualificationMediaServerError::Socket)?;

        let request = read_upgrade_request(&mut stream)?;
        let media_token = runtime
            .media_token()
            .ok_or(QualificationMediaServerError::Upgrade)?;
        let upgrade = authenticate_local_media_upgrade(&request, &self.session_id, media_token)
            .map_err(|_| QualificationMediaServerError::Upgrade)?;
        let accept = websocket_accept_value(&upgrade.websocket_key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream
            .write_all(response.as_bytes())
            .map_err(|_| QualificationMediaServerError::Response)?;

        let started = Instant::now();
        let mut sent = 0u32;
        while sent < max_frames {
            if started.elapsed() > STREAM_TIMEOUT {
                return Err(QualificationMediaServerError::Media);
            }
            let frame = match runtime
                .read_media_frame()
                .map_err(|_| QualificationMediaServerError::Media)?
            {
                Some(frame) => frame,
                None => continue,
            };
            let chunks = browser_media_chunk_plan(frame.bytes.len())
                .map_err(|_| QualificationMediaServerError::Protocol)?;
            for chunk in chunks {
                let header = BrowserMediaChunkHeader {
                    protocol_version: BROWSER_MEDIA_PROTOCOL_VERSION,
                    codec: BROWSER_MEDIA_CODEC_H264,
                    flags: if frame.is_keyframe() {
                        BROWSER_MEDIA_FLAG_KEYFRAME
                    } else {
                        0
                    },
                    stream_epoch: self.stream_epoch,
                    frame_sequence: frame.header.frame_sequence,
                    width: frame.header.width,
                    height: frame.header.height,
                    frame_bytes: frame.bytes.len() as u32,
                    chunk_offset: chunk.offset as u32,
                    chunk_bytes: chunk.len as u32,
                };
                let encoded = encode_browser_media_header(header)
                    .map_err(|_| QualificationMediaServerError::Protocol)?;
                let packet_len = BROWSER_MEDIA_HEADER_SIZE
                    .checked_add(chunk.len)
                    .ok_or(QualificationMediaServerError::Protocol)?;
                let mut packet = Vec::with_capacity(packet_len);
                packet.extend_from_slice(&encoded);
                packet.extend_from_slice(&frame.bytes[chunk.offset..chunk.offset + chunk.len]);
                write_websocket_binary(&mut stream, &packet)?;
            }
            sent = sent
                .checked_add(1)
                .ok_or(QualificationMediaServerError::Protocol)?;
        }
        Ok(sent)
    }
}

fn read_upgrade_request(stream: &mut TcpStream) -> Result<Vec<u8>, QualificationMediaServerError> {
    let mut request = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|_| QualificationMediaServerError::Request)?;
        if count == 0 {
            return Err(QualificationMediaServerError::Request);
        }
        request.extend_from_slice(&buffer[..count]);
        if request.len() > LOCAL_MEDIA_REQUEST_MAX_BYTES {
            return Err(QualificationMediaServerError::Request);
        }
        if request.ends_with(b"\r\n\r\n") {
            return Ok(request);
        }
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            return Err(QualificationMediaServerError::Request);
        }
    }
}

fn write_websocket_binary(
    stream: &mut TcpStream,
    payload: &[u8],
) -> Result<(), QualificationMediaServerError> {
    let len = payload.len();
    let mut header = [0u8; 10];
    header[0] = 0x82;
    let header_len = if len <= 125 {
        header[1] = len as u8;
        2
    } else if len <= u16::MAX as usize {
        header[1] = 126;
        header[2..4].copy_from_slice(&(len as u16).to_be_bytes());
        4
    } else {
        header[1] = 127;
        header[2..10].copy_from_slice(&(len as u64).to_be_bytes());
        10
    };
    stream
        .write_all(&header[..header_len])
        .and_then(|_| stream.write_all(payload))
        .map_err(|_| QualificationMediaServerError::Response)
}

pub fn websocket_accept_value(key: &str) -> String {
    let mut material = Vec::with_capacity(key.len() + WEBSOCKET_GUID.len());
    material.extend_from_slice(key.as_bytes());
    material.extend_from_slice(WEBSOCKET_GUID.as_bytes());
    base64_encode(&sha1(&material))
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        out.push(TABLE[(a >> 2) as usize] as char);
        out.push(TABLE[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(c & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn sha1(input: &[u8]) -> [u8; 20] {
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut message = input.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    let mut h0 = 0x6745_2301u32;
    let mut h1 = 0xEFCD_AB89u32;
    let mut h2 = 0x98BA_DCFEu32;
    let mut h3 = 0x1032_5476u32;
    let mut h4 = 0xC3D2_E1F0u32;

    for block in message.chunks_exact(64) {
        let mut words = [0u32; 80];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                block[offset],
                block[offset + 1],
                block[offset + 2],
                block[offset + 3],
            ]);
        }
        for index in 16..80 {
            words[index] = (words[index - 3]
                ^ words[index - 8]
                ^ words[index - 14]
                ^ words[index - 16])
                .rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;
        for (index, word) in words.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (index, value) in [h0, h1, h2, h3, h4].iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_accept_matches_rfc6455_example() {
        assert_eq!(
            websocket_accept_value("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn base64_vectors_are_exact() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn sha1_known_vector_is_exact() {
        assert_eq!(
            sha1(b"abc"),
            [
                0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e,
                0x25, 0x71, 0x78, 0x50, 0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d,
            ]
        );
    }
}
