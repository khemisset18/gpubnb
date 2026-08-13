from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "services/edge/src/transport.rs",
    '''// Protocol v1 has two transport-only concerns outside the workspace session
// budget: the one-shot authority/control stream and one bounded admission slot.
// The admission reserve lets an over-capacity workspace attempt reach
// EdgeRegistry and receive an explicit STREAM_LIMIT instead of stalling at the
// QUIC layer while all 64 application streams are live.
pub const MAX_APPLICATION_BIDI_STREAMS: u32 = 64;
pub const CONTROL_BIDI_STREAM_RESERVE: u32 = 1;
pub const ADMISSION_BIDI_STREAM_RESERVE: u32 = 1;
pub const MAX_BIDI_STREAMS: u32 =
    MAX_APPLICATION_BIDI_STREAMS + CONTROL_BIDI_STREAM_RESERVE + ADMISSION_BIDI_STREAM_RESERVE;
''',
    '''// Protocol v1 keeps application capacity at 64 workspace streams. Quinn
// deliberately batches MAX_STREAMS updates until more than 1/8 of the current
// remote-stream window has been freed, so transport needs bounded spare credit
// for auth, explicit over-capacity rejection, and normal stream churn while a
// replenishment update is pending. With 75 transport credits, Quinn's threshold
// is 9; a reserve of 10 guarantees progress until the next MAX_STREAMS update.
pub const MAX_APPLICATION_BIDI_STREAMS: u32 = 64;
pub const CONTROL_BIDI_STREAM_RESERVE: u32 = 1;
pub const STREAM_CREDIT_REPLENISHMENT_RESERVE: u32 = 10;
pub const MAX_BIDI_STREAMS: u32 = MAX_APPLICATION_BIDI_STREAMS
    + CONTROL_BIDI_STREAM_RESERVE
    + STREAM_CREDIT_REPLENISHMENT_RESERVE;
''',
)
replace_once(
    "services/edge/src/transport.rs",
    '''const _: () = assert!(STREAM_RECEIVE_WINDOW_BYTES <= CONNECTION_RECEIVE_WINDOW_BYTES);
''',
    '''const _: () = assert!(STREAM_RECEIVE_WINDOW_BYTES <= CONNECTION_RECEIVE_WINDOW_BYTES);
const _: () = assert!(STREAM_CREDIT_REPLENISHMENT_RESERVE > MAX_BIDI_STREAMS / 8);
''',
)
replace_once(
    "services/edge/src/transport.rs",
    '''        assert_eq!(CONTROL_BIDI_STREAM_RESERVE, 1);
        assert_eq!(ADMISSION_BIDI_STREAM_RESERVE, 1);
        assert_eq!(
            MAX_BIDI_STREAMS,
            MAX_APPLICATION_BIDI_STREAMS
                + CONTROL_BIDI_STREAM_RESERVE
                + ADMISSION_BIDI_STREAM_RESERVE
        );
''',
    '''        assert_eq!(CONTROL_BIDI_STREAM_RESERVE, 1);
        assert_eq!(STREAM_CREDIT_REPLENISHMENT_RESERVE, 10);
        assert_eq!(
            MAX_BIDI_STREAMS,
            MAX_APPLICATION_BIDI_STREAMS
                + CONTROL_BIDI_STREAM_RESERVE
                + STREAM_CREDIT_REPLENISHMENT_RESERVE
        );
        assert!(STREAM_CREDIT_REPLENISHMENT_RESERVE > MAX_BIDI_STREAMS / 8);
''',
)

replace_once(
    "services/edge/ci/production-qualification.sh",
    "grep -q 'max_bidi_streams=66' \"$EDGE_LOG\"",
    "grep -q 'max_bidi_streams=75' \"$EDGE_LOG\"",
)
replace_once(
    "services/edge/ci/production-qualification.sh",
    "  echo 'remote_bidi_streams=66'\n  echo 'application_bidi_streams=64'\n  echo 'control_bidi_stream_reserve=1'\n  echo 'admission_bidi_stream_reserve=1'",
    "  echo 'remote_bidi_streams=75'\n  echo 'application_bidi_streams=64'\n  echo 'control_bidi_stream_reserve=1'\n  echo 'stream_credit_replenishment_reserve=10'",
)
replace_once(
    "services/edge/ci/production-qualification.sh",
    "  echo 'stream_pressure=64_application_streams_then_explicit_65th_reject_then_release'",
    "  echo 'stream_pressure=64_application_streams_then_explicit_65th_reject_then_10_churn_rotations'",
)

replace_once(
    "services/edge/examples/e2e_client.rs",
    '''    // QUIC has one control-stream reserve beyond the 64 workspace-stream
    // application budget. Saturation must therefore reach EdgeRegistry and
    // return a deterministic STREAM_LIMIT, never masquerade as a network stall.
''',
    '''    // Transport has bounded infrastructure/replenishment credit beyond the
    // 64 workspace application budget. Saturation must therefore reach
    // EdgeRegistry and return a deterministic STREAM_LIMIT, never masquerade as
    // a transport-level stream-credit stall.
''',
)
replace_once(
    "services/edge/examples/e2e_client.rs",
    '''    let trailing = overflow_recv
        .read_to_end(ROUTED_RESPONSE_MAX_BYTES)
        .await
        .context("finish reading over-capacity rejection stream")?;
    if !trailing.is_empty() {
        bail!("over-capacity rejection carried unexpected payload bytes");
    }
''',
    '''    let trailing = overflow_recv
        .read_to_end(ROUTED_RESPONSE_MAX_BYTES)
        .await
        .context("finish reading over-capacity rejection stream")?;
    if !trailing.is_empty() {
        bail!("over-capacity rejection carried unexpected payload bytes");
    }
    match tokio::time::timeout(Duration::from_secs(5), overflow_send.stopped())
        .await
        .context("over-capacity request FIN was not acknowledged")??
    {
        None => {}
        Some(code) => bail!("over-capacity request was stopped unexpectedly: {code}"),
    }
''',
)
old = '''    // A QUIC bidi stream is not reusable merely because one local handle was
    // dropped. Complete both directions and observe the peer FIN before
    // asserting MAX_STREAMS credit and application capacity are reusable.
    let (mut released_send, mut released_recv) = streams.remove(0);
    released_send
        .finish()
        .context("finish released pressure stream")?;
    let released_response = tokio::time::timeout(
        Duration::from_secs(5),
        released_recv.read_to_end(ROUTED_RESPONSE_MAX_BYTES),
    )
    .await
    .context("released pressure stream did not close bidirectionally")??;
    if !released_response.is_empty() {
        bail!("zero-byte pressure stream unexpectedly returned payload data");
    }

    let (mut send, mut recv) = tokio::time::timeout(Duration::from_secs(5), connection.open_bi())
        .await
        .context("stream capacity was not released after full stream closure")??;
    let frame = OpenStreamFrame {
        message_type: "OPEN_STREAM".into(),
        stream_id: 9_999,
        kind: WireStreamKind::Terminal,
        target_port: None,
        resume_from_sequence: None,
    };
    write_json_frame(&mut send, &frame, STREAM_METADATA_MAX_BYTES).await?;
    let status: StreamStatusFrame = read_json_frame(&mut recv, STREAM_STATUS_MAX_BYTES).await?;
    status.validate_for(9_999)?;
    if !status.is_accepted() {
        bail!("replacement stream was rejected after capacity release");
    }
    send.finish()
        .context("finish replacement pressure stream")?;
    let _ = recv.read_to_end(ROUTED_RESPONSE_MAX_BYTES).await?;
'''
new = '''    // Quinn batches MAX_STREAMS updates until more than 1/8 of the advertised
    // remote-stream window has been freed. Rotate ten workspace streams while
    // keeping application concurrency at 64. This proves the bounded transport
    // reserve carries churn until Quinn replenishes cumulative stream credit.
    for rotation in 0..10_u64 {
        let (mut released_send, mut released_recv) = streams.remove(0);
        released_send
            .finish()
            .context("finish released pressure stream")?;
        let released_response = tokio::time::timeout(
            Duration::from_secs(5),
            released_recv.read_to_end(ROUTED_RESPONSE_MAX_BYTES),
        )
        .await
        .context("released pressure stream did not receive peer FIN")??;
        if !released_response.is_empty() {
            bail!("zero-byte pressure stream unexpectedly returned payload data");
        }
        match tokio::time::timeout(Duration::from_secs(5), released_send.stopped())
            .await
            .context("released pressure request FIN was not acknowledged")??
        {
            None => {}
            Some(code) => bail!("released pressure request was stopped unexpectedly: {code}"),
        }

        let (mut send, mut recv) =
            tokio::time::timeout(Duration::from_secs(5), connection.open_bi())
                .await
                .with_context(|| {
                    format!("stream credit was not replenished during churn rotation {rotation}")
                })??;
        let stream_id = 10_000 + rotation;
        let frame = OpenStreamFrame {
            message_type: "OPEN_STREAM".into(),
            stream_id,
            kind: WireStreamKind::Terminal,
            target_port: None,
            resume_from_sequence: None,
        };
        write_json_frame(&mut send, &frame, STREAM_METADATA_MAX_BYTES).await?;
        let status: StreamStatusFrame = read_json_frame(&mut recv, STREAM_STATUS_MAX_BYTES).await?;
        status.validate_for(stream_id)?;
        if !status.is_accepted() {
            bail!("replacement stream was rejected during churn rotation {rotation}");
        }
        streams.push((send, recv));
    }
'''
replace_once("services/edge/examples/e2e_client.rs", old, new)
