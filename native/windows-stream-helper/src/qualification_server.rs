//! Loopback-only browser media transport for controlled physical qualification.

use crate::browser_input_protocol::{BROWSER_INPUT_FRAME_SIZE, BrowserInputFence};
use crate::browser_media_protocol::{
    BROWSER_MEDIA_CODEC_H264, BROWSER_MEDIA_FLAG_KEYFRAME, BROWSER_MEDIA_HEADER_SIZE,
    BROWSER_MEDIA_PROTOCOL_VERSION, BrowserMediaChunkHeader, browser_media_chunk_plan,
    encode_browser_media_header,
};
use crate::local_media_protocol::{
    LOCAL_MEDIA_REQUEST_MAX_BYTES, LocalMediaUpgradeError, authenticate_local_media_upgrade,
    validate_accepted_loopback_stream,
};
use crate::service_runtime::QualifiedGraphicsRuntime;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
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
    Input,
    Protocol,
    StaleConnection,
    InvalidConfiguration,
}

fn local_upgrade_rejection_status(error: LocalMediaUpgradeError) -> &'static str {
    match error {
        LocalMediaUpgradeError::Unauthorized => "401 Unauthorized",
        _ => "400 Bad Request",
    }
}

fn write_local_upgrade_rejection(stream: &mut TcpStream, status: &'static str) {
    let response = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    let _ = stream.write_all(response.as_bytes());
}

pub struct QualificationMediaServer {
    listener: TcpListener,
    session_id: String,
    stream_epoch: u64,
}

fn require_connection_epoch(
    connection_epoch: u64,
    runtime_epoch: u64,
) -> Result<(), QualificationMediaServerError> {
    if connection_epoch == 0 || runtime_epoch == 0 || connection_epoch != runtime_epoch {
        return Err(QualificationMediaServerError::StaleConnection);
    }
    Ok(())
}

impl QualificationMediaServer {
    pub fn bind(
        session_id: &str,
        stream_epoch: u64,
    ) -> Result<Self, QualificationMediaServerError> {
        if session_id.is_empty()
            || session_id.len() > 200
            || !session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || stream_epoch == 0
        {
            return Err(QualificationMediaServerError::InvalidConfiguration);
        }
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| QualificationMediaServerError::Bind)?;
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
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    return Err(QualificationMediaServerError::AcceptTimeout);
                }
                Err(_) => return Err(QualificationMediaServerError::Socket),
            }
        }
    }

    fn accept_shared(
        &self,
        running: &AtomicBool,
    ) -> Result<TcpStream, QualificationMediaServerError> {
        while running.load(Ordering::SeqCst) {
            match self.listener.accept() {
                Ok((stream, _)) => return Ok(stream),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return Err(QualificationMediaServerError::Socket),
            }
        }
        Err(QualificationMediaServerError::AcceptTimeout)
    }

    /// Controlled full-duplex browser proof transport.
    ///
    /// This reuses the Stage 2 loopback authentication/media framing and adds
    /// only masked fixed-size browser input fenced to the current stream epoch.
    pub fn serve_interactive_once(
        &self,
        runtime: &mut QualifiedGraphicsRuntime,
        max_frames: u32,
    ) -> Result<(u32, u32), QualificationMediaServerError> {
        if max_frames == 0 || max_frames > 600 {
            return Err(QualificationMediaServerError::InvalidConfiguration);
        }

        let mut stream = self.accept_upgraded(runtime)?;
        let mut input_fence = BrowserInputFence::new(self.stream_epoch)
            .map_err(|_| QualificationMediaServerError::Input)?;
        let started = Instant::now();
        let mut sent = 0u32;
        let mut accepted_input = 0u32;

        while sent < max_frames {
            if started.elapsed() > STREAM_TIMEOUT {
                return Err(QualificationMediaServerError::Media);
            }

            loop {
                match try_read_websocket_client_frame(&mut stream)? {
                    None => break,
                    Some(ClientWebSocketFrame::Input(payload)) => {
                        let event = input_fence
                            .accept(&payload)
                            .map_err(|_| QualificationMediaServerError::Input)?;
                        runtime
                            .inject_input(event)
                            .map_err(|_| QualificationMediaServerError::Input)?;
                        accepted_input = accepted_input
                            .checked_add(1)
                            .ok_or(QualificationMediaServerError::Protocol)?;
                    }
                    Some(ClientWebSocketFrame::Ping(payload)) => {
                        write_websocket_control(&mut stream, 0x0A, &payload)?;
                    }
                    Some(ClientWebSocketFrame::Close(payload)) => {
                        write_websocket_control(&mut stream, 0x08, &payload)?;
                        return Ok((sent, accepted_input));
                    }
                }
            }

            let frame = match runtime
                .read_media_frame()
                .map_err(|_| QualificationMediaServerError::Media)?
            {
                Some(frame) => frame,
                None => {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
            };
            write_browser_media_frame(&mut stream, self.stream_epoch, &frame)?;
            sent = sent
                .checked_add(1)
                .ok_or(QualificationMediaServerError::Protocol)?;
        }

        Ok((sent, accepted_input))
    }

    /// Long-lived authority transport. The runtime remains owned by the authority
    /// process and is borrowed only for one bounded input/media operation at a
    /// time so STATUS/SUSPEND/RESUME/STOP can acquire the same mutex between
    /// frames. No runtime or capability token is serialized to disk.
    pub fn serve_interactive_shared_once(
        &self,
        runtime: &Arc<Mutex<Option<QualifiedGraphicsRuntime>>>,
        running: &AtomicBool,
    ) -> Result<(u64, u64), QualificationMediaServerError> {
        let (mut stream, stream_epoch) = self.accept_upgraded_shared(runtime, running)?;
        let mut input_fence = BrowserInputFence::new(stream_epoch)
            .map_err(|_| QualificationMediaServerError::Input)?;
        let mut sent = 0u64;
        let mut accepted_input = 0u64;

        loop {
            loop {
                match try_read_websocket_client_frame(&mut stream)? {
                    None => break,
                    Some(ClientWebSocketFrame::Input(payload)) => {
                        let event = input_fence
                            .accept(&payload)
                            .map_err(|_| QualificationMediaServerError::Input)?;
                        let mut guard = runtime
                            .lock()
                            .map_err(|_| QualificationMediaServerError::Input)?;
                        let active = guard.as_mut().ok_or(QualificationMediaServerError::Input)?;
                        require_connection_epoch(stream_epoch, active.stream_epoch())?;
                        active
                            .inject_input(event)
                            .map_err(|_| QualificationMediaServerError::Input)?;
                        accepted_input = accepted_input
                            .checked_add(1)
                            .ok_or(QualificationMediaServerError::Protocol)?;
                    }
                    Some(ClientWebSocketFrame::Ping(payload)) => {
                        write_websocket_control(&mut stream, 0x0A, &payload)?;
                    }
                    Some(ClientWebSocketFrame::Close(payload)) => {
                        write_websocket_control(&mut stream, 0x08, &payload)?;
                        return Ok((sent, accepted_input));
                    }
                }
            }

            let mut guard = runtime
                .lock()
                .map_err(|_| QualificationMediaServerError::Media)?;
            let active = guard.as_mut().ok_or(QualificationMediaServerError::Media)?;
            require_connection_epoch(stream_epoch, active.stream_epoch())?;
            match active
                .read_media_frame()
                .map_err(|_| QualificationMediaServerError::Media)?
            {
                Some(frame) => {
                    // Keep the runtime lock through the socket write. SUSPEND
                    // uses the same lock, so it cannot confirm capability
                    // revocation while a pre-suspend frame is still being
                    // delivered on an authenticated connection.
                    write_browser_media_frame(&mut stream, stream_epoch, &frame)?;
                    sent = sent
                        .checked_add(1)
                        .ok_or(QualificationMediaServerError::Protocol)?;
                }
                None => {
                    drop(guard);
                    thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }

    /// Persistent loopback transport for the authority process.
    ///
    /// Browser disconnects, stale-token reconnects and malformed client frames
    /// are scoped to one connection and never tear down the graphics authority.
    /// Fatal socket/media failures do fail closed and mark the listener dead.
    pub fn serve_interactive_shared(
        &self,
        runtime: &Arc<Mutex<Option<QualifiedGraphicsRuntime>>>,
        running: &AtomicBool,
    ) -> Result<(), QualificationMediaServerError> {
        while running.load(Ordering::SeqCst) {
            let result = self.serve_interactive_shared_once(runtime, running);

            // STOP revokes endpoint authority before joining this thread. If that
            // revocation wakes an idle accept (or interrupts an active socket),
            // the resulting transport error belongs to the requested shutdown,
            // not to the graphics runtime. Returning it as a media-thread failure
            // makes an otherwise clean STOP look like worker_protocol and can
            // quarantine the host even though runtime cleanup succeeded.
            if !running.load(Ordering::SeqCst) {
                return Ok(());
            }

            match result {
                Ok(_) => continue,
                Err(QualificationMediaServerError::AcceptTimeout)
                | Err(QualificationMediaServerError::Request)
                | Err(QualificationMediaServerError::Upgrade)
                | Err(QualificationMediaServerError::Response)
                | Err(QualificationMediaServerError::Input)
                | Err(QualificationMediaServerError::Protocol)
                | Err(QualificationMediaServerError::StaleConnection) => {
                    continue;
                }
                Err(QualificationMediaServerError::Media)
                    if runtime
                        .lock()
                        .ok()
                        .and_then(|guard| guard.as_ref().map(QualifiedGraphicsRuntime::suspended))
                        .unwrap_or(false) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn accept_upgraded_shared(
        &self,
        runtime: &Arc<Mutex<Option<QualifiedGraphicsRuntime>>>,
        running: &AtomicBool,
    ) -> Result<(TcpStream, u64), QualificationMediaServerError> {
        let mut stream = self.accept_shared(running)?;
        validate_accepted_loopback_stream(&stream)
            .map_err(|_| QualificationMediaServerError::Socket)?;
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .map_err(|_| QualificationMediaServerError::Socket)?;
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .map_err(|_| QualificationMediaServerError::Socket)?;

        let request = match read_upgrade_request(&mut stream) {
            Ok(request) => request,
            Err(error) => {
                write_local_upgrade_rejection(&mut stream, "400 Bad Request");
                return Err(error);
            }
        };
        // Fetch the capability only after the connection arrives. A SUSPEND
        // revokes the previous token and RESUME creates a fresh token, so a
        // listener that was already waiting must never authenticate stale bytes.
        let (media_token, stream_epoch) = {
            let guard = runtime
                .lock()
                .map_err(|_| QualificationMediaServerError::Upgrade)?;
            let active = guard
                .as_ref()
                .ok_or(QualificationMediaServerError::Upgrade)?;
            let media_token = active
                .media_token()
                .map(str::to_owned)
                .ok_or(QualificationMediaServerError::Upgrade)?;
            (media_token, active.stream_epoch())
        };
        let upgrade =
            match authenticate_local_media_upgrade(&request, &self.session_id, &media_token) {
                Ok(upgrade) => upgrade,
                Err(error) => {
                    write_local_upgrade_rejection(
                        &mut stream,
                        local_upgrade_rejection_status(error),
                    );
                    return Err(QualificationMediaServerError::Upgrade);
                }
            };
        let accept = websocket_accept_value(&upgrade.websocket_key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream
            .write_all(response.as_bytes())
            .map_err(|_| QualificationMediaServerError::Response)?;
        Ok((stream, stream_epoch))
    }

    fn accept_upgraded(
        &self,
        runtime: &QualifiedGraphicsRuntime,
    ) -> Result<TcpStream, QualificationMediaServerError> {
        let media_token = runtime
            .media_token()
            .ok_or(QualificationMediaServerError::Upgrade)?;
        self.accept_upgraded_with_token(media_token)
    }

    fn accept_upgraded_with_token(
        &self,
        media_token: &str,
    ) -> Result<TcpStream, QualificationMediaServerError> {
        let mut stream = self.accept()?;
        validate_accepted_loopback_stream(&stream)
            .map_err(|_| QualificationMediaServerError::Socket)?;
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .map_err(|_| QualificationMediaServerError::Socket)?;
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .map_err(|_| QualificationMediaServerError::Socket)?;

        let request = match read_upgrade_request(&mut stream) {
            Ok(request) => request,
            Err(error) => {
                write_local_upgrade_rejection(&mut stream, "400 Bad Request");
                return Err(error);
            }
        };
        let upgrade =
            match authenticate_local_media_upgrade(&request, &self.session_id, media_token) {
                Ok(upgrade) => upgrade,
                Err(error) => {
                    write_local_upgrade_rejection(
                        &mut stream,
                        local_upgrade_rejection_status(error),
                    );
                    return Err(QualificationMediaServerError::Upgrade);
                }
            };
        let accept = websocket_accept_value(&upgrade.websocket_key);
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream
            .write_all(response.as_bytes())
            .map_err(|_| QualificationMediaServerError::Response)?;
        Ok(stream)
    }
    pub fn serve_once(
        &self,
        runtime: &mut QualifiedGraphicsRuntime,
        max_frames: u32,
    ) -> Result<u32, QualificationMediaServerError> {
        if max_frames == 0 || max_frames > 600 {
            return Err(QualificationMediaServerError::InvalidConfiguration);
        }

        let mut stream = self.accept_upgraded(runtime)?;

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
                None => {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
            };
            write_browser_media_frame(&mut stream, self.stream_epoch, &frame)?;
            sent = sent
                .checked_add(1)
                .ok_or(QualificationMediaServerError::Protocol)?;
        }
        Ok(sent)
    }
}

fn write_browser_media_frame(
    stream: &mut TcpStream,
    stream_epoch: u64,
    frame: &crate::media_protocol::BoundMediaFrame,
) -> Result<(), QualificationMediaServerError> {
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
            stream_epoch,
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
        write_websocket_binary(stream, &packet)?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClientWebSocketFrame {
    Input([u8; BROWSER_INPUT_FRAME_SIZE]),
    Ping(Vec<u8>),
    Close(Vec<u8>),
}

fn read_websocket_client_frame<R: Read>(
    reader: &mut R,
) -> Result<ClientWebSocketFrame, QualificationMediaServerError> {
    let mut first = [0u8; 2];
    reader
        .read_exact(&mut first)
        .map_err(|_| QualificationMediaServerError::Input)?;
    let fin = first[0] & 0x80 != 0;
    let rsv = first[0] & 0x70;
    let opcode = first[0] & 0x0f;
    let masked = first[1] & 0x80 != 0;
    if !fin || rsv != 0 || !masked {
        return Err(QualificationMediaServerError::Input);
    }

    let marker = first[1] & 0x7f;
    let payload_len = if marker <= 125 {
        usize::from(marker)
    } else if marker == 126 {
        let mut raw = [0u8; 2];
        reader
            .read_exact(&mut raw)
            .map_err(|_| QualificationMediaServerError::Input)?;
        usize::from(u16::from_be_bytes(raw))
    } else {
        return Err(QualificationMediaServerError::Input);
    };

    let max_len = match opcode {
        0x02 => BROWSER_INPUT_FRAME_SIZE,
        0x08 | 0x09 => 125,
        _ => return Err(QualificationMediaServerError::Input),
    };
    if payload_len > max_len || (opcode == 0x02 && payload_len != BROWSER_INPUT_FRAME_SIZE) {
        return Err(QualificationMediaServerError::Input);
    }

    let mut mask = [0u8; 4];
    reader
        .read_exact(&mut mask)
        .map_err(|_| QualificationMediaServerError::Input)?;
    let mut payload = vec![0u8; payload_len];
    reader
        .read_exact(&mut payload)
        .map_err(|_| QualificationMediaServerError::Input)?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % mask.len()];
    }

    match opcode {
        0x02 => {
            let input: [u8; BROWSER_INPUT_FRAME_SIZE] = payload
                .try_into()
                .map_err(|_| QualificationMediaServerError::Input)?;
            Ok(ClientWebSocketFrame::Input(input))
        }
        0x08 => {
            if payload.len() == 1 {
                return Err(QualificationMediaServerError::Input);
            }
            Ok(ClientWebSocketFrame::Close(payload))
        }
        0x09 => Ok(ClientWebSocketFrame::Ping(payload)),
        _ => Err(QualificationMediaServerError::Input),
    }
}

fn peer_disconnect_error(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::NotConnected | ErrorKind::BrokenPipe
    )
}

fn classify_websocket_write_error(error: std::io::Error) -> QualificationMediaServerError {
    if peer_disconnect_error(error.kind()) { QualificationMediaServerError::StaleConnection }
    else { QualificationMediaServerError::Response }
}

fn try_read_websocket_client_frame(
    stream: &mut TcpStream,
) -> Result<Option<ClientWebSocketFrame>, QualificationMediaServerError> {
    stream
        .set_nonblocking(true)
        .map_err(|_| QualificationMediaServerError::Socket)?;
    let mut header = [0u8; 2];
    let peeked = stream.peek(&mut header);
    stream
        .set_nonblocking(false)
        .map_err(|_| QualificationMediaServerError::Socket)?;
    match peeked {
        Ok(0) => Ok(Some(ClientWebSocketFrame::Close(Vec::new()))),
        Ok(1) => Ok(None),
        Ok(_) => read_websocket_client_frame(stream).map(Some),
        Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(None),
        // Winsock reports an abortive peer close as WSAECONNRESET instead of
        // the zero-byte graceful-close path. A browser reload can therefore
        // surface as ConnectionReset/ConnectionAborted even though only this
        // WebSocket peer disappeared. Scope that condition to the connection;
        // the authority listener must stay alive for the reconnect grace path.
        Err(error) if peer_disconnect_error(error.kind()) => {
            Ok(Some(ClientWebSocketFrame::Close(Vec::new())))
        }
        Err(_) => Err(QualificationMediaServerError::Socket),
    }
}

fn write_websocket_control(
    stream: &mut TcpStream,
    opcode: u8,
    payload: &[u8],
) -> Result<(), QualificationMediaServerError> {
    if !matches!(opcode, 0x08 | 0x0A) || payload.len() > 125 {
        return Err(QualificationMediaServerError::Protocol);
    }
    let header = [0x80 | opcode, payload.len() as u8];
    stream
        .write_all(&header)
        .and_then(|_| stream.write_all(payload))
        .map_err(classify_websocket_write_error)
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
        .map_err(classify_websocket_write_error)
}

pub fn websocket_accept_value(key: &str) -> String {
    let mut material = Vec::with_capacity(key.len() + WEBSOCKET_GUID.len());
    material.extend_from_slice(key.as_bytes());
    material.extend_from_slice(WEBSOCKET_GUID.as_bytes());
    base64_encode(&sha1(&material))
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
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

    fn masked_client_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() <= 125);
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        let mut wire = vec![0x80 | opcode, 0x80 | payload.len() as u8];
        wire.extend_from_slice(&mask);
        wire.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        wire
    }

    #[test]
    fn explicit_shutdown_while_idle_accept_is_clean() {
        let server = QualificationMediaServer::bind("shutdown-test", 1).expect("bind");
        let running = Arc::new(AtomicBool::new(true));
        let runtime = Arc::new(Mutex::new(None));

        let thread_running = Arc::clone(&running);
        let thread_runtime = Arc::clone(&runtime);
        let handle = thread::spawn(move || {
            server.serve_interactive_shared(&thread_runtime, &thread_running)
        });

        thread::sleep(Duration::from_millis(25));
        running.store(false, Ordering::SeqCst);

        assert_eq!(handle.join().expect("media thread"), Ok(()));
    }

    #[test]
    fn local_upgrade_rejection_status_is_bounded_and_secret_free() {
        assert_eq!(
            local_upgrade_rejection_status(LocalMediaUpgradeError::Unauthorized),
            "401 Unauthorized"
        );
        assert_eq!(
            local_upgrade_rejection_status(LocalMediaUpgradeError::Host),
            "400 Bad Request"
        );
        assert_eq!(
            local_upgrade_rejection_status(LocalMediaUpgradeError::MediaToken),
            "400 Bad Request"
        );
    }

    #[test]
    fn resumed_runtime_epoch_invalidates_pre_suspend_connection() {
        assert_eq!(require_connection_epoch(7, 7), Ok(()));
        assert_eq!(
            require_connection_epoch(7, 8),
            Err(QualificationMediaServerError::StaleConnection)
        );
        assert_eq!(
            require_connection_epoch(0, 8),
            Err(QualificationMediaServerError::StaleConnection)
        );
    }

    #[test]
    fn peer_disconnect_errors_are_connection_scoped() {
        assert!(peer_disconnect_error(ErrorKind::ConnectionReset));
        assert!(peer_disconnect_error(ErrorKind::ConnectionAborted));
        assert!(peer_disconnect_error(ErrorKind::NotConnected));
        assert!(peer_disconnect_error(ErrorKind::BrokenPipe));
        assert!(!peer_disconnect_error(ErrorKind::WouldBlock));
        assert!(!peer_disconnect_error(ErrorKind::Other));
    }

    #[test]
    fn websocket_write_peer_disconnect_does_not_kill_media_listener() {
        for kind in [ErrorKind::BrokenPipe, ErrorKind::ConnectionReset, ErrorKind::ConnectionAborted, ErrorKind::NotConnected] {
            assert_eq!(classify_websocket_write_error(std::io::Error::from(kind)), QualificationMediaServerError::StaleConnection);
        }
        assert_eq!(classify_websocket_write_error(std::io::Error::from(ErrorKind::PermissionDenied)), QualificationMediaServerError::Response);
    }

    #[test]
    fn browser_input_websocket_frame_requires_masking_and_exact_length() {
        let mut input = [0u8; BROWSER_INPUT_FRAME_SIZE];
        input[0..4].copy_from_slice(b"GBNI");
        input[4..6].copy_from_slice(&1u16.to_le_bytes());
        input[6] = 1;
        input[8..16].copy_from_slice(&7u64.to_le_bytes());
        input[16..24].copy_from_slice(&1u64.to_le_bytes());
        input[24..28].copy_from_slice(&0x1ei32.to_le_bytes());

        let wire = masked_client_frame(0x02, &input);
        assert_eq!(
            read_websocket_client_frame(&mut std::io::Cursor::new(wire)),
            Ok(ClientWebSocketFrame::Input(input))
        );

        let mut unmasked = Vec::from([0x82, BROWSER_INPUT_FRAME_SIZE as u8]);
        unmasked.extend_from_slice(&input);
        assert_eq!(
            read_websocket_client_frame(&mut std::io::Cursor::new(unmasked)),
            Err(QualificationMediaServerError::Input)
        );

        let short = masked_client_frame(0x02, &input[..BROWSER_INPUT_FRAME_SIZE - 1]);
        assert_eq!(
            read_websocket_client_frame(&mut std::io::Cursor::new(short)),
            Err(QualificationMediaServerError::Input)
        );
    }

    #[test]
    fn browser_control_frames_accept_bounded_ping_and_close_only() {
        let ping = masked_client_frame(0x09, b"hi");
        assert_eq!(
            read_websocket_client_frame(&mut std::io::Cursor::new(ping)),
            Ok(ClientWebSocketFrame::Ping(b"hi".to_vec()))
        );
        let close = masked_client_frame(0x08, &[0x03, 0xe8]);
        assert_eq!(
            read_websocket_client_frame(&mut std::io::Cursor::new(close)),
            Ok(ClientWebSocketFrame::Close(vec![0x03, 0xe8]))
        );
        let text = masked_client_frame(0x01, b"no");
        assert_eq!(
            read_websocket_client_frame(&mut std::io::Cursor::new(text)),
            Err(QualificationMediaServerError::Input)
        );
    }
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
                0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e, 0x25, 0x71, 0x78, 0x50,
                0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d,
            ]
        );
    }
}
