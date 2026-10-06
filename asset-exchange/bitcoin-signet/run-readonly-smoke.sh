#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"

BITCOIND="${BITCOIN_BIN_DIR}/bitcoind"
BITCOIN_CLI="${BITCOIN_BIN_DIR}/bitcoin-cli"

ROOT="${RUNNER_TEMP:-/tmp}/gpubnb-bitcoin-signet-${RANDOM}-${RANDOM}"
DATA_DIR="${ROOT}/node"
mkdir -p "${DATA_DIR}"

cleanup() {
  set +e
  "${BITCOIN_CLI}" -signet -datadir="${DATA_DIR}" stop >/dev/null 2>&1 || true
  rm -rf "${ROOT}"
}
trap cleanup EXIT

cat > "${DATA_DIR}/bitcoin.conf" <<'EOF'
signet=1
server=1
disablewallet=1
listen=0
discover=0
dnsseed=1
onlynet=ipv4
maxconnections=8
blocksonly=1
persistmempool=0
dbcache=64

[signet]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
EOF

"${BITCOIND}" -datadir="${DATA_DIR}" -daemonwait

CLI=("${BITCOIN_CLI}" -signet -datadir="${DATA_DIR}")

chain="$("${CLI[@]}" getblockchaininfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain"])')"
if [[ "${chain}" != "signet" ]]; then
  echo "ERROR: expected signet chain, got ${chain}"
  exit 1
fi

genesis="$("${CLI[@]}" getblockhash 0)"
expected_genesis="00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"
if [[ "${genesis}" != "${expected_genesis}" ]]; then
  echo "ERROR: unexpected signet genesis hash"
  exit 1
fi

network_active="$("${CLI[@]}" getnetworkinfo | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["networkactive"] else "no")')"
if [[ "${network_active}" != "yes" ]]; then
  echo "ERROR: signet network unexpectedly inactive"
  exit 1
fi

# Bitcoin Core 31.1 default signet chainparams contain a known signet block
# hash at height 160000. Header sync is sufficient to require that this exact
# block header is present in Core's block index; full block sync to height
# 160000 is intentionally NOT required for this read-only identity gate.
known_header_height=160000
known_header_hash="0000003ca3c99aff040f2563c2ad8f8ec88bd0fd6b8f0895cfaf1ef90353a62c"

deadline="$((SECONDS + 240))"
while (( SECONDS < deadline )); do
  info="$("${CLI[@]}" getblockchaininfo)"
  headers="$(printf '%s' "${info}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["headers"])')"
  blocks="$(printf '%s' "${info}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])')"
  connections="$("${CLI[@]}" getconnectioncount)"

  if (( connections >= 1 && headers >= known_header_height && blocks >= 1 )); then
    break
  fi
  sleep 2
done

info="$("${CLI[@]}" getblockchaininfo)"
headers="$(printf '%s' "${info}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["headers"])')"
blocks="$(printf '%s' "${info}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])')"
connections="$("${CLI[@]}" getconnectioncount)"

if (( connections < 1 )); then
  echo "ERROR: no default signet peers connected"
  exit 1
fi
if (( headers < known_header_height )); then
  echo "ERROR: signet header sync did not reach pinned checkpoint height: ${headers}"
  exit 1
fi
if (( blocks < 1 )); then
  echo "ERROR: no non-genesis signet block was validated"
  exit 1
fi

known_header="$("${CLI[@]}" getblockheader "${known_header_hash}" true)"
read -r observed_header_hash observed_header_height < <(
  printf '%s' "${known_header}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(d["hash"], d["height"])
'
)
if [[ "${observed_header_hash}" != "${known_header_hash}" ]]; then
  echo "ERROR: signet known header hash mismatch"
  exit 1
fi
if [[ "${observed_header_height}" != "${known_header_height}" ]]; then
  echo "ERROR: signet known header height mismatch: expected ${known_header_height}, got ${observed_header_height}"
  exit 1
fi

# No wallet should exist or be loadable from this qualification datadir.
wallet_dir="${DATA_DIR}/signet/wallets"
if [[ -d "${wallet_dir}" ]] && find "${wallet_dir}" -mindepth 1 -print -quit | grep -q .; then
  echo "ERROR: read-only signet qualification unexpectedly created wallet data"
  exit 1
fi

# Shut networking down explicitly after qualification and prove peers drain.
"${CLI[@]}" setnetworkactive false >/dev/null
for _ in $(seq 1 50); do
  [[ "$("${CLI[@]}" getconnectioncount)" == "0" ]] && break
  sleep 0.1
done
if [[ "$("${CLI[@]}" getconnectioncount)" != "0" ]]; then
  echo "ERROR: signet peer connections remained after network deactivation"
  exit 1
fi

echo "Bitcoin Core default signet read-only qualification passed."
echo "chain=${chain}"
echo "genesis=${genesis}"
echo "known_header_height=${known_header_height}"
echo "known_header_hash=${observed_header_hash}"
echo "headers=${headers}"
echo "validated_blocks=${blocks}"
echo "connected_peers_before_shutdown=${connections}"
echo "wallet_enabled=no"
echo "transaction_broadcast=no"
