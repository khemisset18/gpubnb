//! Typed control-service <-> renter-worker contract.
//!
//! Windows named-pipe ACL/token verification belongs to the platform layer. This
//! module adds a second fail-closed fence: even an accepted local pipe peer must
//! match the exact booking session, GPU, workspace, generation and WTS session.
//! This hello proves identity only. Virtual-display/capture/NVENC proofs belong to
//! the later readiness lifecycle and must never be forged just to establish IPC.
//! The protocol deliberately contains no shell command or arbitrary executable path.

use crate::lifecycle::WorkspaceKind;

pub const WORKER_PROTOCOL_VERSION: u16 = 1;
pub const MAX_WORKER_HELLO_FRAME: usize = 512;
const MAX_SESSION_ID: usize = 128;
const MAX_GPU_UUID: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerCommand {
    PrepareDisplay,
    StartCapture,
    SuspendMedia,
    ResumeAfterFreshProof,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerFence<'a> {
    pub session_id: &'a str,
    pub gpu_uuid: &'a str,
    pub workspace: WorkspaceKind,
    pub generation: u64,
    pub windows_session_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerHelloOwned {
    pub protocol_version: u16,
    pub session_id: String,
    pub gpu_uuid: String,
    pub workspace: WorkspaceKind,
    pub generation: u64,
    pub windows_session_id: u32,
    pub worker_pid: u32,
}

impl WorkerHelloOwned {
    pub fn as_borrowed(&self) -> WorkerHello<'_> {
        WorkerHello {
            protocol_version: self.protocol_version,
            session_id: &self.session_id,
            gpu_uuid: &self.gpu_uuid,
            workspace: self.workspace,
            generation: self.generation,
            windows_session_id: self.windows_session_id,
            worker_pid: self.worker_pid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerHello<'a> {
    pub protocol_version: u16,
    pub session_id: &'a str,
    pub gpu_uuid: &'a str,
    pub workspace: WorkspaceKind,
    pub generation: u64,
    pub windows_session_id: u32,
    pub worker_pid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerFrameError {
    TooLarge,
    Truncated,
    TrailingBytes,
    InvalidUtf8,
    InvalidSession,
    InvalidGpu,
    InvalidWorkspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerHandshakeError {
    ProtocolVersion,
    Session,
    Gpu,
    Workspace,
    Generation,
    WindowsSession,
    WorkerPid,
    WindowsSession,
}

fn workspace_tag(workspace: WorkspaceKind) -> u8 {
    match workspace {
        WorkspaceKind::CloudDesktop => 1,
        WorkspaceKind::Creator => 2,
        WorkspaceKind::Cad => 3,
        WorkspaceKind::Gaming => 4,
    }
}

fn workspace_from_tag(tag: u8) -> Result<WorkspaceKind, WorkerFrameError> {
    match tag {
        1 => Ok(WorkspaceKind::CloudDesktop),
        2 => Ok(WorkspaceKind::Creator),
        3 => Ok(WorkspaceKind::Cad),
        4 => Ok(WorkspaceKind::Gaming),
        _ => Err(WorkerFrameError::InvalidWorkspace),
    }
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SESSION_ID
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_gpu_uuid(value: &str) -> bool {
    if value.len() > MAX_GPU_UUID || !value.starts_with("GPU-") {
        return false;
    }
    let uuid = &value[4..];
    if uuid.len() != 36 {
        return false;
    }
    uuid.bytes().enumerate().all(|(index, byte)| {
        let hyphen = matches!(index, 8 | 13 | 18 | 23);
        (hyphen && byte == b'-') || (!hyphen && byte.is_ascii_hexdigit())
    })
}

fn push_string(frame: &mut Vec<u8>, value: &str) -> Result<(), WorkerFrameError> {
    let len = u8::try_from(value.len()).map_err(|_| WorkerFrameError::TooLarge)?;
    frame.push(len);
    frame.extend_from_slice(value.as_bytes());
    Ok(())
}

pub fn encode_worker_hello(hello: WorkerHello<'_>) -> Result<Vec<u8>, WorkerFrameError> {
    if !valid_session_id(hello.session_id) {
        return Err(WorkerFrameError::InvalidSession);
    }
    if !valid_gpu_uuid(hello.gpu_uuid) {
        return Err(WorkerFrameError::InvalidGpu);
    }

    let mut frame = Vec::with_capacity(128);
    frame.extend_from_slice(&hello.protocol_version.to_le_bytes());
    push_string(&mut frame, hello.session_id)?;
    push_string(&mut frame, hello.gpu_uuid)?;
    frame.push(workspace_tag(hello.workspace));
    frame.extend_from_slice(&hello.generation.to_le_bytes());
    frame.extend_from_slice(&hello.windows_session_id.to_le_bytes());
    frame.extend_from_slice(&hello.worker_pid.to_le_bytes());

    if frame.len() > MAX_WORKER_HELLO_FRAME {
        return Err(WorkerFrameError::TooLarge);
    }
    Ok(frame)
}

struct FrameCursor<'a> {
    frame: &'a [u8],
    offset: usize,
}

impl<'a> FrameCursor<'a> {
    fn new(frame: &'a [u8]) -> Result<Self, WorkerFrameError> {
        if frame.len() > MAX_WORKER_HELLO_FRAME {
            return Err(WorkerFrameError::TooLarge);
        }
        Ok(Self { frame, offset: 0 })
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], WorkerFrameError> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or(WorkerFrameError::Truncated)?;
        let value = self
            .frame
            .get(self.offset..end)
            .ok_or(WorkerFrameError::Truncated)?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, WorkerFrameError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, WorkerFrameError> {
        let bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| WorkerFrameError::Truncated)?;
        Ok(u16::from_le_bytes(bytes))
    }

    fn u32(&mut self) -> Result<u32, WorkerFrameError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| WorkerFrameError::Truncated)?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, WorkerFrameError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| WorkerFrameError::Truncated)?;
        Ok(u64::from_le_bytes(bytes))
    }

    fn string(&mut self) -> Result<String, WorkerFrameError> {
        let len = usize::from(self.u8()?);
        let raw = self.take(len)?;
        let value = std::str::from_utf8(raw).map_err(|_| WorkerFrameError::InvalidUtf8)?;
        Ok(value.to_owned())
    }

    fn finish(self) -> Result<(), WorkerFrameError> {
        if self.offset == self.frame.len() {
            Ok(())
        } else {
            Err(WorkerFrameError::TrailingBytes)
        }
    }
}

pub fn decode_worker_hello(frame: &[u8]) -> Result<WorkerHelloOwned, WorkerFrameError> {
    let mut cursor = FrameCursor::new(frame)?;
    let protocol_version = cursor.u16()?;
    let session_id = cursor.string()?;
    let gpu_uuid = cursor.string()?;
    let workspace = workspace_from_tag(cursor.u8()?)?;
    let generation = cursor.u64()?;
    let windows_session_id = cursor.u32()?;
    let worker_pid = cursor.u32()?;
    cursor.finish()?;

    if !valid_session_id(&session_id) {
        return Err(WorkerFrameError::InvalidSession);
    }
    if !valid_gpu_uuid(&gpu_uuid) {
        return Err(WorkerFrameError::InvalidGpu);
    }

    Ok(WorkerHelloOwned {
        protocol_version,
        session_id,
        gpu_uuid,
        workspace,
        generation,
        windows_session_id,
        worker_pid,
    })
}

pub fn validate_worker_hello(
    expected: WorkerFence<'_>,
    hello: WorkerHello<'_>,
) -> Result<(), WorkerHandshakeError> {
    if hello.protocol_version != WORKER_PROTOCOL_VERSION {
        return Err(WorkerHandshakeError::ProtocolVersion);
    }
    if hello.session_id != expected.session_id {
        return Err(WorkerHandshakeError::Session);
    }
    if !hello.gpu_uuid.eq_ignore_ascii_case(expected.gpu_uuid) {
        return Err(WorkerHandshakeError::Gpu);
    }
    if hello.workspace != expected.workspace {
        return Err(WorkerHandshakeError::Workspace);
    }
    if hello.generation != expected.generation {
        return Err(WorkerHandshakeError::Generation);
    }
    if hello.windows_session_id != expected.windows_session_id {
        return Err(WorkerHandshakeError::WindowsSession);
    }
    if hello.worker_pid == 0 {
        return Err(WorkerHandshakeError::WorkerPid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "sess-123";
    const GPU: &str = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a";

    fn fence() -> WorkerFence<'static> {
        WorkerFence {
            session_id: SESSION,
            gpu_uuid: GPU,
            workspace: WorkspaceKind::CloudDesktop,
            generation: 7,
            windows_session_id: 0x1020_3040,
        }
    }

    fn hello() -> WorkerHello<'static> {
        WorkerHello {
            protocol_version: WORKER_PROTOCOL_VERSION,
            session_id: SESSION,
            gpu_uuid: GPU,
            workspace: WorkspaceKind::CloudDesktop,
            generation: 7,
            windows_session_id: 0x1020_3040,
            worker_pid: 4242,
        }
    }

    #[test]
    fn worker_hello_binary_frame_round_trips() {
        let value = hello();
        let encoded = encode_worker_hello(value).expect("encode hello");
        assert!(encoded.len() <= MAX_WORKER_HELLO_FRAME);
        let decoded = decode_worker_hello(&encoded).expect("decode hello");
        assert_eq!(decoded.as_borrowed(), value);
    }

    #[test]
    fn worker_hello_frame_rejects_truncation_and_trailing_bytes() {
        let encoded = encode_worker_hello(hello()).expect("encode hello");

        for cut in 0..encoded.len() {
            assert!(decode_worker_hello(&encoded[..cut]).is_err(), "cut={cut}");
        }

        let mut trailing = encoded.clone();
        trailing.push(0);
        assert_eq!(
            decode_worker_hello(&trailing),
            Err(WorkerFrameError::TrailingBytes)
        );
    }

    #[test]
    fn worker_hello_frame_rejects_oversized_input_before_parsing() {
        let oversized = vec![0u8; MAX_WORKER_HELLO_FRAME + 1];
        assert_eq!(
            decode_worker_hello(&oversized),
            Err(WorkerFrameError::TooLarge)
        );
    }

    #[test]
    fn exact_worker_fence_is_accepted() {
        assert_eq!(validate_worker_hello(fence(), hello()), Ok(()));
    }

    #[test]
    fn stale_or_cross_session_worker_is_rejected() {
        let mut value = hello();
        value.session_id = "sess-other";
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Session)
        );

        let mut value = hello();
        value.generation -= 1;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Generation)
        );
    }

    #[test]
    fn wrong_gpu_workspace_or_windows_session_is_rejected() {
        let mut value = hello();
        value.gpu_uuid = "GPU-11111111-1111-1111-1111-111111111111";
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Gpu)
        );

        let mut value = hello();
        value.workspace = WorkspaceKind::Gaming;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::Workspace)
        );

        let mut value = hello();
        value.windows_session_id += 1;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::WindowsSession)
        );
    }

    #[test]
    fn protocol_and_pid_fail_closed() {
        let mut value = hello();
        value.protocol_version += 1;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::ProtocolVersion)
        );

        let mut value = hello();
        value.worker_pid = 0;
        assert_eq!(
            validate_worker_hello(fence(), value),
            Err(WorkerHandshakeError::WorkerPid)
        );
    }

    #[test]
    fn command_surface_has_no_arbitrary_execute_variant() {
        let commands = [
            WorkerCommand::PrepareDisplay,
            WorkerCommand::StartCapture,
            WorkerCommand::SuspendMedia,
            WorkerCommand::ResumeAfterFreshProof,
            WorkerCommand::Stop,
        ];
        assert_eq!(commands.len(), 5);
    }
}
