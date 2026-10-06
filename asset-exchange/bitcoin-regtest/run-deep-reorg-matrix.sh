#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"

BITCOIND="${BITCOIN_BIN_DIR}/bitcoind"
BITCOIN_CLI="${BITCOIN_BIN_DIR}/bitcoin-cli"
ROOT="${RUNNER_TEMP:-/tmp}/gpubnb-bitcoin-deep-reorg-${RANDOM}-${RANDOM}"
mkdir -p "${ROOT}"

active_nodes=()

stop_node() {
  local datadir="$1"
  local rpcport="$2"
  set +e
  "${BITCOIN_CLI}" -regtest -datadir="${datadir}" -rpcport="${rpcport}" stop >/dev/null 2>&1
  set -e
}

cleanup() {
  set +e
  for entry in "${active_nodes[@]:-}"; do
    IFS='|' read -r datadir rpcport <<<"${entry}"
    "${BITCOIN_CLI}" -regtest -datadir="${datadir}" -rpcport="${rpcport}" stop >/dev/null 2>&1 || true
  done
  rm -rf "${ROOT}"
}
trap cleanup EXIT

write_conf() {
  local dir="$1" rpc_port="$2" p2p_port="$3"
  cat > "${dir}/bitcoin.conf" <<EOF
regtest=1
server=1
listen=1
dnsseed=0
discover=0
upnp=0
natpmp=0
txindex=1

[regtest]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=${rpc_port}
bind=127.0.0.1:${p2p_port}
port=${p2p_port}
fallbackfee=0.00010000
EOF
}

wait_for_connection() {
  local a_dir="$1" a_rpc="$2" b_dir="$3" b_rpc="$4"
  for _ in $(seq 1 100); do
    local ac bc
    ac="$("${BITCOIN_CLI}" -regtest -datadir="${a_dir}" -rpcport="${a_rpc}" getconnectioncount)"
    bc="$("${BITCOIN_CLI}" -regtest -datadir="${b_dir}" -rpcport="${b_rpc}" getconnectioncount)"
    if (( ac >= 1 && bc >= 1 )); then return 0; fi
    sleep 0.1
  done
  return 1
}

wait_for_equal_tip() {
  local a_dir="$1" a_rpc="$2" b_dir="$3" b_rpc="$4"
  for _ in $(seq 1 240); do
    local ah bh
    ah="$("${BITCOIN_CLI}" -regtest -datadir="${a_dir}" -rpcport="${a_rpc}" getbestblockhash)"
    bh="$("${BITCOIN_CLI}" -regtest -datadir="${b_dir}" -rpcport="${b_rpc}" getbestblockhash)"
    if [[ "${ah}" == "${bh}" ]]; then return 0; fi
    sleep 0.1
  done
  return 1
}

assert_tip_state() {
  local expected="$1" tip_a="$2" height_a="$3" tip_b="$4" height_b="$5" source_suffix="$6"
  TIP_A="${tip_a}" TIP_B="${tip_b}" HEIGHT_A="${height_a}" HEIGHT_B="${height_b}" SOURCE_SUFFIX="${source_suffix}" EXPECTED="${expected}"     node --input-type=module <<'NODE'
import { createTipEvidence, tipEvidenceConsistency } from "./asset-exchange/chain-watchers/src/evidence.mjs";
const now = Date.now();
const suffix = process.env.SOURCE_SUFFIX;
const a = createTipEvidence({
  chainId:"bitcoin", networkId:"regtest", sourceId:`deep-a-${suffix}`,
  tipHash:process.env.TIP_A, tipHeight:Number(process.env.HEIGHT_A), observedAtUnixMs:now
});
const b = createTipEvidence({
  chainId:"bitcoin", networkId:"regtest", sourceId:`deep-b-${suffix}`,
  tipHash:process.env.TIP_B, tipHeight:Number(process.env.HEIGHT_B), observedAtUnixMs:now+1
});
const result = tipEvidenceConsistency([a,b]);
if (result !== process.env.EXPECTED) {
  throw new Error(`expected ${process.env.EXPECTED}, got ${result}`);
}
NODE
}

run_scenario() {
  local name="$1" losing_depth="$2" winning_depth="$3" rpc_base="$4"
  local a_rpc="${rpc_base}" a_p2p="$((rpc_base + 1))"
  local b_rpc="$((rpc_base + 10))" b_p2p="$((rpc_base + 11))"
  local dir="${ROOT}/${name}"
  local a_dir="${dir}/node-a"
  local b_dir="${dir}/node-b"
  mkdir -p "${a_dir}" "${b_dir}"

  write_conf "${a_dir}" "${a_rpc}" "${a_p2p}"
  write_conf "${b_dir}" "${b_rpc}" "${b_p2p}"

  "${BITCOIND}" -datadir="${a_dir}" -daemonwait
  "${BITCOIND}" -datadir="${b_dir}" -daemonwait
  active_nodes+=("${a_dir}|${a_rpc}" "${b_dir}|${b_rpc}")

  acli() { "${BITCOIN_CLI}" -regtest -datadir="${a_dir}" -rpcport="${a_rpc}" "$@"; }
  bcli() { "${BITCOIN_CLI}" -regtest -datadir="${b_dir}" -rpcport="${b_rpc}" "$@"; }
  awcli() { "${BITCOIN_CLI}" -regtest -datadir="${a_dir}" -rpcport="${a_rpc}" -rpcwallet=wallet-a "$@"; }
  bwcli() { "${BITCOIN_CLI}" -regtest -datadir="${b_dir}" -rpcport="${b_rpc}" -rpcwallet=wallet-b "$@"; }

  [[ "$(acli getblockchaininfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain"])')" == "regtest" ]]
  [[ "$(bcli getblockchaininfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain"])')" == "regtest" ]]

  acli createwallet "wallet-a" false false "" false true >/dev/null
  bcli createwallet "wallet-b" false false "" false true >/dev/null

  local a_mine b_mine
  a_mine="$(awcli getnewaddress "deep-reorg-a" bech32)"
  b_mine="$(bwcli getnewaddress "deep-reorg-b" bech32)"

  acli addnode "127.0.0.1:${b_p2p}" onetry
  wait_for_connection "${a_dir}" "${a_rpc}" "${b_dir}" "${b_rpc}" || {
    echo "ERROR: ${name}: nodes did not connect"
    exit 1
  }

  for node in a b; do
    if [[ "${node}" == "a" ]]; then
      acli getpeerinfo
    else
      bcli getpeerinfo
    fi | python3 -c '
import json,sys
for peer in json.load(sys.stdin):
    addr=peer.get("addr","")
    if not (addr.startswith("127.0.0.1:") or addr.startswith("[::1]:")):
        raise SystemExit(f"non-loopback peer detected: {addr}")
'
  done

  # Establish a common mature chain so the losing-branch transaction spends
  # an output that remains valid after the later reorg.
  acli generatetoaddress 101 "${a_mine}" >/dev/null
  wait_for_equal_tip "${a_dir}" "${a_rpc}" "${b_dir}" "${b_rpc}" || {
    echo "ERROR: ${name}: baseline tips did not synchronize"
    exit 1
  }

  local peer_id
  peer_id="$(acli getpeerinfo | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
  acli -named disconnectnode nodeid="${peer_id}"
  for _ in $(seq 1 100); do
    [[ "$(acli getconnectioncount)" == "0" && "$(bcli getconnectioncount)" == "0" ]] && break
    sleep 0.1
  done
  if [[ "$(acli getconnectioncount)" != "0" || "$(bcli getconnectioncount)" != "0" ]]; then
    echo "ERROR: ${name}: partition failed"
    exit 1
  fi

  local destination txid raw
  destination="$(awcli getnewaddress "deep-reorg-losing-tx" bech32)"
  txid="$(awcli sendtoaddress "${destination}" 1.00000000)"
  raw="$(acli getrawtransaction "${txid}")"

  acli generatetoaddress "${losing_depth}" "${a_mine}" >/dev/null
  local before_conf
  before_conf="$(awcli gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
  if (( before_conf < losing_depth )); then
    echo "ERROR: ${name}: expected at least ${losing_depth} confirmations, got ${before_conf}"
    exit 1
  fi

  bcli generatetoaddress "${winning_depth}" "${b_mine}" >/dev/null

  local a_tip b_tip a_height b_height
  a_tip="$(acli getbestblockhash)"
  b_tip="$(bcli getbestblockhash)"
  a_height="$(acli getblockcount)"
  b_height="$(bcli getblockcount)"

  if [[ "${a_tip}" == "${b_tip}" || "${b_height}" -le "${a_height}" ]]; then
    echo "ERROR: ${name}: expected heavier divergent B chain"
    exit 1
  fi
  assert_tip_state "UNCERTAIN" "${a_tip}" "${a_height}" "${b_tip}" "${b_height}" "${name}"

  acli addnode "127.0.0.1:${b_p2p}" onetry
  wait_for_equal_tip "${a_dir}" "${a_rpc}" "${b_dir}" "${b_rpc}" || {
    echo "ERROR: ${name}: tips did not converge after reconnect"
    exit 1
  }

  local final_a final_b final_height_a final_height_b
  final_a="$(acli getbestblockhash)"
  final_b="$(bcli getbestblockhash)"
  final_height_a="$(acli getblockcount)"
  final_height_b="$(bcli getblockcount)"
  if [[ "${final_a}" != "${b_tip}" || "${final_b}" != "${b_tip}" ]]; then
    echo "ERROR: ${name}: heavier B branch did not win"
    exit 1
  fi
  assert_tip_state "CONSISTENT" "${final_a}" "${final_height_a}" "${final_b}" "${final_height_b}" "${name}"

  local after_conf
  after_conf="$(awcli gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
  if (( after_conf != 0 )); then
    echo "ERROR: ${name}: losing-branch tx should return to zero confirmations, got ${after_conf}"
    exit 1
  fi
  acli getmempoolentry "${txid}" >/dev/null

  local rebroadcast_path rebroadcast_txid
  if bcli getmempoolentry "${txid}" >/dev/null 2>&1; then
    rebroadcast_path="already-relayed"
    rebroadcast_txid="${txid}"
  else
    local accept
    accept="$(bcli testmempoolaccept "[\"${raw}\"]")"
    if [[ "$(printf '%s' "${accept}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')" != "yes" ]]; then
      echo "ERROR: ${name}: exact losing-branch tx rejected on winning chain"
      printf '%s\n' "${accept}"
      exit 1
    fi
    rebroadcast_txid="$(bcli sendrawtransaction "${raw}")"
    rebroadcast_path="explicit-rebroadcast"
  fi

  if [[ "${rebroadcast_txid}" != "${txid}" ]]; then
    echo "ERROR: ${name}: rebroadcast changed transaction identity"
    exit 1
  fi

  bcli generatetoaddress 1 "${b_mine}" >/dev/null
  for _ in $(seq 1 120); do
    local reconf
    reconf="$(awcli gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
    (( reconf >= 1 )) && break
    sleep 0.1
  done
  local reconf
  reconf="$(awcli gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
  if (( reconf < 1 )); then
    echo "ERROR: ${name}: transaction did not reconfirm on winning chain"
    exit 1
  fi

  local former_tip_status
  former_tip_status="$(acli getchaintips | python3 -c '
import json,sys
target=sys.argv[1]
matches=[x for x in json.load(sys.stdin) if x["hash"] == target]
print(matches[0]["status"] if matches else "missing")
' "${a_tip}")"
  if [[ "${former_tip_status}" != "valid-fork" && "${former_tip_status}" != "valid-headers" ]]; then
    echo "ERROR: ${name}: former losing tip status unexpected: ${former_tip_status}"
    exit 1
  fi

  echo "DEEP_REORG scenario=${name} losing_depth=${losing_depth} winning_depth=${winning_depth} confirmations_before=${before_conf} confirmations_after=${after_conf} reconfirmed=${reconf} rebroadcast_path=${rebroadcast_path} txid=${txid}"

  stop_node "${a_dir}" "${a_rpc}"
  stop_node "${b_dir}" "${b_rpc}"

  local next=()
  for entry in "${active_nodes[@]}"; do
    [[ "${entry}" == "${a_dir}|${a_rpc}" || "${entry}" == "${b_dir}|${b_rpc}" ]] || next+=("${entry}")
  done
  active_nodes=("${next[@]}")
}

run_scenario "three-vs-six" 3 6 19643
run_scenario "twentyfour-vs-twentyfive" 24 25 19743

echo "Bitcoin deep reorg matrix passed."
