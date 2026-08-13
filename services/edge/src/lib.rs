#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};

pub const PROTOCOL_VERSION: u16 = 1;
pub const ALPN: &str = "gpubnb-dp/1";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum StreamKind {
    Control,
    VsCodeManagement,
    VsCodeExtensionHost,
    Terminal,
    FileTransfer,
    Jupyter,
    AppPort,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum StreamPriority {
    Bulk = 10,
    Application = 30,
    Interactive = 80,
    Control = 100,
}

impl StreamKind {
    pub fn priority(self) -> StreamPriority {
        match self {
            Self::Control => StreamPriority::Control,
            Self::VsCodeManagement | Self::VsCodeExtensionHost | Self::Terminal => {
                StreamPriority::Interactive
            }
            Self::Jupyter | Self::AppPort => StreamPriority::Application,
            Self::FileTransfer => StreamPriority::Bulk,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeMode {
    Ready,
    Draining,
    Degraded,
}

impl EdgeMode {
    fn accepts_new_sessions(self) -> bool {
        matches!(self, Self::Ready)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionBinding {
    pub protocol_version: u16,
    pub session_id: String,
    pub machine_id: String,
    pub booking_id: String,
    pub renter_user_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub nonce: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub max_sessions: usize,
    pub max_streams_per_session: usize,
    pub max_buffered_bytes_per_stream: usize,
    pub max_buffered_bytes_per_session: usize,
    pub max_total_buffered_bytes: usize,
    pub max_session_lifetime_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_sessions: 10_000,
            max_streams_per_session: 64,
            max_buffered_bytes_per_stream: 8 * 1024 * 1024,
            max_buffered_bytes_per_session: 16 * 1024 * 1024,
            max_total_buffered_bytes: 512 * 1024 * 1024,
            max_session_lifetime_ms: 24 * 60 * 60 * 1000,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EdgeError {
    ProtocolVersion,
    InvalidIdentifier,
    InvalidNonce,
    InvalidLifetime,
    SessionNotCurrent,
    SessionCapacity,
    NotAcceptingSessions,
    DuplicateSession,
    UnknownSession,
    StreamCapacity,
    DuplicateStream,
    UnknownStream,
    InvalidTargetPort,
    ForbiddenTargetPort,
    StreamBackpressure,
    SessionBackpressure,
    GlobalBackpressure,
    BufferedBytesUnderflow,
}

#[derive(Clone, Debug)]
struct StreamState {
    kind: StreamKind,
    target_port: Option<u16>,
    buffered_bytes: usize,
}

#[derive(Clone, Debug)]
struct SessionState {
    binding: SessionBinding,
    streams: HashMap<u32, StreamState>,
    active_kinds: HashSet<StreamKind>,
    buffered_bytes: usize,
}

impl SessionState {
    fn interactive_ready(&self) -> bool {
        self.active_kinds.contains(&StreamKind::VsCodeManagement)
            && self.active_kinds.contains(&StreamKind::VsCodeExtensionHost)
    }
}

#[derive(Debug)]
pub struct EdgeRegistry {
    limits: Limits,
    mode: EdgeMode,
    sessions: HashMap<String, SessionState>,
    total_buffered_bytes: usize,
}

impl EdgeRegistry {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            mode: EdgeMode::Ready,
            sessions: HashMap::new(),
            total_buffered_bytes: 0,
        }
    }

    pub fn mode(&self) -> EdgeMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: EdgeMode) {
        self.mode = mode;
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn total_buffered_bytes(&self) -> usize {
        self.total_buffered_bytes
    }

    pub fn stream_count(&self) -> usize {
        self.sessions
            .values()
            .map(|session| session.streams.len())
            .sum()
    }

    pub fn register_session(
        &mut self,
        binding: SessionBinding,
        now_ms: u64,
    ) -> Result<(), EdgeError> {
        validate_binding(&binding, now_ms, self.limits.max_session_lifetime_ms)?;
        if !self.mode.accepts_new_sessions() {
            return Err(EdgeError::NotAcceptingSessions);
        }
        if self.sessions.contains_key(&binding.session_id) {
            return Err(EdgeError::DuplicateSession);
        }
        if self.sessions.len() >= self.limits.max_sessions {
            return Err(EdgeError::SessionCapacity);
        }

        self.sessions.insert(
            binding.session_id.clone(),
            SessionState {
                binding,
                streams: HashMap::new(),
                active_kinds: HashSet::new(),
                buffered_bytes: 0,
            },
        );
        Ok(())
    }

    pub fn remove_session(&mut self, session_id: &str) -> Result<(), EdgeError> {
        let state = self
            .sessions
            .remove(session_id)
            .ok_or(EdgeError::UnknownSession)?;
        self.total_buffered_bytes = self
            .total_buffered_bytes
            .checked_sub(state.buffered_bytes)
            .ok_or(EdgeError::BufferedBytesUnderflow)?;
        Ok(())
    }

    pub fn open_stream(
        &mut self,
        session_id: &str,
        stream_id: u32,
        kind: StreamKind,
        target_port: Option<u16>,
        now_ms: u64,
    ) -> Result<(), EdgeError> {
        if stream_id == 0 {
            return Err(EdgeError::UnknownStream);
        }
        validate_target(kind, target_port)?;

        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(EdgeError::UnknownSession)?;
        validate_binding(
            &session.binding,
            now_ms,
            self.limits.max_session_lifetime_ms,
        )?;

        if session.streams.contains_key(&stream_id) {
            return Err(EdgeError::DuplicateStream);
        }
        if session.streams.len() >= self.limits.max_streams_per_session {
            return Err(EdgeError::StreamCapacity);
        }

        session.streams.insert(
            stream_id,
            StreamState {
                kind,
                target_port,
                buffered_bytes: 0,
            },
        );
        session.active_kinds.insert(kind);
        Ok(())
    }

    pub fn close_stream(&mut self, session_id: &str, stream_id: u32) -> Result<(), EdgeError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(EdgeError::UnknownSession)?;
        let removed = session
            .streams
            .remove(&stream_id)
            .ok_or(EdgeError::UnknownStream)?;

        session.buffered_bytes = session
            .buffered_bytes
            .checked_sub(removed.buffered_bytes)
            .ok_or(EdgeError::BufferedBytesUnderflow)?;
        self.total_buffered_bytes = self
            .total_buffered_bytes
            .checked_sub(removed.buffered_bytes)
            .ok_or(EdgeError::BufferedBytesUnderflow)?;

        if !session
            .streams
            .values()
            .any(|stream| stream.kind == removed.kind)
        {
            session.active_kinds.remove(&removed.kind);
        }
        Ok(())
    }

    pub fn reserve_buffer(
        &mut self,
        session_id: &str,
        stream_id: u32,
        bytes: usize,
    ) -> Result<(), EdgeError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(EdgeError::UnknownSession)?;
        let stream = session
            .streams
            .get_mut(&stream_id)
            .ok_or(EdgeError::UnknownStream)?;

        let next_stream = stream
            .buffered_bytes
            .checked_add(bytes)
            .ok_or(EdgeError::StreamBackpressure)?;
        if next_stream > self.limits.max_buffered_bytes_per_stream {
            return Err(EdgeError::StreamBackpressure);
        }

        let next_session = session
            .buffered_bytes
            .checked_add(bytes)
            .ok_or(EdgeError::SessionBackpressure)?;
        if next_session > self.limits.max_buffered_bytes_per_session {
            return Err(EdgeError::SessionBackpressure);
        }

        let next_total = self
            .total_buffered_bytes
            .checked_add(bytes)
            .ok_or(EdgeError::GlobalBackpressure)?;
        if next_total > self.limits.max_total_buffered_bytes {
            return Err(EdgeError::GlobalBackpressure);
        }

        stream.buffered_bytes = next_stream;
        session.buffered_bytes = next_session;
        self.total_buffered_bytes = next_total;
        Ok(())
    }

    pub fn release_buffer(
        &mut self,
        session_id: &str,
        stream_id: u32,
        bytes: usize,
    ) -> Result<(), EdgeError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(EdgeError::UnknownSession)?;
        let stream = session
            .streams
            .get_mut(&stream_id)
            .ok_or(EdgeError::UnknownStream)?;

        stream.buffered_bytes = stream
            .buffered_bytes
            .checked_sub(bytes)
            .ok_or(EdgeError::BufferedBytesUnderflow)?;
        session.buffered_bytes = session
            .buffered_bytes
            .checked_sub(bytes)
            .ok_or(EdgeError::BufferedBytesUnderflow)?;
        self.total_buffered_bytes = self
            .total_buffered_bytes
            .checked_sub(bytes)
            .ok_or(EdgeError::BufferedBytesUnderflow)?;
        Ok(())
    }

    pub fn interactive_ready(&self, session_id: &str) -> Result<bool, EdgeError> {
        Ok(self
            .sessions
            .get(session_id)
            .ok_or(EdgeError::UnknownSession)?
            .interactive_ready())
    }

    pub fn stream_target_port(
        &self,
        session_id: &str,
        stream_id: u32,
    ) -> Result<Option<u16>, EdgeError> {
        Ok(self
            .sessions
            .get(session_id)
            .ok_or(EdgeError::UnknownSession)?
            .streams
            .get(&stream_id)
            .ok_or(EdgeError::UnknownStream)?
            .target_port)
    }

    pub fn stream_priority(
        &self,
        session_id: &str,
        stream_id: u32,
    ) -> Result<StreamPriority, EdgeError> {
        Ok(self
            .sessions
            .get(session_id)
            .ok_or(EdgeError::UnknownSession)?
            .streams
            .get(&stream_id)
            .ok_or(EdgeError::UnknownStream)?
            .kind
            .priority())
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_nonce(value: &str) -> bool {
    (32..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_binding(
    binding: &SessionBinding,
    now_ms: u64,
    max_lifetime_ms: u64,
) -> Result<(), EdgeError> {
    if binding.protocol_version != PROTOCOL_VERSION {
        return Err(EdgeError::ProtocolVersion);
    }
    if !valid_identifier(&binding.session_id)
        || !valid_identifier(&binding.machine_id)
        || !valid_identifier(&binding.booking_id)
        || !valid_identifier(&binding.renter_user_id)
    {
        return Err(EdgeError::InvalidIdentifier);
    }
    if !valid_nonce(&binding.nonce) {
        return Err(EdgeError::InvalidNonce);
    }
    if binding.expires_at_ms <= binding.issued_at_ms
        || binding.expires_at_ms - binding.issued_at_ms > max_lifetime_ms
    {
        return Err(EdgeError::InvalidLifetime);
    }
    if now_ms.saturating_add(30_000) < binding.issued_at_ms || now_ms >= binding.expires_at_ms {
        return Err(EdgeError::SessionNotCurrent);
    }
    Ok(())
}

fn validate_target(kind: StreamKind, target_port: Option<u16>) -> Result<(), EdgeError> {
    match (kind, target_port) {
        (StreamKind::AppPort, Some(port)) if port > 0 => Ok(()),
        (StreamKind::AppPort, _) => Err(EdgeError::InvalidTargetPort),
        (_, None) => Ok(()),
        (_, Some(_)) => Err(EdgeError::ForbiddenTargetPort),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str) -> SessionBinding {
        SessionBinding {
            protocol_version: PROTOCOL_VERSION,
            session_id: id.into(),
            machine_id: "machine_1".into(),
            booking_id: "booking_1".into(),
            renter_user_id: "user_1".into(),
            issued_at_ms: 1_000_000,
            expires_at_ms: 1_060_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn management_alone_never_claims_interactive_readiness() {
        let mut registry = EdgeRegistry::new(Limits::default());
        registry
            .register_session(binding("session_1"), 1_001_000)
            .unwrap();
        registry
            .open_stream(
                "session_1",
                1,
                StreamKind::VsCodeManagement,
                None,
                1_001_000,
            )
            .unwrap();
        assert!(!registry.interactive_ready("session_1").unwrap());
        registry
            .open_stream(
                "session_1",
                2,
                StreamKind::VsCodeExtensionHost,
                None,
                1_001_000,
            )
            .unwrap();
        assert!(registry.interactive_ready("session_1").unwrap());
    }

    #[test]
    fn per_stream_session_and_global_backpressure_are_hard_bounds() {
        let limits = Limits {
            max_sessions: 2,
            max_streams_per_session: 2,
            max_buffered_bytes_per_stream: 8,
            max_buffered_bytes_per_session: 10,
            max_total_buffered_bytes: 15,
            max_session_lifetime_ms: 60_000,
        };
        let mut registry = EdgeRegistry::new(limits);
        registry
            .register_session(binding("session_1"), 1_001_000)
            .unwrap();
        registry
            .register_session(binding("session_2"), 1_001_000)
            .unwrap();
        registry
            .open_stream("session_1", 1, StreamKind::Terminal, None, 1_001_000)
            .unwrap();
        registry
            .open_stream("session_1", 2, StreamKind::Terminal, None, 1_001_000)
            .unwrap();
        registry
            .open_stream("session_2", 1, StreamKind::Terminal, None, 1_001_000)
            .unwrap();

        registry.reserve_buffer("session_1", 1, 8).unwrap();
        assert_eq!(
            registry.reserve_buffer("session_1", 1, 1),
            Err(EdgeError::StreamBackpressure)
        );
        registry.reserve_buffer("session_1", 2, 2).unwrap();
        assert_eq!(
            registry.reserve_buffer("session_1", 2, 1),
            Err(EdgeError::SessionBackpressure)
        );
        registry.reserve_buffer("session_2", 1, 5).unwrap();
        assert_eq!(
            registry.reserve_buffer("session_2", 1, 1),
            Err(EdgeError::GlobalBackpressure)
        );
        assert_eq!(registry.total_buffered_bytes(), 15);
    }

    #[test]
    fn app_port_is_the_only_kind_that_can_carry_a_target_port() {
        let mut registry = EdgeRegistry::new(Limits::default());
        registry
            .register_session(binding("session_1"), 1_001_000)
            .unwrap();
        assert_eq!(
            registry.open_stream("session_1", 1, StreamKind::Terminal, Some(22), 1_001_000),
            Err(EdgeError::ForbiddenTargetPort)
        );
        registry
            .open_stream("session_1", 2, StreamKind::AppPort, Some(8000), 1_001_000)
            .unwrap();
        assert_eq!(
            registry.stream_target_port("session_1", 2).unwrap(),
            Some(8000)
        );
    }

    #[test]
    fn drain_refuses_new_sessions_but_existing_sessions_can_finish() {
        let mut registry = EdgeRegistry::new(Limits::default());
        registry
            .register_session(binding("session_1"), 1_001_000)
            .unwrap();
        registry.set_mode(EdgeMode::Draining);
        assert_eq!(registry.mode(), EdgeMode::Draining);
        assert_eq!(
            registry.register_session(binding("session_2"), 1_001_000),
            Err(EdgeError::NotAcceptingSessions)
        );
        registry
            .open_stream("session_1", 1, StreamKind::Terminal, None, 1_001_000)
            .unwrap();
        registry.close_stream("session_1", 1).unwrap();
        registry.remove_session("session_1").unwrap();
        assert_eq!(registry.session_count(), 0);
    }

    #[test]
    fn interactive_streams_have_priority_over_bulk_transfer() {
        assert!(StreamKind::Control.priority() > StreamKind::VsCodeManagement.priority());
        assert!(StreamKind::VsCodeManagement.priority() > StreamKind::FileTransfer.priority());
        assert!(StreamKind::Terminal.priority() > StreamKind::FileTransfer.priority());
    }

    #[test]
    fn removing_a_session_releases_its_entire_buffer_budget() {
        let mut registry = EdgeRegistry::new(Limits::default());
        registry
            .register_session(binding("session_1"), 1_001_000)
            .unwrap();
        registry
            .open_stream("session_1", 1, StreamKind::FileTransfer, None, 1_001_000)
            .unwrap();
        registry.reserve_buffer("session_1", 1, 4096).unwrap();
        assert_eq!(registry.total_buffered_bytes(), 4096);
        registry.remove_session("session_1").unwrap();
        assert_eq!(registry.total_buffered_bytes(), 0);
        assert_eq!(registry.session_count(), 0);
    }

    #[test]
    fn expired_or_malformed_authority_never_enters_the_registry() {
        let mut registry = EdgeRegistry::new(Limits::default());
        let mut expired = binding("session_expired");
        expired.expires_at_ms = 1_000_001;
        assert_eq!(
            registry.register_session(expired, 1_001_000),
            Err(EdgeError::SessionNotCurrent)
        );

        let mut malformed = binding("../escape");
        malformed.expires_at_ms = 1_060_000;
        assert_eq!(
            registry.register_session(malformed, 1_001_000),
            Err(EdgeError::InvalidIdentifier)
        );
        assert_eq!(registry.session_count(), 0);
    }
}
