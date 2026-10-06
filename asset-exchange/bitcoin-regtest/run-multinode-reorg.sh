#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"

BITCOIND="${BITCOIN_BIN_DIR}/bitcoind"
BITCOIN_CLI="${BITCOIN_BIN_DIR}/bitcoin-cli"
ROOT="${RUNNER_TEMP:-/tmp}/gpubnb-bitcoin-multinode-${RANDOM}-${RANDOM}"
A_DIR="${ROOT}/node-a"
B_DIR="${ROOT}/node-b"
mkdir -p "${A_DIR}" "${B_DIR}"

acli() { "${BITCOIN_CLI}" -regtest -datadir="${A_DIR}" -rpcport=19443 "$@"; }
bcli() { "${BITCOIN_CLI}" -regtest -datadir="${B_DIR}" -rpcport=19543 "$@"; }
awcli() { "${BITCOIN_CLI}" -regtest -datadir="${A_DIR}" -rpcport=19443 -rpcwallet=node-a-wallet "$@"; }
bwcli() { "${BITCOIN_CLI}" -regtest -datadir="${B_DIR}" -rpcport=19543 -rpcwallet=node-b-wallet "$@"; }

cleanup() {
  set +e
  acli stop >/dev/null 2>&1 || true
  bcli stop >/dev/null 2>&1 || true
  rm -rf "${ROOT}"
}
trap cleanup EXIT

cat > "${A_DIR}/bitcoin.conf" <<'EOF'
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
rpcport=19443
bind=127.0.0.1:19444
port=19444
fallbackfee=0.00010000
EOF

cat > "${B_DIR}/bitcoin.conf" <<'EOF'
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
rpcport=19543
bind=127.0.0.1:19544
port=19544
fallbackfee=0.00010000
EOF

"${BITCOIND}" -datadir="${A_DIR}" -daemonwait
"${BITCOIND}" -datadir="${B_DIR}" -daemonwait

[[ "$(acli getblockchaininfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain"])')" == "regtest" ]]
[[ "$(bcli getblockchaininfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain"])')" == "regtest" ]]

acli createwallet "node-a-wallet" false false "" false true >/dev/null
bcli createwallet "node-b-wallet" false false "" false true >/dev/null

a_addr="$(awcli getnewaddress "mine-a" bech32)"
b_addr="$(bwcli getnewaddress "mine-b" bech32)"

acli addnode "127.0.0.1:19544" onetry
for _ in $(seq 1 80); do
  if (( $(acli getconnectioncount) >= 1 && $(bcli getconnectioncount) >= 1 )); then break; fi
  sleep 0.1
done
if (( $(acli getconnectioncount) < 1 || $(bcli getconnectioncount) < 1 )); then
  echo "ERROR: isolated regtest nodes did not connect"
  exit 1
fi

acli getpeerinfo | python3 -c '
import json,sys
for p in json.load(sys.stdin):
    addr=p.get("addr","")
    if not (addr.startswith("127.0.0.1:") or addr.startswith("[::1]:")):
        raise SystemExit(f"non-loopback peer detected: {addr}")
'
bcli getpeerinfo | python3 -c '
import json,sys
for p in json.load(sys.stdin):
    addr=p.get("addr","")
    if not (addr.startswith("127.0.0.1:") or addr.startswith("[::1]:")):
        raise SystemExit(f"non-loopback peer detected: {addr}")
'

acli generatetoaddress 101 "${a_addr}" >/dev/null
for _ in $(seq 1 120); do
  [[ "$(acli getblockcount)" == "$(bcli getblockcount)" ]] && break
  sleep 0.1
done
if [[ "$(acli getblockcount)" != "$(bcli getblockcount)" ]]; then
  echo "ERROR: nodes did not synchronize baseline chain"
  exit 1
fi

peer_id="$(acli getpeerinfo | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
acli -named disconnectnode nodeid="${peer_id}"
for _ in $(seq 1 80); do
  [[ "$(acli getconnectioncount)" == "0" && "$(bcli getconnectioncount)" == "0" ]] && break
  sleep 0.1
done
if [[ "$(acli getconnectioncount)" != "0" || "$(bcli getconnectioncount)" != "0" ]]; then
  echo "ERROR: partition failed"
  exit 1
fi

acli generatetoaddress 2 "${a_addr}" >/dev/null
bcli generatetoaddress 4 "${b_addr}" >/dev/null

a_height="$(acli getblockcount)"
b_height="$(bcli getblockcount)"
a_tip="$(acli getbestblockhash)"
b_tip="$(bcli getbestblockhash)"

if [[ "${a_tip}" == "${b_tip}" || "${a_height}" == "${b_height}" ]]; then
  echo "ERROR: expected divergent tips"
  exit 1
fi

TIP_A="${a_tip}" TIP_B="${b_tip}" HEIGHT_A="${a_height}" HEIGHT_B="${b_height}" node --input-type=module <<'NODE'
import { createTipEvidence, tipEvidenceConsistency } from "./asset-exchange/chain-watchers/src/evidence.mjs";
const now = Date.now();
const a = createTipEvidence({chainId:"bitcoin",networkId:"regtest",sourceId:"node-a",tipHash:process.env.TIP_A,tipHeight:Number(process.env.HEIGHT_A),observedAtUnixMs:now});
const b = createTipEvidence({chainId:"bitcoin",networkId:"regtest",sourceId:"node-b",tipHash:process.env.TIP_B,tipHeight:Number(process.env.HEIGHT_B),observedAtUnixMs:now+1});
const result = tipEvidenceConsistency([a,b]);
if (result !== "UNCERTAIN") throw new Error(`expected UNCERTAIN during partition, got ${result}`);
NODE

acli addnode "127.0.0.1:19544" onetry
for _ in $(seq 1 180); do
  final_a="$(acli getbestblockhash)"
  final_b="$(bcli getbestblockhash)"
  [[ "${final_a}" == "${final_b}" ]] && break
  sleep 0.1
done

final_a="$(acli getbestblockhash)"
final_b="$(bcli getbestblockhash)"
final_height_a="$(acli getblockcount)"
final_height_b="$(bcli getblockcount)"

if [[ "${final_a}" != "${final_b}" || "${final_height_a}" != "${final_height_b}" ]]; then
  echo "ERROR: nodes did not converge after reconnect"
  exit 1
fi
if [[ "${final_a}" != "${b_tip}" ]]; then
  echo "ERROR: shorter fork unexpectedly won"
  exit 1
fi

tips_json="$(acli getchaintips)"
fork_status="$(TIPS_JSON="${tips_json}" TARGET_TIP="${a_tip}" python3 - <<'PY'
import json, os
tips=json.loads(os.environ["TIPS_JSON"])
target=os.environ["TARGET_TIP"]
matches=[x for x in tips if x["hash"] == target]
print(matches[0]["status"] if matches else "missing")
PY
)"
if [[ "${fork_status}" != "valid-fork" && "${fork_status}" != "valid-headers" ]]; then
  echo "ERROR: former node A tip not recognized as valid fork: ${fork_status}"
  exit 1
fi

TIP_A="${final_a}" TIP_B="${final_b}" HEIGHT_A="${final_height_a}" HEIGHT_B="${final_height_b}" node --input-type=module <<'NODE'
import { createTipEvidence, tipEvidenceConsistency } from "./asset-exchange/chain-watchers/src/evidence.mjs";
const now = Date.now();
const a = createTipEvidence({chainId:"bitcoin",networkId:"regtest",sourceId:"node-a",tipHash:process.env.TIP_A,tipHeight:Number(process.env.HEIGHT_A),observedAtUnixMs:now});
const b = createTipEvidence({chainId:"bitcoin",networkId:"regtest",sourceId:"node-b",tipHash:process.env.TIP_B,tipHeight:Number(process.env.HEIGHT_B),observedAtUnixMs:now+1});
const result = tipEvidenceConsistency([a,b]);
if (result !== "CONSISTENT") throw new Error(`expected CONSISTENT after convergence, got ${result}`);
NODE

echo "Bitcoin two-node conflicting-tip/reorg test passed."
echo "partition_tip_a=${a_tip}"
echo "partition_tip_b=${b_tip}"
echo "converged_tip=${final_a}"
echo "converged_height=${final_height_a}"
