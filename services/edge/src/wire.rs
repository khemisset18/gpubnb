use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use gpubnb_edge_core::StreamKind;

pub const STREAM_METADATA_MAX_BYTES: usize = 8 * 1024;
pub const STREAM_STATUS_MAX_BYTES: usize = 2 * 1024;
const FRAME_LENGTH_BYTES: usize = 4;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WireStreamKind {
    Control,
    VscodeManagement,
    VscodeExtensionHost,
    Terminal,
    FileTransfer,
    Jupyter,
    AppPort,
}

impl From<WireStreamKind> for StreamKind {
    fn from(value: WireStreamKind) -> Self {
        match value {
            WireStreamKind::Control => StreamKind::Control,
            WireStreamKind::VscodeManagement => StreamKind::VsCodeManagement,
            WireStreamKind::VscodeExtensionHost => StreamKind::VsCodeExtensionHost,
            WireStreamKind::Terminal => StreamKind::Terminal,
            WireStreamKind::FileTransfer => StreamKind::FileTransfer,
            WireStreamKind::Jupyter => StreamKind::Jupyter,
            WireStreamKind::AppPort => StreamKind::AppPort,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenStreamFrame {
    #[serde(rename = "type")]
    pub message_type: String,
    pub stream_id: u32,
    pub kind: WireStreamKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_from_sequence: Option<u64>,
}

// The wire source is intentionally shared by the Edge, Host tunnel and E2E
// executable targets. Each target consumes a different subset of helpers, so
// target-local dead-code analysis must not turn that deliberate sharing into a
// build failure.
#[allow(dead_code)]
impl OpenStreamFrame {
    pub fn validate(&self) -> Result<StreamKind> {
        if self.message_type != "OPEN_STREAM" {
            bail!("routed stream first frame must be OPEN_STREAM");
        }
        if self.stream_id == 0 || self.stream_id > 0x7fff_ffff {
            bail!("routed stream id invalid");
        }
        let kind: StreamKind = self.kind.into();
        match (kind, self.target_port) {
            (StreamKind::AppPort, Some(port)) if port > 0 => {}
            (StreamKind::AppPort, _) => bail!("APP_PORT requires a target port"),
            (_, None) => {}
            (_, Some(_)) => bail!("target port is forbidden for this stream kind"),
        }
        Ok(kind)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StreamRejectCode {
    Unauthorized,
    SessionExpired,
    StreamLimit,
    InvalidTarget,
    UnsupportedKind,
    ResumeWindowExpired,
    HostUnavailable,
    TargetUnavailable,
    InternalError,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StreamStatusFrame {
    #[serde(rename = "type")]
    pub message_type: String,
    pub stream_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<StreamRejectCode>,
}

#[allow(dead_code)]
impl StreamStatusFrame {
    pub fn accepted(stream_id: u32) -> Self {
        Self {
            message_type: "STREAM_ACCEPTED".into(),
            stream_id,
            initial_sequence: Some(0),
            code: None,
        }
    }

    pub fn rejected(stream_id: u32, code: StreamRejectCode) -> Self {
        Self {
            message_type: "STREAM_REJECTED".into(),
            stream_id,
            initial_sequence: None,
            code: Some(code),
        }
    }

    pub fn validate_for(&self, stream_id: u32) -> Result<()> {
        if self.stream_id != stream_id {
            bail!("stream status id mismatch");
        }
        match self.message_type.as_str() {
            "STREAM_ACCEPTED" if self.initial_sequence.is_some() && self.code.is_none() => Ok(()),
            "STREAM_REJECTED" if self.initial_sequence.is_none() && self.code.is_some() => Ok(()),
            _ => bail!("invalid stream status frame"),
        }
    }

    pub fn is_accepted(&self) -> bool {
        self.message_type == "STREAM_ACCEPTED"
    }
}

pub async fn read_json_frame<T: DeserializeOwned>(
    recv: &mut quinn::RecvStream,
    max_bytes: usize,
) -> Result<T> {
    let mut length = [0_u8; FRAME_LENGTH_BYTES];
    recv.read_exact(&mut length)
        .await
        .context("failed to read frame length")?;
    let payload_len = u32::from_be_bytes(length) as usize;
    if payload_len == 0 || payload_len > max_bytes {
        bail!("frame length outside configured bound");
    }
    let mut payload = vec![0_u8; payload_len];
    recv.read_exact(&mut payload)
        .await
        .context("failed to read bounded frame payload")?;
    serde_json::from_slice(&payload).context("invalid routed-stream JSON frame")
}

pub async fn write_json_frame<T: Serialize>(
    send: &mut quinn::SendStream,
    value: &T,
    max_bytes: usize,
) -> Result<()> {
    let payload = serde_json::to_vec(value).context("failed to serialize routed-stream frame")?;
    if payload.is_empty() || payload.len() > max_bytes || payload.len() > u32::MAX as usize {
        bail!("serialized frame length outside configured bound");
    }
    send.write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .context("failed to write frame length")?;
    send.write_all(&payload)
        .await
        .context("failed to write bounded frame payload")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_stream_contract_rejects_target_confusion() {
        let valid = OpenStreamFrame {
            message_type: "OPEN_STREAM".into(),
            stream_id: 1,
            kind: WireStreamKind::VscodeManagement,
            target_port: None,
            resume_from_sequence: None,
        };
        assert_eq!(valid.validate().unwrap(), StreamKind::VsCodeManagement);

        let mut invalid = valid.clone();
        invalid.target_port = Some(3000);
        assert!(invalid.validate().is_err());

        let app = OpenStreamFrame {
            message_type: "OPEN_STREAM".into(),
            stream_id: 2,
            kind: WireStreamKind::AppPort,
            target_port: Some(8888),
            resume_from_sequence: None,
        };
        assert_eq!(app.validate().unwrap(), StreamKind::AppPort);
    }

    #[test]
    fn status_frames_cannot_mix_accept_and_reject_shapes() {
        let accepted = StreamStatusFrame::accepted(7);
        accepted.validate_for(7).unwrap();
        assert!(accepted.is_accepted());

        let rejected = StreamStatusFrame::rejected(7, StreamRejectCode::InvalidTarget);
        rejected.validate_for(7).unwrap();
        assert!(!rejected.is_accepted());
    }
}
