#!/usr/bin/env bash
set -Eeuo pipefail

EVIDENCE="${GITHUB_WORKSPACE:-$PWD}/qualification-evidence"
TMP="$(mktemp -d)"
mkdir -p "$TMP/replay" "$EVIDENCE"

EDGE_PID=''
HOST_PID=''
ECHO_PID=''
PRESSURE_PID=''
DRAIN_PID=''
EDGE_RUN=0
EDGE_LOG=''
NETEM_ACTIVE=0
HOLD_PIDS=()

phase() {
  printf '%s phase=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$EVIDENCE/phases.log"
}

stop_pid_bounded() {
  local pid="${1:-}"
  local label="${2:-process}"
  local grace_ticks="${3:-50}"
  [[ -z "$pid" ]] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$grace_ticks"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  echo "$label did not stop within bounded grace; sending SIGKILL" | tee -a "$EVIDENCE/cleanup.log"
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  set +e
  phase "cleanup_status_${status}"
  if (( NETEM_ACTIVE == 1 )); then
    sudo tc qdisc del dev lo root 2>/dev/null || true
  fi
  for pid in "${HOLD_PIDS[@]:-}"; do
    stop_pid_bounded "$pid" "hold-preauth" 20
  done
  stop_pid_bounded "$PRESSURE_PID" "stream-pressure" 20
  stop_pid_bounded "$DRAIN_PID" "drain-client" 20
  stop_pid_bounded "$HOST_PID" "host-tunnel" 30
  stop_pid_bounded "$ECHO_PID" "echo-server" 20
  stop_pid_bounded "$EDGE_PID" "edge" 50
  {
    echo "qualification_sha=${GITHUB_SHA:-unknown}"
    echo "status=$status"
    echo "kernel=$(uname -srmo)"
    echo "tc=$(tc -V 2>&1 || true)"
    echo "rmem_max=$(sysctl -n net.core.rmem_max 2>/dev/null || true)"
    echo "wmem_max=$(sysctl -n net.core.wmem_max 2>/dev/null || true)"
  } >"$EVIDENCE/environment.txt"
  rm -rf "$TMP"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT

command -v timeout >/dev/null
command -v tc >/dev/null
command -v openssl >/dev/null
phase prerequisites
sudo sysctl -w net.core.rmem_max=33554432 >/dev/null
sudo sysctl -w net.core.wmem_max=33554432 >/dev/null

phase tls_fixtures
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$TMP/ca-key.pem" -out "$TMP/ca-cert.pem" \
  -subj '/CN=GPUbnb Qualification Root' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$TMP/tls-key.pem" -out "$TMP/tls.csr" \
  -subj '/CN=localhost' >/dev/null 2>&1
cat >"$TMP/tls.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost
EOF
openssl x509 -req -in "$TMP/tls.csr" \
  -CA "$TMP/ca-cert.pem" -CAkey "$TMP/ca-key.pem" -CAcreateserial \
  -days 1 -sha256 -extfile "$TMP/tls.ext" -out "$TMP/tls-cert.pem" >/dev/null 2>&1

phase authority_fixtures
timeout --signal=TERM --kill-after=5s 20s bash -c 'cd apps/api && npx tsx test/data-plane-e2e-authority.ts "$1"' _ "$TMP"

export GPUBNB_EDGE_BIND='127.0.0.1:4434'
export GPUBNB_EDGE_TLS_CERT="$TMP/tls-cert.pem"
export GPUBNB_EDGE_TLS_KEY="$TMP/tls-key.pem"
export GPUBNB_EDGE_ID='edge_e2e_1'
export GPUBNB_EDGE_REPLAY_DIR="$TMP/replay"
export GPUBNB_EDGE_AUTHORITY_PUBLIC_KEY_HEX="$(tr -d '\n' < "$TMP/authority-public.hex")"
# #104 separately proves aggressive 5-second idle reclamation. This production
# qualification uses a 30-second idle policy so the Host's 15-second QUIC
# keepalive is exercised while 64 routed streams are established under load.
export GPUBNB_EDGE_IDLE_TIMEOUT_MS='30000'
export GPUBNB_EDGE_MAX_CONNECTIONS='16'
export GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB='256'
export GPUBNB_EDGE_UDP_BUFFER_BYTES='4194304'
export GPUBNB_EDGE_UDP_BUFFER_STRICT='true'

start_edge() {
  EDGE_RUN=$((EDGE_RUN + 1))
  EDGE_LOG="$EVIDENCE/edge-$EDGE_RUN.log"
  services/edge/target/debug/gpubnb-edge >"$EDGE_LOG" 2>&1 &
  EDGE_PID=$!
  for _ in $(seq 1 80); do
    grep -q 'edge_ready' "$EDGE_LOG" && return 0
    if ! kill -0 "$EDGE_PID" 2>/dev/null; then
      echo 'Edge exited before readiness'
      cat "$EDGE_LOG"
      return 1
    fi
    sleep 0.1
  done
  echo 'Edge readiness timeout'
  cat "$EDGE_LOG"
  return 1
}

stop_edge() {
  local pid="$EDGE_PID"
  kill -INT "$pid"
  for _ in $(seq 1 50); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      EDGE_PID=''
      return 0
    fi
    sleep 0.1
  done
  echo 'Edge drain exceeded 5 second qualification bound'
  return 1
}

client() {
  timeout --signal=TERM --kill-after=5s 45s \
    services/edge/target/debug/examples/e2e_client \
    127.0.0.1:4434 "$TMP/ca-cert.pem" "$@"
}

edge_rss_kib() {
  awk '/^VmRSS:/ {print $2}' "/proc/$EDGE_PID/status"
}

assert_rss_below() {
  local label="$1"
  local limit_kib="$2"
  local rss
  rss="$(edge_rss_kib)"
  echo "$label=$rss" >>"$EVIDENCE/rss-kib.txt"
  if [[ -z "$rss" || "$rss" -ge "$limit_kib" ]]; then
    echo "Edge RSS $rss KiB exceeded $label bound $limit_kib KiB"
    return 1
  fi
}

phase echo_server
python3 -u - <<'PY' >"$EVIDENCE/echo.log" 2>&1 &
import socketserver

class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data = self.request.recv(65536)
            if not data:
                return
            self.request.sendall(data)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", 39002), Echo) as server:
    print("echo-ready", flush=True)
    server.serve_forever()
PY
ECHO_PID=$!
for _ in $(seq 1 50); do
  grep -q 'echo-ready' "$EVIDENCE/echo.log" && break
  kill -0 "$ECHO_PID" 2>/dev/null || { cat "$EVIDENCE/echo.log"; exit 1; }
  sleep 0.1
done
grep -q 'echo-ready' "$EVIDENCE/echo.log"

phase edge_baseline
start_edge
grep -q 'max_connections=16' "$EDGE_LOG"
grep -q 'idle_timeout_ms=30000' "$EDGE_LOG"
grep -q 'max_bidi_streams=75' "$EDGE_LOG"
grep -q 'transport_memory_budget_bytes=268435456' "$EDGE_LOG"
grep -q 'transport_reservation_bytes=268435456' "$EDGE_LOG"
grep -q 'udp_buffer_requested_bytes=4194304' "$EDGE_LOG"
grep -q 'udp_receive_buffer_bytes=' "$EDGE_LOG"
grep -q 'udp_send_buffer_bytes=' "$EDGE_LOG"

export GPUBNB_HOST_EDGE_ADDR='127.0.0.1:4434'
export GPUBNB_HOST_EDGE_SERVER_NAME='localhost'
export GPUBNB_HOST_EDGE_CA_CERT="$TMP/ca-cert.pem"
export GPUBNB_HOST_AUTHORITY="$TMP/authority-host.json"
export GPUBNB_HOST_WORKSPACE_PORT='39002'
phase host_tunnel
services/edge/target/debug/gpubnb-host-tunnel >"$EVIDENCE/host.log" 2>&1 &
HOST_PID=$!
for _ in $(seq 1 80); do
  grep -q 'host_tunnel_ready' "$EVIDENCE/host.log" && break
  kill -0 "$HOST_PID" 2>/dev/null || { cat "$EVIDENCE/host.log"; exit 1; }
  sleep 0.1
done
grep -q 'host_tunnel_ready' "$EVIDENCE/host.log"
grep -q 'edge_host_tunnel_ready' "$EDGE_LOG"

phase stream_pressure_start
timeout --signal=TERM --kill-after=5s 20s \
  services/edge/target/debug/examples/e2e_client \
  127.0.0.1:4434 "$TMP/ca-cert.pem" stream-pressure "$TMP/authority-renter-pressure.json" \
  >"$EVIDENCE/stream-pressure.log" 2>&1 &
PRESSURE_PID=$!
for _ in $(seq 1 150); do
  grep -q 'pressure-ready' "$EVIDENCE/stream-pressure.log" && break
  kill -0 "$PRESSURE_PID" 2>/dev/null || { cat "$EVIDENCE/stream-pressure.log"; exit 1; }
  sleep 0.1
done
grep -q 'pressure-ready' "$EVIDENCE/stream-pressure.log"
assert_rss_below 'rss_stream_pressure_kib' 524288
wait "$PRESSURE_PID"
PRESSURE_PID=''
phase stream_pressure_done

phase netem_transfer_start
sudo tc qdisc replace dev lo root netem delay 20ms 5ms loss 1% reorder 5% 50%
NETEM_ACTIVE=1
tc qdisc show dev lo >"$EVIDENCE/netem.txt"
client route-large "$TMP/authority-renter-large.json"
sudo tc qdisc del dev lo root
NETEM_ACTIVE=0
grep -q 'edge_connection_transport_metrics' "$EDGE_LOG"
phase netem_transfer_done

phase baseline_shutdown
stop_pid_bounded "$HOST_PID" "host-tunnel" 30
HOST_PID=''
stop_edge

phase connection_flood_start
export GPUBNB_EDGE_MAX_CONNECTIONS='8'
export GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB='256'
start_edge
for index in $(seq 1 8); do
  timeout --signal=TERM --kill-after=3s 12s \
    services/edge/target/debug/examples/e2e_client \
    127.0.0.1:4434 "$TMP/ca-cert.pem" hold-preauth 8000 \
    >"$EVIDENCE/hold-$index.log" 2>&1 &
  HOLD_PIDS+=("$!")
done
for index in $(seq 1 8); do
  for _ in $(seq 1 80); do
    grep -q 'preauth-connected' "$EVIDENCE/hold-$index.log" && break
    sleep 0.1
  done
  grep -q 'preauth-connected' "$EVIDENCE/hold-$index.log"
done
client expect-capacity-reject
grep -q 'edge_connection_refused_capacity' "$EDGE_LOG"
assert_rss_below 'rss_connection_flood_kib' 524288
for pid in "${HOLD_PIDS[@]}"; do
  wait "$pid"
done
HOLD_PIDS=()
stop_edge
phase connection_flood_done

phase corrupt_replay_start
corrupt_nonce="$(node -e "const a=require(process.argv[1]); process.stdout.write(a.binding.nonce)" "$TMP/authority-renter-corrupt.json")"
printf 'partial\n' >"$TMP/replay/$corrupt_nonce"
export GPUBNB_EDGE_MAX_CONNECTIONS='16'
start_edge
grep -Eq 'replay_store_quarantined=[1-9][0-9]*' "$EDGE_LOG"
client expect-reject "$TMP/authority-renter-corrupt.json"
grep -q 'edge_authority_replay_rejected' "$EDGE_LOG"
phase corrupt_replay_done

phase drain_start
timeout --signal=TERM --kill-after=3s 12s \
  services/edge/target/debug/examples/e2e_client \
  127.0.0.1:4434 "$TMP/ca-cert.pem" hold-preauth 8000 \
  >"$EVIDENCE/drain-client.log" 2>&1 &
DRAIN_PID=$!
for _ in $(seq 1 50); do
  grep -q 'preauth-connected' "$EVIDENCE/drain-client.log" && break
  sleep 0.1
done
grep -q 'preauth-connected' "$EVIDENCE/drain-client.log"
stop_edge
grep -q 'edge_draining' "$EDGE_LOG"
stop_pid_bounded "$DRAIN_PID" "drain-client" 20
DRAIN_PID=''
phase drain_done

{
  echo "qualified_sha=${GITHUB_SHA:-unknown}"
  echo 'transport=quic'
  echo 'idle_timeout_ms=30000'
  echo 'host_keepalive_interval_ms=15000'
  echo 'remote_bidi_streams=75'
  echo 'application_bidi_streams=64'
  echo 'control_bidi_stream_reserve=1'
  echo 'stream_credit_replenishment_reserve=10'
  echo 'max_uni_streams=0'
  echo 'stream_receive_window_bytes=2097152'
  echo 'connection_receive_window_bytes=8388608'
  echo 'connection_send_window_bytes=8388608'
  echo 'per_connection_transport_budget_bytes=16777216'
  echo 'qualified_connection_cap=16'
  echo 'qualified_transport_memory_budget_bytes=268435456'
  echo 'udp_buffer_target_bytes=4194304'
  echo 'network_chaos=delay20ms_jitter5ms_loss1pct_reorder5pct'
  echo 'stream_pressure=64_application_streams_then_explicit_65th_reject_then_10_churn_rotations'
  echo 'connection_flood=8_open_then_9th_refused'
  echo 'replay_corrupt_store=quarantined_and_rejected'
  echo 'drain_bound_seconds=5'
} >"$EVIDENCE/qualification.txt"

grep -hE 'event=("?edge_(ready|connection_refused_capacity|address_retry_required|authority_replay_rejected|connection_transport_metrics|draining)"?)' \
  "$EVIDENCE"/edge-*.log >"$EVIDENCE/security-events.txt" || true
phase qualification_complete
