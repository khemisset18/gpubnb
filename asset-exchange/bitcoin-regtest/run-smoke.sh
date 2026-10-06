#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
BITCOIND="${BITCOIN_BIN_DIR}/bitcoind"
BITCOIN_CLI="${BITCOIN_BIN_DIR}/bitcoin-cli"

test -x "${BITCOIND}"
test -x "${BITCOIN_CLI}"

ROOT="${RUNNER_TEMP:-/tmp}/gpubnb-bitcoin-regtest-${RANDOM}-${RANDOM}"
DATA_DIR="${ROOT}/node"
mkdir -p "${DATA_DIR}"

cleanup() {
  set +e
  "${BITCOIN_CLI}" -regtest -datadir="${DATA_DIR}" stop >/dev/null 2>&1 || true
  rm -rf "${ROOT}"
}
trap cleanup EXIT

cat > "${DATA_DIR}/bitcoin.conf" <<'EOF'
regtest=1
server=1
listen=0
dnsseed=0
discover=0
upnp=0
natpmp=0
txindex=1

[regtest]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
fallbackfee=0.00010000
EOF

"${BITCOIND}" -datadir="${DATA_DIR}" -daemonwait

CLI=("${BITCOIN_CLI}" -regtest -datadir="${DATA_DIR}")

network="$("${CLI[@]}" getblockchaininfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain"])')"
if [[ "${network}" != "regtest" ]]; then
  echo "ERROR: expected regtest, got ${network}"
  exit 1
fi

connections="$("${CLI[@]}" getconnectioncount)"
if [[ "${connections}" != "0" ]]; then
  echo "ERROR: isolated regtest unexpectedly has P2P connections: ${connections}"
  exit 1
fi

"${CLI[@]}" createwallet "ae-ci" false false "" false true >/dev/null
WCLI=("${BITCOIN_CLI}" -regtest -datadir="${DATA_DIR}" -rpcwallet=ae-ci)

mining_address="$("${WCLI[@]}" getnewaddress "mining" bech32)"
"${CLI[@]}" generatetoaddress 101 "${mining_address}" >/dev/null

balance="$("${WCLI[@]}" getbalance)"
python3 - "${balance}" <<'PY'
from decimal import Decimal
import sys
if Decimal(sys.argv[1]) <= 0:
    raise SystemExit("wallet did not receive mature regtest funds")
PY

destination="$("${WCLI[@]}" getnewaddress "destination" bech32)"
txid="$("${WCLI[@]}" sendtoaddress "${destination}" 1.00000000)"

mempool_seen="$("${CLI[@]}" getmempoolentry "${txid}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin) else "no")')"
if [[ "${mempool_seen}" != "yes" ]]; then
  echo "ERROR: transaction not observed in local mempool"
  exit 1
fi

mine_address="$("${WCLI[@]}" getnewaddress "confirm" bech32)"
blockhash="$("${CLI[@]}" generatetoaddress 1 "${mine_address}" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"

confirmations="$("${WCLI[@]}" gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
if (( confirmations < 1 )); then
  echo "ERROR: transaction did not confirm"
  exit 1
fi

height_before="$("${CLI[@]}" getblockcount)"
"${CLI[@]}" invalidateblock "${blockhash}"
height_after_invalidate="$("${CLI[@]}" getblockcount)"
if (( height_after_invalidate != height_before - 1 )); then
  echo "ERROR: invalidateblock did not roll back exactly one block"
  exit 1
fi

reorg_confirmations="$("${WCLI[@]}" gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
if (( reorg_confirmations != 0 )); then
  echo "ERROR: reorged transaction should return to zero confirmations in this harness"
  exit 1
fi

"${CLI[@]}" reconsiderblock "${blockhash}"
height_after_reconsider="$("${CLI[@]}" getblockcount)"
if (( height_after_reconsider != height_before )); then
  echo "ERROR: reconsiderblock did not restore tip"
  exit 1
fi

restored_confirmations="$("${WCLI[@]}" gettransaction "${txid}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["confirmations"])')"
if (( restored_confirmations < 1 )); then
  echo "ERROR: reconsidered block did not restore transaction confirmation"
  exit 1
fi

echo "Bitcoin Core regtest isolation/reorg smoke test passed."
echo "txid=${txid}"
echo "blockhash=${blockhash}"
echo "height=${height_after_reconsider}"
