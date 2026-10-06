#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
WCLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" -rpcwallet=ae-ci)

limit_count="$("${CLI[@]}" getmempoolinfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["limitclustercount"])')"
if [[ "${limit_count}" != "64" ]]; then
  echo "ERROR: expected Bitcoin Core 31.1 default cluster count limit 64, got ${limit_count}"
  exit 1
fi

seed_address="$("${WCLI[@]}" getnewaddress "cluster-limit-seed" bech32)"
root_txid="$("${WCLI[@]}" sendtoaddress "${seed_address}" 1.00000000)"

root_json="$("${CLI[@]}" getrawtransaction "${root_txid}" true)"
read -r prev_vout prev_amount_sats < <(
  ROOT_JSON="${root_json}" TARGET_ADDRESS="${seed_address}" python3 <<'PY'
from decimal import Decimal
import json, os
data=json.loads(os.environ["ROOT_JSON"])
target=os.environ["TARGET_ADDRESS"]
matches=[]
for v in data["vout"]:
    if v["scriptPubKey"].get("address") == target:
        sats=int(Decimal(str(v["value"])) * Decimal(100_000_000))
        matches.append((v["n"], sats))
if len(matches) != 1:
    raise SystemExit(f"expected one root output to target address, found {len(matches)}")
print(matches[0][0], matches[0][1])
PY
)

prev_txid="${root_txid}"
first_txid="${root_txid}"
last_txid="${root_txid}"
fee_sats=1000

make_child() {
  local parent_txid="$1"
  local parent_vout="$2"
  local parent_amount_sats="$3"

  local child_amount_sats="$((parent_amount_sats - fee_sats))"
  if (( child_amount_sats <= 10000 )); then
    echo "ERROR: cluster test output amount became too small"
    exit 1
  fi

  local child_address inputs_json amount_btc outputs_json raw signed complete hex txid decoded observed_sats
  child_address="$("${WCLI[@]}" getnewaddress "cluster-limit-child" bech32)"
  inputs_json="$(printf '[{"txid":"%s","vout":%s,"sequence":4294967293}]' "${parent_txid}" "${parent_vout}")"
  amount_btc="$(
    python3 - "${child_amount_sats}" <<'PY'
from decimal import Decimal
import sys
sats=Decimal(sys.argv[1])
print(f"{sats/Decimal(100_000_000):.8f}")
PY
  )"
  outputs_json="$(printf '{"%s":%s}' "${child_address}" "${amount_btc}")"

  raw="$("${CLI[@]}" -named createrawtransaction     inputs="${inputs_json}"     outputs="${outputs_json}"     locktime=0     replaceable=true     version=2
  )"

  signed="$("${WCLI[@]}" signrawtransactionwithwallet "${raw}")"
  complete="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
  if [[ "${complete}" != "yes" ]]; then
    echo "ERROR: wallet failed to sign cluster child"
    printf '%s\n' "${signed}"
    exit 1
  fi

  hex="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
  txid="$("${CLI[@]}" sendrawtransaction "${hex}")"

  decoded="$("${CLI[@]}" decoderawtransaction "${hex}")"
  read -r observed_vout observed_sats < <(
    TX_JSON="${decoded}" TARGET_ADDRESS="${child_address}" python3 <<'PY'
from decimal import Decimal
import json, os
data=json.loads(os.environ["TX_JSON"])
target=os.environ["TARGET_ADDRESS"]
matches=[]
for v in data["vout"]:
    if v["scriptPubKey"].get("address") == target:
        sats=int(Decimal(str(v["value"])) * Decimal(100_000_000))
        matches.append((v["n"], sats))
if len(matches) != 1:
    raise SystemExit(f"expected one child output to target address, found {len(matches)}")
print(matches[0][0], matches[0][1])
PY
  )

  if [[ "${observed_sats}" != "${child_amount_sats}" ]]; then
    echo "ERROR: child output amount mismatch"
    exit 1
  fi

  printf '%s %s %s\n' "${txid}" "${observed_vout}" "${observed_sats}"
}

# Root counts as transaction #1. Add 63 children to reach the v31 default
# cluster hard cap of 64 transactions.
for index in $(seq 2 64); do
  read -r next_txid next_vout next_amount_sats < <(
    make_child "${prev_txid}" "${prev_vout}" "${prev_amount_sats}"
  )
  prev_txid="${next_txid}"
  prev_vout="${next_vout}"
  prev_amount_sats="${next_amount_sats}"
  last_txid="${next_txid}"
done

cluster_json="$("${CLI[@]}" getmempoolcluster "${first_txid}")"
read -r txcount clusterweight < <(
  CLUSTER_JSON="${cluster_json}" python3 <<'PY'
import json, os
d=json.loads(os.environ["CLUSTER_JSON"])
print(d["txcount"], d["clusterweight"])
PY
)

if [[ "${txcount}" != "64" ]]; then
  echo "ERROR: expected 64 transactions in cluster, got ${txcount}"
  exit 1
fi

# Build transaction #65 but do not broadcast it. It must be rejected by the
# cluster-count policy, not by signing or missing-input errors.
candidate_amount_sats="$((prev_amount_sats - fee_sats))"
candidate_address="$("${WCLI[@]}" getnewaddress "cluster-limit-65th" bech32)"
candidate_inputs="$(printf '[{"txid":"%s","vout":%s,"sequence":4294967293}]' "${prev_txid}" "${prev_vout}")"
candidate_amount_btc="$(
  python3 - "${candidate_amount_sats}" <<'PY'
from decimal import Decimal
import sys
print(f"{Decimal(sys.argv[1])/Decimal(100_000_000):.8f}")
PY
)"
candidate_outputs="$(printf '{"%s":%s}' "${candidate_address}" "${candidate_amount_btc}")"
candidate_raw="$("${CLI[@]}" -named createrawtransaction   inputs="${candidate_inputs}"   outputs="${candidate_outputs}"   locktime=0   replaceable=true   version=2
)"
candidate_signed="$("${WCLI[@]}" signrawtransactionwithwallet "${candidate_raw}")"
candidate_complete="$(printf '%s' "${candidate_signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${candidate_complete}" != "yes" ]]; then
  echo "ERROR: wallet failed to sign cluster-limit candidate"
  exit 1
fi
candidate_hex="$(printf '%s' "${candidate_signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
candidate_test="$("${CLI[@]}" testmempoolaccept "[\"${candidate_hex}\"]")"

read -r candidate_allowed reject_reason < <(
  TEST_JSON="${candidate_test}" python3 <<'PY'
import json, os
r=json.loads(os.environ["TEST_JSON"])[0]
print("yes" if r["allowed"] else "no", r.get("reject-reason",""))
PY
)

if [[ "${candidate_allowed}" != "no" ]]; then
  echo "ERROR: 65th transaction unexpectedly accepted into 64-tx cluster"
  exit 1
fi
if [[ "${reject_reason}" != *cluster* ]]; then
  echo "ERROR: 65th transaction rejected for unexpected reason: ${reject_reason}"
  printf '%s\n' "${candidate_test}"
  exit 1
fi

# Mine the accepted cluster so later tests are not affected by this policy
# fixture and verify all 64 accepted transactions left the mempool.
mine_address="$("${WCLI[@]}" getnewaddress "cluster-limit-mine" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null
if "${CLI[@]}" getmempoolentry "${last_txid}" >/dev/null 2>&1; then
  echo "ERROR: accepted cluster remained in mempool after mining"
  exit 1
fi

echo "Bitcoin Core cluster-limit test passed."
echo "limitclustercount=${limit_count}"
echo "accepted_cluster_txcount=${txcount}"
echo "accepted_clusterweight=${clusterweight}"
echo "rejected_candidate_reason=${reject_reason}"
