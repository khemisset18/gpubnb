use gpubnb_edge_core::{
    EdgeError, EdgeRegistry, Limits, SessionBinding, StreamKind, PROTOCOL_VERSION,
};

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

fn next(seed: &mut u64) -> u64 {
    // Deterministic LCG: this is a reproducible stress sequence, not cryptography.
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    *seed
}

#[test]
fn randomized_buffer_operations_never_escape_global_budget_and_cleanup_returns_to_zero() {
    let limits = Limits {
        max_sessions: 4,
        max_streams_per_session: 8,
        max_buffered_bytes_per_stream: 512,
        max_buffered_bytes_per_session: 1024,
        max_total_buffered_bytes: 2048,
        max_session_lifetime_ms: 60_000,
    };
    let mut registry = EdgeRegistry::new(limits);
    let mut seed = 0x5eed_cafe_dead_beef;

    for session_index in 0..4 {
        let session_id = format!("session_{session_index}");
        registry
            .register_session(binding(&session_id), 1_001_000)
            .unwrap();
        for stream_index in 1..=4 {
            registry
                .open_stream(
                    &session_id,
                    stream_index,
                    if stream_index % 2 == 0 {
                        StreamKind::FileTransfer
                    } else {
                        StreamKind::Terminal
                    },
                    None,
                    1_001_000,
                )
                .unwrap();
        }
    }

    let mut reserved = [[0usize; 5]; 4];
    for _ in 0..10_000 {
        let value = next(&mut seed);
        let session_index = (value as usize) % 4;
        let stream_index = (((value >> 8) as usize) % 4) + 1;
        let bytes = (((value >> 16) as usize) % 64) + 1;
        let session_id = format!("session_{session_index}");

        if value & 1 == 0 {
            match registry.reserve_buffer(&session_id, stream_index as u32, bytes) {
                Ok(()) => reserved[session_index][stream_index] += bytes,
                Err(
                    EdgeError::StreamBackpressure
                    | EdgeError::SessionBackpressure
                    | EdgeError::GlobalBackpressure,
                ) => {}
                Err(other) => panic!("unexpected reserve error: {other:?}"),
            }
        } else {
            let currently_reserved = reserved[session_index][stream_index];
            if currently_reserved > 0 {
                let release = bytes.min(currently_reserved);
                registry
                    .release_buffer(&session_id, stream_index as u32, release)
                    .unwrap();
                reserved[session_index][stream_index] -= release;
            }
        }

        assert!(registry.total_buffered_bytes() <= limits.max_total_buffered_bytes);
    }

    for session_index in 0..4 {
        registry
            .remove_session(&format!("session_{session_index}"))
            .unwrap();
    }
    assert_eq!(registry.session_count(), 0);
    assert_eq!(registry.total_buffered_bytes(), 0);
}

#[test]
fn duplicate_stream_open_does_not_consume_capacity_or_corrupt_readiness() {
    let mut registry = EdgeRegistry::new(Limits {
        max_sessions: 1,
        max_streams_per_session: 2,
        ..Limits::default()
    });
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
    assert_eq!(
        registry.open_stream(
            "session_1",
            1,
            StreamKind::VsCodeManagement,
            None,
            1_001_000,
        ),
        Err(EdgeError::DuplicateStream)
    );
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
