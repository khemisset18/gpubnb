//! Strict loopback WebSocket upgrade contract for the Windows-native media plane.
//!
//! This module intentionally performs no socket I/O. It parses one bounded HTTP/1.1
//! upgrade request supplied by the future loopback listener and authenticates it
//! against an in-memory media capability. Network code must separately enforce a
//! literal loopback bind and peer address.

use std::collections::BTreeSet;
use std::net::SocketAddr;

pub const LOCAL_MEDIA_REQUEST_MAX_BYTES: usize = 8 * 1024;
pub const LOCAL_MEDIA_HEADER_MAX_COUNT: usize = 32;
pub const LOCAL_MEDIA_HEADER_LINE_MAX_BYTES: usize = 2 * 1024;
const MAX_SESSION_ID_BYTES: usize = 200;
const MIN_MEDIA_TOKEN_BYTES: usize = 32;
const MAX_MEDIA_TOKEN_BYTES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMediaUpgrade {
    pub session_id: String,
    pub websocket_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalMediaUpgradeError {
    Empty,
    TooLarge,
    InvalidAscii,
    InvalidTerminator,
    RequestLine,
    Method,
    Version,
    Route,
    Session,
    HeaderLine,
    TooManyHeaders,
    HeaderTooLarge,
    DuplicateHeader,
    Host,
    Connection,
    Upgrade,
    WebSocketVersion,
    WebSocketKey,
    BodyForbidden,
    MediaToken,
    Unauthorized,
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_media_token(value: &str) -> bool {
    (MIN_MEDIA_TOKEN_BYTES..=MAX_MEDIA_TOKEN_BYTES).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn media_token_matches(expected: &str, presented: &str) -> bool {
    if !valid_media_token(expected) || !valid_media_token(presented) {
        return false;
    }
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    if expected.len() != presented.len() {
        return false;
    }

    let mut difference = 0u8;
    for (trusted, candidate) in expected.iter().zip(presented) {
        difference |= trusted ^ candidate;
    }
    difference == 0
}

fn valid_loopback_host(value: &str) -> bool {
    let Ok(address) = value.parse::<SocketAddr>() else {
        return false;
    };
    if !address.ip().is_loopback() || address.port() == 0 {
        return false;
    }
    address.to_string() == value
}

fn contains_ascii_token(value: &str, expected: &str) -> bool {
    value
        .split(',')
        .map(str::trim)
        .any(|token| token.eq_ignore_ascii_case(expected))
}

fn valid_websocket_key(value: &str) -> bool {
    if value.len() != 24 || !value.ends_with("==") {
        return false;
    }
    value[..22]
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

pub fn authenticate_local_media_upgrade(
    request: &[u8],
    expected_session_id: &str,
    expected_media_token: &str,
) -> Result<LocalMediaUpgrade, LocalMediaUpgradeError> {
    if request.is_empty() {
        return Err(LocalMediaUpgradeError::Empty);
    }
    if request.len() > LOCAL_MEDIA_REQUEST_MAX_BYTES {
        return Err(LocalMediaUpgradeError::TooLarge);
    }
    if !request.is_ascii() {
        return Err(LocalMediaUpgradeError::InvalidAscii);
    }
    if !request.ends_with(b"\r\n\r\n") {
        return Err(LocalMediaUpgradeError::InvalidTerminator);
    }
    if !valid_session_id(expected_session_id) {
        return Err(LocalMediaUpgradeError::Session);
    }
    if !valid_media_token(expected_media_token) {
        return Err(LocalMediaUpgradeError::MediaToken);
    }

    let text = std::str::from_utf8(request).map_err(|_| LocalMediaUpgradeError::InvalidAscii)?;
    if text.contains("\n ") || text.contains("\n\t") {
        return Err(LocalMediaUpgradeError::HeaderLine);
    }

    let mut lines = text[..text.len() - 4].split("\r\n");
    let request_line = lines.next().ok_or(LocalMediaUpgradeError::RequestLine)?;
    let mut request_parts = request_line.split(' ');
    let method = request_parts
        .next()
        .ok_or(LocalMediaUpgradeError::RequestLine)?;
    let target = request_parts
        .next()
        .ok_or(LocalMediaUpgradeError::RequestLine)?;
    let version = request_parts
        .next()
        .ok_or(LocalMediaUpgradeError::RequestLine)?;
    if request_parts.next().is_some() {
        return Err(LocalMediaUpgradeError::RequestLine);
    }
    if method != "GET" {
        return Err(LocalMediaUpgradeError::Method);
    }
    if version != "HTTP/1.1" {
        return Err(LocalMediaUpgradeError::Version);
    }
    let expected_target = format!("/session/{expected_session_id}");
    if target != expected_target {
        return Err(LocalMediaUpgradeError::Route);
    }

    let mut seen = BTreeSet::<String>::new();
    let mut host: Option<&str> = None;
    let mut connection: Option<&str> = None;
    let mut upgrade: Option<&str> = None;
    let mut websocket_version: Option<&str> = None;
    let mut websocket_key: Option<&str> = None;
    let mut media_token: Option<&str> = None;

    for (index, line) in lines.enumerate() {
        if line.is_empty() {
            return Err(LocalMediaUpgradeError::HeaderLine);
        }
        if line.len() > LOCAL_MEDIA_HEADER_LINE_MAX_BYTES {
            return Err(LocalMediaUpgradeError::HeaderTooLarge);
        }
        if index >= LOCAL_MEDIA_HEADER_MAX_COUNT {
            return Err(LocalMediaUpgradeError::TooManyHeaders);
        }

        let (raw_name, raw_value) = line
            .split_once(':')
            .ok_or(LocalMediaUpgradeError::HeaderLine)?;
        if raw_name.is_empty()
            || !raw_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(LocalMediaUpgradeError::HeaderLine);
        }
        let Some(value) = raw_value.strip_prefix(' ') else {
            return Err(LocalMediaUpgradeError::HeaderLine);
        };
        // Keep security-sensitive header values byte-exact. HTTP optional
        // whitespace normalization must never turn " token " into "token".
        if value.is_empty()
            || value != value.trim()
            || value.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        {
            return Err(LocalMediaUpgradeError::HeaderLine);
        }

        let name = raw_name.to_ascii_lowercase();
        if !seen.insert(name.clone()) {
            return Err(LocalMediaUpgradeError::DuplicateHeader);
        }
        match name.as_str() {
            "host" => host = Some(value),
            "connection" => connection = Some(value),
            "upgrade" => upgrade = Some(value),
            "sec-websocket-version" => websocket_version = Some(value),
            "sec-websocket-key" => websocket_key = Some(value),
            "x-gpubnb-media-token" => media_token = Some(value),
            "content-length" | "transfer-encoding" => {
                return Err(LocalMediaUpgradeError::BodyForbidden);
            }
            _ => {}
        }
    }

    if !host.is_some_and(valid_loopback_host) {
        return Err(LocalMediaUpgradeError::Host);
    }
    if !connection.is_some_and(|value| contains_ascii_token(value, "upgrade")) {
        return Err(LocalMediaUpgradeError::Connection);
    }
    if !upgrade.is_some_and(|value| value.eq_ignore_ascii_case("websocket")) {
        return Err(LocalMediaUpgradeError::Upgrade);
    }
    if websocket_version != Some("13") {
        return Err(LocalMediaUpgradeError::WebSocketVersion);
    }
    let websocket_key = websocket_key.ok_or(LocalMediaUpgradeError::WebSocketKey)?;
    if !valid_websocket_key(websocket_key) {
        return Err(LocalMediaUpgradeError::WebSocketKey);
    }
    let media_token = media_token.ok_or(LocalMediaUpgradeError::MediaToken)?;
    if !media_token_matches(expected_media_token, media_token) {
        return Err(LocalMediaUpgradeError::Unauthorized);
    }

    Ok(LocalMediaUpgrade {
        session_id: expected_session_id.to_owned(),
        websocket_key: websocket_key.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "sess-1";
    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn request(extra: &str) -> Vec<u8> {
        format!(
            "GET /session/{SESSION} HTTP/1.1\r\n\
Host: 127.0.0.1:43123\r\n\
Connection: Upgrade\r\n\
Upgrade: websocket\r\n\
Sec-WebSocket-Version: 13\r\n\
Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\
X-GPUbnb-Media-Token: {TOKEN}\r\n{extra}\r\n"
        )
        .into_bytes()
    }

    #[test]
    fn exact_authenticated_upgrade_is_accepted() {
        let parsed =
            authenticate_local_media_upgrade(&request(""), SESSION, TOKEN).expect("upgrade");
        assert_eq!(parsed.session_id, SESSION);
        assert_eq!(parsed.websocket_key, "AAAAAAAAAAAAAAAAAAAAAA==");
    }

    #[test]
    fn ipv6_loopback_host_is_accepted_when_canonical() {
        let mut value = request("");
        let text = std::str::from_utf8(&value)
            .expect("ASCII")
            .replace("127.0.0.1:43123", "[::1]:43123");
        value = text.into_bytes();
        assert!(authenticate_local_media_upgrade(&value, SESSION, TOKEN).is_ok());
    }

    #[test]
    fn wrong_or_malformed_capability_is_rejected() {
        let wrong = format!("{}b", &TOKEN[..TOKEN.len() - 1]);
        assert_eq!(
            authenticate_local_media_upgrade(&request(""), SESSION, &wrong),
            Err(LocalMediaUpgradeError::Unauthorized)
        );
        for invalid in ["short", "A=A=A=A=A=A=A=A=A=A=A=A=A=A=A=A="] {
            assert_eq!(
                authenticate_local_media_upgrade(&request(""), SESSION, invalid),
                Err(LocalMediaUpgradeError::MediaToken)
            );
        }
    }

    #[test]
    fn media_token_whitespace_is_never_normalized() {
        let request_bytes = request("");
        let base = std::str::from_utf8(&request_bytes).expect("ASCII");
        for replacement in [
            format!("X-GPUbnb-Media-Token:  {TOKEN}"),
            format!("X-GPUbnb-Media-Token: {TOKEN} "),
            format!("X-GPUbnb-Media-Token:\t{TOKEN}"),
        ] {
            let value = base
                .replace(&format!("X-GPUbnb-Media-Token: {TOKEN}"), &replacement)
                .into_bytes();
            assert_eq!(
                authenticate_local_media_upgrade(&value, SESSION, TOKEN),
                Err(LocalMediaUpgradeError::HeaderLine)
            );
        }
    }

    #[test]
    fn cross_session_query_and_path_extensions_are_rejected() {
        let request_bytes = request("");
        let base = std::str::from_utf8(&request_bytes).expect("ASCII");
        for target in [
            "/session/sess-2",
            "/session/sess-1/",
            "/session/sess-1?token=secret",
            "/session/sess-10",
        ] {
            let value = base
                .replace("/session/sess-1 HTTP/1.1", &format!("{target} HTTP/1.1"))
                .into_bytes();
            assert_eq!(
                authenticate_local_media_upgrade(&value, SESSION, TOKEN),
                Err(LocalMediaUpgradeError::Route)
            );
        }
    }

    #[test]
    fn duplicate_security_or_ordinary_headers_are_rejected() {
        for duplicate in [
            format!("X-GPUbnb-Media-Token: {TOKEN}\r\n"),
            "Host: 127.0.0.1:43123\r\n".to_owned(),
            "X-Trace: one\r\nX-Trace: two\r\n".to_owned(),
        ] {
            assert_eq!(
                authenticate_local_media_upgrade(&request(&duplicate), SESSION, TOKEN),
                Err(LocalMediaUpgradeError::DuplicateHeader)
            );
        }
    }

    #[test]
    fn bodies_transfer_encoding_and_obs_fold_are_rejected() {
        for extra in [
            "Content-Length: 0\r\n",
            "Transfer-Encoding: chunked\r\n",
            "X-Test: value\r\n folded\r\n",
            "X-Test: value\r\n\tfolded\r\n",
        ] {
            assert!(authenticate_local_media_upgrade(&request(extra), SESSION, TOKEN).is_err());
        }

        let mut with_body = request("");
        with_body.extend_from_slice(b"payload");
        assert_eq!(
            authenticate_local_media_upgrade(&with_body, SESSION, TOKEN),
            Err(LocalMediaUpgradeError::InvalidTerminator)
        );
    }

    #[test]
    fn websocket_contract_is_exact_and_fail_closed() {
        let request_bytes = request("");
        let base = std::str::from_utf8(&request_bytes).expect("ASCII");
        for (from, to, expected) in [
            ("GET ", "POST ", LocalMediaUpgradeError::Method),
            ("HTTP/1.1", "HTTP/1.0", LocalMediaUpgradeError::Version),
            (
                "Connection: Upgrade",
                "Connection: close",
                LocalMediaUpgradeError::Connection,
            ),
            (
                "Upgrade: websocket",
                "Upgrade: h2c",
                LocalMediaUpgradeError::Upgrade,
            ),
            (
                "Sec-WebSocket-Version: 13",
                "Sec-WebSocket-Version: 12",
                LocalMediaUpgradeError::WebSocketVersion,
            ),
            (
                "AAAAAAAAAAAAAAAAAAAAAA==",
                "not-a-websocket-key-value",
                LocalMediaUpgradeError::WebSocketKey,
            ),
        ] {
            let value = base.replace(from, to).into_bytes();
            assert_eq!(
                authenticate_local_media_upgrade(&value, SESSION, TOKEN),
                Err(expected)
            );
        }
    }

    #[test]
    fn host_must_be_canonical_literal_loopback_with_explicit_port() {
        let request_bytes = request("");
        let base = std::str::from_utf8(&request_bytes).expect("ASCII");
        for host in [
            "localhost:43123",
            "0.0.0.0:43123",
            "192.168.1.5:43123",
            "127.0.0.1",
            "127.0.0.1:0",
            "127.0.0.1:043123",
        ] {
            let value = base.replace("127.0.0.1:43123", host).into_bytes();
            assert_eq!(
                authenticate_local_media_upgrade(&value, SESSION, TOKEN),
                Err(LocalMediaUpgradeError::Host)
            );
        }
    }

    #[test]
    fn request_size_line_count_and_crlf_are_bounded() {
        assert_eq!(
            authenticate_local_media_upgrade(
                &vec![b'A'; LOCAL_MEDIA_REQUEST_MAX_BYTES + 1],
                SESSION,
                TOKEN
            ),
            Err(LocalMediaUpgradeError::TooLarge)
        );

        let mut many = String::new();
        for index in 0..=LOCAL_MEDIA_HEADER_MAX_COUNT {
            many.push_str(&format!("X-Test-{index}: value\r\n"));
        }
        assert_eq!(
            authenticate_local_media_upgrade(&request(&many), SESSION, TOKEN),
            Err(LocalMediaUpgradeError::TooManyHeaders)
        );

        let request_bytes = request("");
        let lf_only = std::str::from_utf8(&request_bytes)
            .expect("ASCII")
            .replace("\r\n", "\n")
            .into_bytes();
        assert_eq!(
            authenticate_local_media_upgrade(&lf_only, SESSION, TOKEN),
            Err(LocalMediaUpgradeError::InvalidTerminator)
        );
    }
}
