from pathlib import Path

edge = Path("services/edge/src/bin/gpubnb-edge.rs")
text = edge.read_text()

host_marker = '''        return Err(error);
    }

    info!(
        event = "edge_host_tunnel_ready",
'''
host_replacement = '''        return Err(error);
    }
    // FIN alone does not release Quinn's concurrent-stream accounting while
    // the SendStream handle remains live. Drop the completed one-shot auth
    // control stream before the long-lived Host connection enters service.
    drop(auth_send);

    info!(
        event = "edge_host_tunnel_ready",
'''
if host_marker not in text:
    raise SystemExit("expected Host auth success marker not found")
text = text.replace(host_marker, host_replacement, 1)

renter_marker = '''    write_control_response(&mut auth_send, br#"{"ok":true,"protocol":"gpubnb-dp/1"}"#).await?;
    info!(
        event = "edge_session_authenticated",
'''
renter_replacement = '''    write_control_response(&mut auth_send, br#"{"ok":true,"protocol":"gpubnb-dp/1"}"#).await?;
    // The authenticated connection is long-lived; the one-shot auth stream is
    // not. Release its transport credit before accepting workspace streams.
    drop(auth_send);
    info!(
        event = "edge_session_authenticated",
'''
if renter_marker not in text:
    raise SystemExit("expected Renter auth response block not found")
text = text.replace(renter_marker, renter_replacement, 1)
edge.write_text(text)

client = Path("services/edge/examples/e2e_client.rs")
text = client.read_text()
import_old = '''use wire::{
    read_json_frame, write_json_frame, OpenStreamFrame, StreamStatusFrame, WireStreamKind,
    STREAM_METADATA_MAX_BYTES, STREAM_STATUS_MAX_BYTES,
};
'''
import_new = '''use wire::{
    read_json_frame, write_json_frame, OpenStreamFrame, StreamRejectCode, StreamStatusFrame,
    WireStreamKind, STREAM_METADATA_MAX_BYTES, STREAM_STATUS_MAX_BYTES,
};
'''
if import_old not in text:
    raise SystemExit("expected E2E wire import not found")
text = text.replace(import_old, import_new, 1)

old = '''    if tokio::time::timeout(Duration::from_millis(750), connection.open_bi())
        .await
        .is_ok()
    {
        bail!("65th workspace stream transport slot opened before capacity was released");
    }

    println!("pressure-ready");
'''
new = '''    // QUIC has one control-stream reserve beyond the 64 workspace-stream
    // application budget. Saturation must therefore reach EdgeRegistry and
    // return a deterministic STREAM_LIMIT, never masquerade as a network stall.
    let (mut overflow_send, mut overflow_recv) =
        tokio::time::timeout(Duration::from_secs(5), connection.open_bi())
            .await
            .context("65th workspace stream could not reach application admission")??;
    let overflow_frame = OpenStreamFrame {
        message_type: "OPEN_STREAM".into(),
        stream_id: 9_998,
        kind: WireStreamKind::Terminal,
        target_port: None,
        resume_from_sequence: None,
    };
    write_json_frame(
        &mut overflow_send,
        &overflow_frame,
        STREAM_METADATA_MAX_BYTES,
    )
    .await?;
    overflow_send
        .finish()
        .context("finish over-capacity workspace stream")?;
    let overflow_status: StreamStatusFrame = tokio::time::timeout(
        Duration::from_secs(5),
        read_json_frame(&mut overflow_recv, STREAM_STATUS_MAX_BYTES),
    )
    .await
    .context("65th workspace stream did not receive bounded application rejection")??;
    overflow_status.validate_for(9_998)?;
    if overflow_status.is_accepted() || overflow_status.code != Some(StreamRejectCode::StreamLimit) {
        bail!(
            "65th workspace stream must be rejected explicitly with STREAM_LIMIT, got {:?}",
            overflow_status.code
        );
    }
    let trailing = overflow_recv
        .read_to_end(ROUTED_RESPONSE_MAX_BYTES)
        .await
        .context("finish reading over-capacity rejection stream")?;
    if !trailing.is_empty() {
        bail!("over-capacity rejection carried unexpected payload bytes");
    }

    println!("pressure-ready");
'''
if old not in text:
    raise SystemExit("expected old 65th-stream transport assertion not found")
text = text.replace(old, new, 1)
client.write_text(text)
