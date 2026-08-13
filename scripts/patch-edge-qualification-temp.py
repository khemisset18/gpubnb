from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


edge = Path("services/edge/src/bin/gpubnb-edge.rs")
text = edge.read_text()
text = replace_once(
    text,
    "    time::{SystemTime, UNIX_EPOCH},\n",
    "    time::{Duration, SystemTime, UNIX_EPOCH},\n",
    "duration import",
)
text = replace_once(
    text,
    "use quinn::{crypto::rustls::QuicServerConfig, Endpoint};\n",
    "use quinn::crypto::rustls::QuicServerConfig;\n",
    "quinn import",
)
text = replace_once(
    text,
    """use transport::{
    admission_action, configure_transport, AdmissionAction, RuntimeTransportPolicy,
    CONNECTION_RECEIVE_WINDOW_BYTES, CONNECTION_SEND_WINDOW_BYTES, MAX_BIDI_STREAMS,
    MAX_UNI_STREAMS, STREAM_RECEIVE_WINDOW_BYTES,
};""",
    """use transport::{
    admission_action, bind_server_endpoint, configure_transport, AdmissionAction,
    RuntimeTransportPolicy, CONNECTION_RECEIVE_WINDOW_BYTES, CONNECTION_SEND_WINDOW_BYTES,
    MAX_BIDI_STREAMS, MAX_UNI_STREAMS, PER_CONNECTION_TRANSPORT_BUDGET_BYTES,
    STREAM_RECEIVE_WINDOW_BYTES,
};""",
    "transport imports",
)
text = replace_once(
    text,
    "fn edge_reject_code(error: &EdgeError) -> StreamRejectCode {\n",
    """fn log_connection_transport_metrics(
    connection: &quinn::Connection,
    role: &str,
    session_id: &str,
) {
    let stats = connection.stats();
    info!(
        event = \"edge_connection_transport_metrics\",
        session = %session_id,
        role,
        rtt_ms = stats.path.rtt.as_millis() as u64,
        congestion_window_bytes = stats.path.cwnd,
        congestion_events = stats.path.congestion_events,
        lost_packets = stats.path.lost_packets,
        lost_bytes = stats.path.lost_bytes,
        sent_packets = stats.path.sent_packets,
        black_holes_detected = stats.path.black_holes_detected,
        mtu = stats.path.current_mtu,
        tx_data_blocked = stats.frame_tx.data_blocked,
        tx_stream_data_blocked = stats.frame_tx.stream_data_blocked,
        tx_streams_blocked_bidi = stats.frame_tx.streams_blocked_bidi,
        rx_data_blocked = stats.frame_rx.data_blocked,
        rx_stream_data_blocked = stats.frame_rx.stream_data_blocked,
        \"QUIC connection transport metrics\"
    );
}

fn edge_reject_code(error: &EdgeError) -> StreamRejectCode {
""",
    "transport metrics helper",
)
text = replace_once(
    text,
    """    let close = connection.closed().await;
    let removed = {""",
    """    let close = connection.closed().await;
    log_connection_transport_metrics(&connection, \"HOST\", &session_id);
    let removed = {""",
    "host close metrics",
)
text = replace_once(
    text,
    """                break;
            }
        }
    }
    Ok(())
}

async fn handle_connection(""",
    """                break;
            }
        }
    }
    log_connection_transport_metrics(&connection, \"RENTER\", &binding.session_id);
    Ok(())
}

async fn handle_connection(""",
    "renter close metrics",
)
text = replace_once(
    text,
    """    let endpoint = Endpoint::server(
        load_server_config(&cert_path, &key_path, transport_policy)?,
        bind,
    )
    .context(\"failed to bind QUIC Edge endpoint\")?;""",
    """    let (endpoint, udp_buffers) = bind_server_endpoint(
        load_server_config(&cert_path, &key_path, transport_policy)?,
        bind,
        transport_policy,
    )?;""",
    "endpoint bind",
)
text = replace_once(
    text,
    """        connection_send_window_bytes = CONNECTION_SEND_WINDOW_BYTES,
        \"GPUbnb Edge ready\"""",
    """        connection_send_window_bytes = CONNECTION_SEND_WINDOW_BYTES,
        per_connection_transport_budget_bytes = PER_CONNECTION_TRANSPORT_BUDGET_BYTES,
        transport_memory_budget_bytes = transport_policy.transport_memory_budget_bytes,
        transport_reservation_bytes = transport_policy.transport_reservation_bytes()?,
        udp_buffer_requested_bytes = udp_buffers.requested_bytes,
        udp_receive_buffer_bytes = udp_buffers.receive_bytes,
        udp_send_buffer_bytes = udp_buffers.send_bytes,
        udp_buffer_strict = transport_policy.udp_buffer_strict,
        \"GPUbnb Edge ready\"""",
    "ready transport fields",
)
text = replace_once(
    text,
    """    loop {
        tokio::select! {
            incoming = endpoint.accept() => {""",
    """    let mut metrics_tick = tokio::time::interval(Duration::from_secs(15));
    metrics_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = metrics_tick.tick() => {
                let stats = endpoint.stats();
                let registry_guard = registry.lock().await;
                info!(
                    event = \"edge_metrics\",
                    active_connections = endpoint.open_connections(),
                    active_sessions = registry_guard.session_count(),
                    active_streams = registry_guard.stream_count(),
                    application_buffered_bytes = registry_guard.total_buffered_bytes(),
                    accepted_handshakes = stats.accepted_handshakes,
                    refused_handshakes = stats.refused_handshakes,
                    ignored_handshakes = stats.ignored_handshakes,
                    \"Edge transport/resource snapshot\"
                );
            }
            incoming = endpoint.accept() => {""",
    "periodic metrics",
)
edge.write_text(text)

lib = Path("services/edge/src/lib.rs")
text = lib.read_text()
text = replace_once(
    text,
    """    pub fn total_buffered_bytes(&self) -> usize {
        self.total_buffered_bytes
    }
""",
    """    pub fn total_buffered_bytes(&self) -> usize {
        self.total_buffered_bytes
    }

    pub fn stream_count(&self) -> usize {
        self.sessions.values().map(|session| session.streams.len()).sum()
    }
""",
    "registry stream count",
)
lib.write_text(text)
