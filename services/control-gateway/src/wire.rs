use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Serialize};

const FRAME_LENGTH_BYTES: usize = 4;

pub async fn read_json_frame<T: DeserializeOwned>(
    recv: &mut quinn::RecvStream,
    max_bytes: usize,
) -> Result<T> {
    if max_bytes == 0 || max_bytes > u32::MAX as usize {
        bail!("invalid maximum frame size");
    }
    let mut length = [0_u8; FRAME_LENGTH_BYTES];
    recv.read_exact(&mut length)
        .await
        .context("failed to read control frame length")?;
    let payload_len = u32::from_be_bytes(length) as usize;
    if payload_len == 0 || payload_len > max_bytes {
        bail!("control frame length outside configured bound");
    }
    let mut payload = vec![0_u8; payload_len];
    recv.read_exact(&mut payload)
        .await
        .context("failed to read bounded control frame payload")?;
    serde_json::from_slice(&payload).context("invalid control-gateway JSON frame")
}

pub async fn write_json_frame<T: Serialize>(
    send: &mut quinn::SendStream,
    value: &T,
    max_bytes: usize,
) -> Result<()> {
    if max_bytes == 0 || max_bytes > u32::MAX as usize {
        bail!("invalid maximum frame size");
    }
    let payload = serde_json::to_vec(value).context("failed to serialize control frame")?;
    if payload.is_empty() || payload.len() > max_bytes {
        bail!("serialized control frame exceeds configured bound");
    }
    send.write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .context("failed to write control frame length")?;
    send.write_all(&payload)
        .await
        .context("failed to write control frame payload")?;
    Ok(())
}
