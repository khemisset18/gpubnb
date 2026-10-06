#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
WCLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" -rpcwallet=ae-ci)

limit_vbytes="$("${CLI[@]}" getmempoolinfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["limitclustersize"])')"
if [[ "${limit_vbytes}" != "101000" ]]; then
  echo "ERROR: expected Bitcoin Core 31.1 default cluster size limit 101000 vbytes, got ${limit_vbytes}"
  exit 1
fi

root_address="$("${WCLI[@]}" getnewaddress "cluster-size-root" bech32)"
root_txid="$("${WCLI[@]}" sendtoaddress "${root_address}" 1.00000000)"
root_json="$("${CLI[@]}" getrawtransaction "${root_txid}" true)"

read -r prev_vout prev_amount_sats < <(
  ROOT_JSON="${root_json}" TARGET_ADDRESS="${root_address}" python3 <<'PY'
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
    raise SystemExit(f"expected one root output, found {len(matches)}")
print(matches[0][0], matches[0][1])
PY
)

prev_txid="${root_txid}"
first_txid="${root_txid}"
fee_sats=50000
decoy_sats=1000
decoy_count=1200

make_decoy_outputs() {
  local start_index="$1"
  local continuation_address="$2"
  local continuation_sats="$3"
  python3 - "${start_index}" "${decoy_count}" "${decoy_sats}" "${continuation_address}" "${continuation_sats}" <<'PY'
import hashlib, json, sys

ALPHABET="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58encode(raw: bytes) -> str:
    n=int.from_bytes(raw, "big")
    chars=[]
    while n:
        n, rem=divmod(n, 58)
        chars.append(ALPHABET[rem])
    prefix=0
    for b in raw:
        if b != 0:
            break
        prefix += 1
    return "1"*prefix + "".join(reversed(chars or ["1"]))

def regtest_p2pkh(index: int) -> str:
    # Deterministic 20-byte payload; no spend key exists or is needed.
    payload=hashlib.sha256(f"gpubnb-cluster-size-{index}".encode()).digest()[:20]
    body=b"\x6f" + payload
    checksum=hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    return b58encode(body+checksum)

start=int(sys.argv[1])
count=int(sys.argv[2])
decoy_sats=int(sys.argv[3])
continuation_address=sys.argv[4]
continuation_sats=int(sys.argv[5])

outputs=[]
for i in range(start, start+count):
    outputs.append({regtest_p2pkh(i): f"{decoy_sats/100_000_000:.8f}"})
outputs.append({continuation_address: f"{continuation_sats/100_000_000:.8f}"})
print(json.dumps(outputs, separators=(",",":")))
PY
}

build_large_child() {
  local parent_txid="$1"
  local parent_vout="$2"
  local parent_amount_sats="$3"
  local start_index="$4"

  local continuation_sats="$((parent_amount_sats - decoy_count * decoy_sats - fee_sats))"
  if (( continuation_sats <= 1000000 )); then
    echo "ERROR: continuation output became too small"
    exit 1
  fi

  local continuation_address inputs_json outputs_json raw signed complete hex txid decoded observed_vout observed_sats vsize
  continuation_address="$("${WCLI[@]}" getnewaddress "cluster-size-continuation" bech32)"
  inputs_json="$(printf '[{"txid":"%s","vout":%s,"sequence":4294967293}]' "${parent_txid}" "${parent_vout}")"
  outputs_json="$(make_decoy_outputs "${start_index}" "${continuation_address}" "${continuation_sats}")"

  raw="$("${CLI[@]}" -named createrawtransaction     inputs="${inputs_json}"     outputs="${outputs_json}"     locktime=0     replaceable=true     version=2
  )"
  signed="$("${WCLI[@]}" signrawtransactionwithwallet "${raw}")"
  complete="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
  if [[ "${complete}" != "yes" ]]; then
    echo "ERROR: wallet failed to sign cluster-size child"
    exit 1
  fi
  hex="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
  decoded="$("${CLI[@]}" decoderawtransaction "${hex}")"
  vsize="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["vsize"])')"

  read -r observed_vout observed_sats < <(
    printf '%s' "${decoded}" | python3 -c '
from decimal import Decimal
import json, sys
data=json.load(sys.stdin)
target=sys.argv[1]
matches=[]
for v in data["vout"]:
    if v["scriptPubKey"].get("address") == target:
        sats=int(Decimal(str(v["value"])) * Decimal(100_000_000))
        matches.append((v["n"], sats))
if len(matches) != 1:
    raise SystemExit(f"expected one continuation output, found {len(matches)}")
print(matches[0][0], matches[0][1])
' "${continuation_address}"
  )

  if [[ "${observed_sats}" != "${continuation_sats}" ]]; then
    echo "ERROR: continuation amount mismatch"
    exit 1
  fi

  printf '%s %s %s %s %s\n' "${hex}" "${observed_vout}" "${observed_sats}" "${vsize}" "${continuation_address}"
}

# Build two large accepted descendants. Each remains well below the standard
# single-transaction size limit, while the third would push the connected
# cluster beyond the 101 kvB default.
read -r child1_hex child1_vout child1_amount child1_vsize _ < <(
  build_large_child "${prev_txid}" "${prev_vout}" "${prev_amount_sats}" 0
)
child1_txid="$("${CLI[@]}" sendrawtransaction "${child1_hex}")"
prev_txid="${child1_txid}"
prev_vout="${child1_vout}"
prev_amount_sats="${child1_amount}"

read -r child2_hex child2_vout child2_amount child2_vsize _ < <(
  build_large_child "${prev_txid}" "${prev_vout}" "${prev_amount_sats}" 2000
)
child2_txid="$("${CLI[@]}" sendrawtransaction "${child2_hex}")"
prev_txid="${child2_txid}"
prev_vout="${child2_vout}"
prev_amount_sats="${child2_amount}"

cluster_json="$("${CLI[@]}" getmempoolcluster "${first_txid}")"
read -r accepted_count accepted_weight < <(
  CLUSTER_JSON="${cluster_json}" python3 <<'PY'
import json, os
d=json.loads(os.environ["CLUSTER_JSON"])
print(d["txcount"], d["clusterweight"])
PY
)

limit_weight="$((limit_vbytes * 4))"
if (( accepted_weight >= limit_weight )); then
  echo "ERROR: accepted cluster already exceeds configured size boundary"
  exit 1
fi

read -r candidate_hex candidate_vout candidate_amount candidate_vsize _ < <(
  build_large_child "${prev_txid}" "${prev_vout}" "${prev_amount_sats}" 4000
)
candidate_test="$("${CLI[@]}" testmempoolaccept "[\"${candidate_hex}\"]")"
read -r candidate_allowed reject_reason < <(
  TEST_JSON="${candidate_test}" python3 <<'PY'
import json, os
r=json.loads(os.environ["TEST_JSON"])[0]
print("yes" if r["allowed"] else "no", r.get("reject-reason",""))
PY
)

if [[ "${candidate_allowed}" != "no" ]]; then
  echo "ERROR: transaction pushing cluster over 101 kvB was unexpectedly accepted"
  exit 1
fi
if [[ "${reject_reason}" != *cluster* ]]; then
  echo "ERROR: oversized cluster candidate rejected for unexpected reason: ${reject_reason}"
  printf '%s\n' "${candidate_test}"
  exit 1
fi

projected_weight="$((accepted_weight + candidate_vsize * 4))"
if (( projected_weight <= limit_weight )); then
  echo "ERROR: candidate did not actually project cluster beyond size limit"
  exit 1
fi

mine_address="$("${WCLI[@]}" getnewaddress "cluster-size-mine" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

if "${CLI[@]}" getmempoolentry "${child2_txid}" >/dev/null 2>&1; then
  echo "ERROR: accepted size-cluster remained in mempool after mining"
  exit 1
fi

echo "Bitcoin Core cluster-size test passed."
echo "limitclustersize_vbytes=${limit_vbytes}"
echo "accepted_cluster_txcount=${accepted_count}"
echo "accepted_clusterweight=${accepted_weight}"
echo "child1_vsize=${child1_vsize}"
echo "child2_vsize=${child2_vsize}"
echo "candidate_vsize=${candidate_vsize}"
echo "projected_clusterweight=${projected_weight}"
echo "rejected_candidate_reason=${reject_reason}"
