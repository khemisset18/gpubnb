#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
WCLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" -rpcwallet=ae-ci)

seed_address="$("${WCLI[@]}" getnewaddress "rbf-feerate-seed" bech32)"
seed_txid="$("${WCLI[@]}" sendtoaddress "${seed_address}" 1.00000000)"
mine_address="$("${WCLI[@]}" getnewaddress "rbf-feerate-mine" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

seed_json="$("${CLI[@]}" getrawtransaction "${seed_txid}" true)"
read -r seed_vout seed_sats < <(
  printf '%s' "${seed_json}" | python3 -c '
from decimal import Decimal
import json,sys
data=json.load(sys.stdin)
target=sys.argv[1]
matches=[]
for v in data["vout"]:
    if v["scriptPubKey"].get("address") == target:
        matches.append((v["n"], int(Decimal(str(v["value"])) * Decimal(100_000_000))))
if len(matches) != 1:
    raise SystemExit(f"expected one seed output, found {len(matches)}")
print(matches[0][0], matches[0][1])
' "${seed_address}"
)

original_fee_sats=10000
weak_fee_sats=20000
strong_fee_sats=500000
decoy_count=100
decoy_sats=1000

build_outputs() {
  local fee_sats="$1"
  local continuation_address="$2"
  local label="$3"
  local continuation_sats="$((seed_sats - fee_sats - decoy_count * decoy_sats))"
  if (( continuation_sats <= 1000000 )); then
    echo "ERROR: continuation output too small" >&2
    exit 1
  fi

  python3 - "${fee_sats}" "${continuation_address}" "${continuation_sats}" "${label}" "${decoy_count}" "${decoy_sats}" <<'PY'
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

def regtest_p2pkh(label: str, index: int) -> str:
    payload=hashlib.sha256(f"gpubnb-rbf-feerate-{label}-{index}".encode()).digest()[:20]
    body=b"\x6f"+payload
    checksum=hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    return b58encode(body+checksum)

_fee, continuation_address, continuation_sats, label, count, decoy_sats = sys.argv[1:]
continuation_sats=int(continuation_sats)
count=int(count)
decoy_sats=int(decoy_sats)
outputs=[]
for i in range(count):
    outputs.append({regtest_p2pkh(label, i): f"{decoy_sats/100_000_000:.8f}"})
outputs.append({continuation_address: f"{continuation_sats/100_000_000:.8f}"})
print(json.dumps(outputs,separators=(",",":")))
PY
}

build_signed() {
  local fee_sats="$1"
  local many_outputs="$2"
  local label="$3"
  local destination="$("${WCLI[@]}" getnewaddress "rbf-feerate-${label}" bech32)"
  local outputs

  if [[ "${many_outputs}" == "yes" ]]; then
    outputs="$(build_outputs "${fee_sats}" "${destination}" "${label}")"
  else
    local out_sats="$((seed_sats - fee_sats))"
    local out_btc="$(
      python3 - "${out_sats}" <<'PY'
from decimal import Decimal
import sys
print(f"{Decimal(sys.argv[1])/Decimal(100_000_000):.8f}")
PY
    )"
    outputs="$(printf '{"%s":%s}' "${destination}" "${out_btc}")"
  fi

  local inputs raw signed complete hex decoded vsize
  inputs="$(printf '[{"txid":"%s","vout":%s,"sequence":4294967293}]' "${seed_txid}" "${seed_vout}")"
  raw="$("${CLI[@]}" -named createrawtransaction inputs="${inputs}" outputs="${outputs}" locktime=0 replaceable=true version=2)"
  signed="$("${WCLI[@]}" signrawtransactionwithwallet "${raw}")"
  complete="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
  if [[ "${complete}" != "yes" ]]; then
    echo "ERROR: wallet failed to sign ${label}" >&2
    exit 1
  fi
  hex="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
  decoded="$("${CLI[@]}" decoderawtransaction "${hex}")"
  vsize="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["vsize"])')"
  printf '%s %s\n' "${hex}" "${vsize}"
}

read -r original_hex original_vsize < <(build_signed "${original_fee_sats}" no original)
original_txid="$("${CLI[@]}" sendrawtransaction "${original_hex}")"
original_entry="$("${CLI[@]}" getmempoolentry "${original_txid}")"

read -r weak_hex weak_vsize < <(build_signed "${weak_fee_sats}" yes weak)
weak_test="$("${CLI[@]}" testmempoolaccept "[\"${weak_hex}\"]")"
read -r weak_allowed weak_reason < <(
  printf '%s' "${weak_test}" | python3 -c '
import json,sys
r=json.load(sys.stdin)[0]
print("yes" if r["allowed"] else "no", r.get("reject-reason",""))
'
)

if [[ "${weak_allowed}" != "no" ]]; then
  echo "ERROR: low-feerate larger replacement unexpectedly accepted"
  exit 1
fi
if [[ "${weak_reason}" != *"does not improve feerate diagram"* ]]; then
  echo "ERROR: weak replacement rejected for unexpected reason: ${weak_reason}"
  printf '%s\n' "${weak_test}"
  exit 1
fi

read -r strong_hex strong_vsize < <(build_signed "${strong_fee_sats}" yes strong)
strong_test="$("${CLI[@]}" testmempoolaccept "[\"${strong_hex}\"]")"
strong_allowed="$(printf '%s' "${strong_test}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${strong_allowed}" != "yes" ]]; then
  echo "ERROR: high-feerate replacement rejected"
  printf '%s\n' "${strong_test}"
  exit 1
fi

strong_txid="$("${CLI[@]}" sendrawtransaction "${strong_hex}")"
if "${CLI[@]}" getmempoolentry "${original_txid}" >/dev/null 2>&1; then
  echo "ERROR: original remained after accepted replacement"
  exit 1
fi

python3 - "${original_fee_sats}" "${original_vsize}" "${weak_fee_sats}" "${weak_vsize}" "${strong_fee_sats}" "${strong_vsize}" <<'PY'
from decimal import Decimal
import sys
of,ov,wf,wv,sf,sv = map(Decimal, sys.argv[1:])
if not (wf > of):
    raise SystemExit("weak replacement did not increase absolute fee")
if not (wf/wv < of/ov):
    raise SystemExit("weak replacement did not reduce feerate")
if not (sf > of):
    raise SystemExit("strong replacement did not increase absolute fee")
if not (sf/sv > of/ov):
    raise SystemExit("strong replacement did not improve feerate")
print(f"RBF_FEERATE original_fee_sats={of} original_vsize={ov} weak_fee_sats={wf} weak_vsize={wv} strong_fee_sats={sf} strong_vsize={sv}")
PY

"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

echo "Bitcoin Core RBF feerate-diagram test passed."
echo "original_txid=${original_txid}"
echo "weak_reject_reason=${weak_reason}"
echo "strong_replacement_txid=${strong_txid}"
