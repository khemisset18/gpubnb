#!/usr/bin/env bash
set -Eeuo pipefail

EVIDENCE="${GITHUB_WORKSPACE:-$PWD}/qualification-evidence"
TMP="$(mktemp -d)"
mkdir -p "$TMP/replay" "$EVIDENCE"

EDGE_PID=''
HOST_PID=''
ECHO_PID=''
SLOW_PID=''
HOLD_PIDS=()
EDGE_LOG="$EVIDENCE/abuse-edge.log"
HOST_LOG="$EVIDENCE/abuse-host.log"

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
  echo "$label exceeded shutdown grace; sending SIGKILL" >>"$EVIDENCE/abuse-cleanup.log"
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  set +e
  for pid in "${HOLD_PIDS[@]:-}"; do
    stop_pid_bounded "$pid" "abuse-hold-preauth" 20
  done
  stop_pid_bounded "$SLOW_PID" "abuse-slow-client" 20
  stop_pid_bounded "$HOST_PID" "abuse-host" 30
  stop_pid_bounded "$ECHO_PID" "abuse-echo" 20
  stop_pid_bounded "$EDGE_PID" "abuse-edge" 50
  rm -rf "$TMP"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT

client() {
  timeout --signal=TERM --kill-after=5s 45s \
    services/edge/target/debug/examples/e2e_client \
    127.0.0.1:4435 "$TMP/ca-cert.pem" "$@"
}

start_hold_client() {
  local index="$1"
  timeout --signal=TERM --kill-after=3s 14s \
    services/edge/target/debug/examples/e2e_client \
    127.0.0.1:4435 "$TMP/ca-cert.pem" hold-preauth 10000 \
    >"$EVIDENCE/abuse-hold-$index.log" 2>&1 &
  HOLD_PIDS+=("$!")
}

wait_hold_connected() {
  local index="$1"
  for _ in $(seq 1 80); do
    grep -q 'preauth-connected' "$EVIDENCE/abuse-hold-$index.log" && return 0
    sleep 0.1
  done
  cat "$EVIDENCE/abuse-hold-$index.log"
  echo "pre-auth client $index did not establish within qualification bound"
  return 1
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

start_edge() {
  : >"$EDGE_LOG"
  services/edge/target/debug/gpubnb-edge >"$EDGE_LOG" 2>&1 &
  EDGE_PID=$!
  for _ in $(seq 1 80); do
    grep -q 'edge_ready' "$EDGE_LOG" && return 0
    if ! kill -0 "$EDGE_PID" 2>/dev/null; then
      cat "$EDGE_LOG"
      return 1
    fi
    sleep 0.1
  done
  echo 'abuse Edge readiness timeout'
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
  echo 'abuse Edge drain exceeded 5 second bound'
  return 1
}

command -v timeout >/dev/null
command -v openssl >/dev/null

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$TMP/ca-key.pem" -out "$TMP/ca-cert.pem" \
  -subj '/CN=GPUbnb Abuse Qualification Root' \
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

timeout --signal=TERM --kill-after=5s 20s bash -c \
  'cd apps/api && npx tsx test/data-plane-e2e-authority.ts "$1"' _ "$TMP"

export GPUBNB_EDGE_BIND='127.0.0.1:4435'
export GPUBNB_EDGE_TLS_CERT="$TMP/tls-cert.pem"
export GPUBNB_EDGE_TLS_KEY="$TMP/tls-key.pem"
export GPUBNB_EDGE_ID='edge_e2e_1'
export GPUBNB_EDGE_REPLAY_DIR="$TMP/replay"
export GPUBNB_EDGE_AUTHORITY_PUBLIC_KEY_HEX="$(tr -d '\n' < "$TMP/authority-public.hex")"
export GPUBNB_EDGE_IDLE_TIMEOUT_MS='30000'
export GPUBNB_EDGE_MAX_CONNECTIONS='16'
export GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB='256'
export GPUBNB_EDGE_UDP_BUFFER_BYTES='4194304'
export GPUBNB_EDGE_UDP_BUFFER_STRICT='true'

python3 -u - <<'PY' >"$EVIDENCE/abuse-slow-echo.log" 2>&1 &
import socketserver
import time

READ_CHUNK = 4096
READ_DELAY = 0.005
WRITE_CHUNK = 1024
WRITE_DELAY = 0.001

class SlowEcho(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data = self.request.recv(READ_CHUNK)
            if not data:
                return
            time.sleep(READ_DELAY)
            for offset in range(0, len(data), WRITE_CHUNK):
                self.request.sendall(data[offset:offset + WRITE_CHUNK])
                time.sleep(WRITE_DELAY)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", 39003), SlowEcho) as server:
    print("slow-echo-ready", flush=True)
    server.serve_forever()
PY
ECHO_PID=$!
for _ in $(seq 1 50); do
  grep -q 'slow-echo-ready' "$EVIDENCE/abuse-slow-echo.log" && break
  kill -0 "$ECHO_PID" 2>/dev/null || { cat "$EVIDENCE/abuse-slow-echo.log"; exit 1; }
  sleep 0.1
done
grep -q 'slow-echo-ready' "$EVIDENCE/abuse-slow-echo.log"

start_edge
export GPUBNB_HOST_EDGE_ADDR='127.0.0.1:4435'
export GPUBNB_HOST_EDGE_SERVER_NAME='localhost'
export GPUBNB_HOST_EDGE_CA_CERT="$TMP/ca-cert.pem"
export GPUBNB_HOST_AUTHORITY="$TMP/authority-host.json"
export GPUBNB_HOST_WORKSPACE_PORT='39003'
services/edge/target/debug/gpubnb-host-tunnel >"$HOST_LOG" 2>&1 &
HOST_PID=$!
for _ in $(seq 1 80); do
  grep -q 'host_tunnel_ready' "$HOST_LOG" && break
  kill -0 "$HOST_PID" 2>/dev/null || { cat "$HOST_LOG"; exit 1; }
  sleep 0.1
done
grep -q 'host_tunnel_ready' "$HOST_LOG"
grep -q 'max_incoming_bidi_streams=74' "$HOST_LOG"

client route-large "$TMP/authority-renter-large.json" >"$EVIDENCE/abuse-slow-io-client.log" 2>&1 &
SLOW_PID=$!
sleep 1
if ! kill -0 "$SLOW_PID" 2>/dev/null; then
  cat "$EVIDENCE/abuse-slow-io-client.log"
  wait "$SLOW_PID"
  exit 1
fi
assert_rss_below 'rss_slow_reader_writer_kib' 524288
wait "$SLOW_PID"
SLOW_PID=''
grep -q 'edge_connection_transport_metrics' "$EDGE_LOG"
stop_pid_bounded "$HOST_PID" "abuse-host" 30
HOST_PID=''
stop_edge

export GPUBNB_EDGE_MAX_CONNECTIONS='8'
start_edge
grep -q 'retry_threshold=6' "$EDGE_LOG"

# Establish exactly six live pre-auth connections first. The next fresh remote
# address is therefore evaluated at the 75% pressure threshold instead of
# racing with seven other simultaneous Incoming decisions.
for index in $(seq 1 6); do
  start_hold_client "$index"
  wait_hold_connected "$index"
done

# The seventh connection must be challenged with QUIC Retry and then still
# complete successfully after Quinn validates the source address.
start_hold_client 7
wait_hold_connected 7
grep -q 'edge_address_retry_required' "$EDGE_LOG"

# Keep pressure above the threshold and prove a second challenged connection can
# also establish without growing state beyond the declared cap.
start_hold_client 8
wait_hold_connected 8
grep -q 'edge_address_retry_required' "$EDGE_LOG"

client expect-capacity-reject
grep -q 'edge_connection_refused_capacity' "$EDGE_LOG"
assert_rss_below 'rss_address_validation_flood_kib' 524288
for pid in "${HOLD_PIDS[@]}"; do
  wait "$pid"
done
HOLD_PIDS=()
stop_edge

{
  echo "abuse_qualification_sha=${GITHUB_SHA:-unknown}"
  echo 'slow_reader=target_4096_bytes_then_5ms_pause'
  echo 'slow_writer=target_1024_bytes_then_1ms_pause'
  echo 'slow_io_payload_bytes=1048576'
  echo 'slow_io_integrity=byte_identical'
  echo 'slow_io_rss_bound_kib=524288'
  echo 'address_validation_retry_threshold_connections=6'
  echo 'address_validation_retry_observed=true'
  echo 'address_validation_post_retry_connections=8'
  echo 'hard_capacity_ninth_connection_refused=true'
  echo 'address_validation_rss_bound_kib=524288'
} >"$EVIDENCE/abuse-qualification.txt"
