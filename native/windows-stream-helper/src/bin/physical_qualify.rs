//! Controlled physical qualification harness for the Windows-native graphics path.

#[cfg(not(target_os = "windows"))]
fn main() -> std::process::ExitCode {
    println!(r#"{"ok":false,"error":"windows_required"}"#);
    std::process::ExitCode::from(20)
}

#[cfg(target_os = "windows")]
mod windows {
    use gpubnb_windows_platform::secret::MediaCapabilityToken;
    use gpubnb_windows_stream_helper::browser_media_protocol::{
        BROWSER_MEDIA_HEADER_SIZE, BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS, BrowserMediaReassembler,
    };
    use gpubnb_windows_stream_helper::lifecycle::WorkspaceKind;
    use gpubnb_windows_stream_helper::qualification_server::{
        QualificationMediaServer, websocket_accept_value,
    };
    use gpubnb_windows_stream_helper::service_runtime::{
        QualifiedGraphicsRuntime, ServiceRuntimeConfig, start_qualified_graphics_runtime,
    };
    use gpubnb_windows_stream_helper::worker_protocol::WorkerInputEvent;
    use std::env;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::process::ExitCode;
    use std::thread;
    use std::time::{Duration, Instant};

    const CLIENT_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
    const MAX_FRAMES: u32 = 120;

    struct SecretString(String);

    impl SecretString {
        fn new(value: &str) -> Self {
            Self(value.to_owned())
        }

        fn as_str(&self) -> &str {
            &self.0
        }
    }

    impl Drop for SecretString {
        fn drop(&mut self) {
            let replacement = "0".repeat(self.0.len());
            self.0.replace_range(.., &replacement);
        }
    }

    struct Args {
        session_id: String,
        generation: u64,
        gpu_uuid: String,
        windows_session_id: u32,
        renter_user_sid: String,
        provider_user_sid: String,
        frames: u32,
    }

    fn take_value(raw: &[String], index: &mut usize) -> Result<String, &'static str> {
        *index += 1;
        raw.get(*index).cloned().ok_or("missing_argument_value")
    }

    fn parse_args() -> Result<Args, &'static str> {
        let raw: Vec<String> = env::args().skip(1).collect();
        let mut session_id = None;
        let mut generation = None;
        let mut gpu_uuid = None;
        let mut windows_session_id = None;
        let mut renter_user_sid = None;
        let mut provider_user_sid = None;
        let mut frames = 8u32;
        let mut index = 0usize;

        while index < raw.len() {
            match raw[index].as_str() {
                "--session-id" if session_id.is_none() => {
                    session_id = Some(take_value(&raw, &mut index)?);
                }
                "--generation" if generation.is_none() => {
                    generation = Some(
                        take_value(&raw, &mut index)?
                            .parse::<u64>()
                            .map_err(|_| "invalid_generation")?,
                    );
                }
                "--gpu-uuid" if gpu_uuid.is_none() => {
                    gpu_uuid = Some(take_value(&raw, &mut index)?);
                }
                "--windows-session-id" if windows_session_id.is_none() => {
                    windows_session_id = Some(
                        take_value(&raw, &mut index)?
                            .parse::<u32>()
                            .map_err(|_| "invalid_windows_session_id")?,
                    );
                }
                "--renter-user-sid" if renter_user_sid.is_none() => {
                    renter_user_sid = Some(take_value(&raw, &mut index)?);
                }
                "--provider-user-sid" if provider_user_sid.is_none() => {
                    provider_user_sid = Some(take_value(&raw, &mut index)?);
                }
                "--frames" => {
                    frames = take_value(&raw, &mut index)?
                        .parse::<u32>()
                        .map_err(|_| "invalid_frame_count")?;
                }
                _ => return Err("unknown_or_duplicate_argument"),
            }
            index += 1;
        }

        let args = Args {
            session_id: session_id.ok_or("missing_session_id")?,
            generation: generation.ok_or("missing_generation")?,
            gpu_uuid: gpu_uuid.ok_or("missing_gpu_uuid")?,
            windows_session_id: windows_session_id.ok_or("missing_windows_session_id")?,
            renter_user_sid: renter_user_sid.ok_or("missing_renter_user_sid")?,
            provider_user_sid: provider_user_sid.ok_or("missing_provider_user_sid")?,
            frames,
        };
        if args.generation == 0
            || args.windows_session_id == 0
            || args.frames == 0
            || args.frames > MAX_FRAMES
        {
            return Err("invalid_qualification_arguments");
        }
        Ok(args)
    }

    fn hex_nibble(value: u8) -> Result<u8, &'static str> {
        match value {
            b'0'..=b'9' => Ok(value - b'0'),
            b'a'..=b'f' => Ok(value - b'a' + 10),
            _ => Err("qualification_nonce_generation_failed"),
        }
    }

    fn qualification_nonce() -> Result<[u8; 16], &'static str> {
        let token = MediaCapabilityToken::generate()
            .map_err(|_| "qualification_nonce_generation_failed")?;
        let bytes = token.as_str().as_bytes();
        let mut nonce = [0u8; 16];
        for (index, slot) in nonce.iter_mut().enumerate() {
            let high = hex_nibble(bytes[index * 2])?;
            let low = hex_nibble(bytes[index * 2 + 1])?;
            *slot = (high << 4) | low;
        }
        Ok(nonce)
    }

    pub(super) fn read_headers<R: BufRead>(reader: &mut R) -> Result<String, &'static str> {
        let mut bytes = Vec::with_capacity(1024);
        loop {
            let mut line = Vec::with_capacity(128);
            let count = reader
                .read_until(b'\n', &mut line)
                .map_err(|_| "client_read_failed")?;
            if count == 0 {
                return Err("client_connection_closed");
            }
            if !line.ends_with(b"\r\n") {
                return Err("client_response_invalid");
            }
            let next_len = bytes
                .len()
                .checked_add(line.len())
                .ok_or("client_response_too_large")?;
            if next_len > 8192 {
                return Err("client_response_too_large");
            }
            let done = line == b"\r\n";
            bytes.extend_from_slice(&line);
            if done {
                return String::from_utf8(bytes).map_err(|_| "client_response_invalid");
            }
        }
    }

    pub(super) fn read_ws_binary<R: Read>(stream: &mut R) -> Result<Vec<u8>, &'static str> {
        let mut first = [0u8; 2];
        stream
            .read_exact(&mut first)
            .map_err(|_| "client_frame_header_failed")?;
        if first[0] != 0x82 || first[1] & 0x80 != 0 {
            return Err("client_frame_type_invalid");
        }
        let mut length = u64::from(first[1] & 0x7f);
        if length == 126 {
            let mut raw = [0u8; 2];
            stream
                .read_exact(&mut raw)
                .map_err(|_| "client_frame_length_failed")?;
            length = u64::from(u16::from_be_bytes(raw));
        } else if length == 127 {
            let mut raw = [0u8; 8];
            stream
                .read_exact(&mut raw)
                .map_err(|_| "client_frame_length_failed")?;
            length = u64::from_be_bytes(raw);
        }
        let max = (BROWSER_MEDIA_HEADER_SIZE + 1024 * 1024) as u64;
        if length == 0 || length > max {
            return Err("client_frame_length_invalid");
        }
        let mut payload = vec![0u8; length as usize];
        stream
            .read_exact(&mut payload)
            .map_err(|_| "client_frame_payload_failed")?;
        Ok(payload)
    }

    fn run_client(
        endpoint: SocketAddr,
        session_id: String,
        token: SecretString,
        expected_frames: u32,
    ) -> Result<u32, &'static str> {
        let mut stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(10))
            .map_err(|_| "client_connect_failed")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .map_err(|_| "client_timeout_failed")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|_| "client_timeout_failed")?;

        let request = format!(
            "GET /session/{session_id} HTTP/1.1\r\nHost: {endpoint}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {CLIENT_KEY}\r\nX-GPUbnb-Media-Token: {}\r\n\r\n",
            token.as_str()
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|_| "client_upgrade_write_failed")?;

        let mut reader = BufReader::new(stream);
        let response = read_headers(&mut reader)?;
        if !response.starts_with("HTTP/1.1 101 Switching Protocols\r\n") {
            return Err("client_upgrade_rejected");
        }
        let expected_accept = format!(
            "Sec-WebSocket-Accept: {}\r\n",
            websocket_accept_value(CLIENT_KEY)
        );
        if !response.contains(&expected_accept) {
            return Err("client_upgrade_accept_invalid");
        }

        let mut reassembler = BrowserMediaReassembler::new(BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS)
            .map_err(|_| "client_reassembler_failed")?;
        let started = Instant::now();
        let mut completed = 0u32;
        while completed < expected_frames {
            let packet = read_ws_binary(&mut reader)?;
            let now_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            if reassembler
                .push_chunk(&packet, now_ms)
                .map_err(|_| "client_media_reassembly_failed")?
                .is_some()
            {
                completed += 1;
            }
        }
        Ok(completed)
    }

    fn prove_renter_input_isolation(
        runtime: &mut QualifiedGraphicsRuntime,
        expected_windows_session_id: u32,
    ) -> Result<(), &'static str> {
        let isolation = runtime.renter_isolation_proof();
        if isolation.windows_session_id() != expected_windows_session_id
            || !isolation.separate_renter_identity()
            || !isolation.renter_session_active()
            || !isolation.provider_session_inactive()
        {
            return Err("qualification_renter_isolation_failed");
        }

        // Exercise the real service -> fenced worker -> SendInput path only inside
        // the already-proven renter WTS session. The opposite moves minimize the
        // visible pointer disturbance. Suspend/resume then forces the worker to
        // process both input commands and return a fresh capture+NVENC proof before
        // the harness can continue.
        runtime
            .inject_input(WorkerInputEvent::MouseMoveRelative { dx: 1, dy: 0 })
            .map_err(|_| "qualification_input_injection_failed")?;
        runtime
            .inject_input(WorkerInputEvent::MouseMoveRelative { dx: -1, dy: 0 })
            .map_err(|_| "qualification_input_injection_failed")?;
        runtime
            .suspend_media()
            .map_err(|_| "qualification_input_fence_failed")?;
        runtime
            .resume_after_fresh_proof()
            .map_err(|_| "qualification_input_fence_failed")?;
        Ok(())
    }

    fn run() -> Result<u32, &'static str> {
        let args = parse_args()?;
        let display_nonce = qualification_nonce()?;
        let mut runtime = start_qualified_graphics_runtime(ServiceRuntimeConfig {
            session_id: &args.session_id,
            generation: args.generation,
            workspace: WorkspaceKind::CloudDesktop,
            gpu_uuid: &args.gpu_uuid,
            windows_session_id: args.windows_session_id,
            renter_user_sid: &args.renter_user_sid,
            provider_user_sid: &args.provider_user_sid,
            display_nonce,
            width: 1920,
            height: 1080,
            refresh_hz: 60,
        })
        .map_err(|_| "qualification_runtime_start_failed")?;

        if let Err(error) = prove_renter_input_isolation(&mut runtime, args.windows_session_id) {
            let _ = runtime.stop();
            return Err(error);
        }

        let server = match QualificationMediaServer::bind(&args.session_id, args.generation) {
            Ok(server) => server,
            Err(_) => {
                let _ = runtime.stop();
                return Err("qualification_media_bind_failed");
            }
        };
        let endpoint = match server.endpoint() {
            Ok(endpoint) => endpoint,
            Err(_) => {
                let _ = runtime.stop();
                return Err("qualification_media_endpoint_failed");
            }
        };
        let token = match runtime.media_token() {
            Some(token) => SecretString::new(token),
            None => {
                let _ = runtime.stop();
                return Err("qualification_media_token_missing");
            }
        };

        let session_id = args.session_id.clone();
        let frames = args.frames;
        let client = thread::spawn(move || run_client(endpoint, session_id, token, frames));
        let server_result = server
            .serve_once(&mut runtime, frames)
            .map_err(|_| "qualification_media_server_failed");
        drop(server);
        let listener_closed =
            TcpStream::connect_timeout(&endpoint, Duration::from_millis(250)).is_err();

        let client_result = match client.join() {
            Ok(result) => result.map_err(|_| "qualification_client_failed"),
            Err(_) => Err("qualification_client_panicked"),
        };
        let stop_result = runtime
            .stop()
            .map_err(|_| "qualification_cleanup_unverified");

        let sent = server_result?;
        let received = client_result?;
        stop_result?;
        if !listener_closed {
            return Err("qualification_media_listener_cleanup_unverified");
        }
        if sent != frames || received != frames {
            return Err("qualification_frame_count_mismatch");
        }
        Ok(received)
    }

    pub fn main() -> ExitCode {
        match run() {
            Ok(frames) => {
                println!(
                    "{{\"ok\":true,\"workspace\":\"cloud-desktop\",\"frames\":{frames},\"isolatedSession\":true,\"virtualDisplay\":true,\"providerDesktopExcluded\":true,\"exactGpuBound\":true,\"hardwareEncoder\":\"nvenc\",\"loopbackMedia\":true,\"cleanupVerified\":true,\"bookabilityEnabled\":false}}"
                );
                ExitCode::SUCCESS
            }
            Err(code) => {
                println!("{{\"ok\":false,\"error\":\"{code}\",\"bookabilityEnabled\":false}}");
                eprintln!("error:{code}");
                ExitCode::from(21)
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn main() -> std::process::ExitCode {
    windows::main()
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::windows::{read_headers, read_ws_binary};
    use std::io::{BufReader, Cursor};

    #[test]
    fn coalesced_upgrade_and_first_websocket_frame_are_preserved() {
        let mut wire =
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
                .to_vec();
        wire.extend_from_slice(&[0x82, 0x03, 1, 2, 3]);

        let mut reader = BufReader::new(Cursor::new(wire));
        let headers = read_headers(&mut reader).expect("headers");
        assert!(headers.ends_with("\r\n\r\n"));
        assert_eq!(read_ws_binary(&mut reader).expect("frame"), vec![1, 2, 3]);
    }
}
