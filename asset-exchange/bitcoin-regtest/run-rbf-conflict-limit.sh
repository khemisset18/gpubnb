#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
WCLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" -rpcwallet=ae-ci)

cluster_count=101
split_amount_btc='0.02000000'
child_fee_sats=1000
replacement_fee_sats=300000

# Create 101 independent confirmed wallet outputs in one splitter transaction.
addresses_file="$(mktemp)"
trap 'rm -f "${addresses_file}"' RETURN
for i in $(seq 1 "${cluster_count}"); do
  addr="$("${WCLI[@]}" getnewaddress "rbf-conflict-${i}" bech32)"
  printf '%s\n' "${addr}" >> "${addresses_file}"
done

outputs_json="$(
  python3 - "${addresses_file}" "${split_amount_btc}" <<'PY'
import json, sys
path, amount = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    addrs=[line.strip() for line in f if line.strip()]
print(json.dumps([{a: amount} for a in addrs], separators=(",",":")))
PY
)"

split_raw="$("${CLI[@]}" -named createrawtransaction inputs='[]' outputs="${outputs_json}" locktime=0 replaceable=false version=2)"
split_funded="$("${WCLI[@]}" -named fundrawtransaction hexstring="${split_raw}" options='{"replaceable":false,"fee_rate":1}')"
split_hex_unsigned="$(printf '%s' "${split_funded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
split_signed="$("${WCLI[@]}" signrawtransactionwithwallet "${split_hex_unsigned}")"
split_complete="$(printf '%s' "${split_signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${split_complete}" != "yes" ]]; then
  echo "ERROR: wallet failed to sign RBF conflict splitter"
  exit 1
fi
split_hex="$(printf '%s' "${split_signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
split_txid="$("${CLI[@]}" sendrawtransaction "${split_hex}")"
mine_address="$("${WCLI[@]}" getnewaddress "rbf-conflict-mine" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

split_json="$("${CLI[@]}" getrawtransaction "${split_txid}" true)"
utxos_file="$(mktemp)"
trap 'rm -f "${addresses_file}" "${utxos_file}"' RETURN
printf '%s' "${split_json}" | python3 -c '
from decimal import Decimal
import json, sys
addresses=set(line.strip() for line in open(sys.argv[1], encoding="utf-8") if line.strip())
tx=json.load(sys.stdin)
rows=[]
for v in tx["vout"]:
    addr=v["scriptPubKey"].get("address")
    if addr in addresses:
        sats=int(Decimal(str(v["value"])) * Decimal(100_000_000))
        rows.append((v["n"], sats, addr))
if len(rows) != 101:
    raise SystemExit(f"expected 101 confirmed splitter outputs, found {len(rows)}")
for vout, sats, addr in sorted(rows):
    print(vout, sats, addr)
' "${addresses_file}" > "${utxos_file}"

# Spend each confirmed splitter output independently. Each child is a singleton
# cluster, so the later doublespend can conflict with 101 distinct clusters.
children_file="$(mktemp)"
trap 'rm -f "${addresses_file}" "${utxos_file}" "${children_file}"' RETURN
while read -r vout sats source_addr; do
  dest="$("${WCLI[@]}" getnewaddress "rbf-conflict-child" bech32)"
  out_sats="$((sats - child_fee_sats))"
  amount_btc="$(
    python3 - "${out_sats}" <<'PY'
from decimal import Decimal
import sys
print(f"{Decimal(sys.argv[1])/Decimal(100_000_000):.8f}")
PY
  )"
  inputs="$(printf '[{"txid":"%s","vout":%s,"sequence":4294967293}]' "${split_txid}" "${vout}")"
  outputs="$(printf '{"%s":%s}' "${dest}" "${amount_btc}")"
  raw="$("${CLI[@]}" -named createrawtransaction inputs="${inputs}" outputs="${outputs}" locktime=0 replaceable=true version=2)"
  signed="$("${WCLI[@]}" signrawtransactionwithwallet "${raw}")"
  complete="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
  if [[ "${complete}" != "yes" ]]; then
    echo "ERROR: wallet failed to sign RBF conflict child"
    exit 1
  fi
  hex="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
  child_txid="$("${CLI[@]}" sendrawtransaction "${hex}")"
  printf '%s\n' "${child_txid}" >> "${children_file}"
done < "${utxos_file}"

mempool_count="$("${CLI[@]}" getrawmempool | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
if (( mempool_count < cluster_count )); then
  echo "ERROR: expected at least 101 independent conflict transactions in mempool"
  exit 1
fi

build_replacement() {
  local input_count="$1"
  local replacement_fee="$2"

  python3 - "${utxos_file}" "${split_txid}" "${input_count}" "${replacement_fee}" <<'PY'
from decimal import Decimal
import json, sys
path, txid, count_s, fee_s = sys.argv[1:]
count=int(count_s)
fee=int(fee_s)
rows=[]
with open(path, encoding="utf-8") as f:
    for line in f:
        vout, sats, _addr=line.split()
        rows.append((int(vout), int(sats)))
rows=rows[:count]
inputs=[{"txid":txid,"vout":vout,"sequence":4294967293} for vout,_ in rows]
total=sum(sats for _,sats in rows)
output_sats=total-fee
print(json.dumps({"inputs":inputs,"output_sats":output_sats}, separators=(",",":")))
PY
}

replacement101_spec="$(build_replacement 101 "${replacement_fee_sats}")"
replacement101_inputs="$(printf '%s' "${replacement101_spec}" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["inputs"],separators=(",",":")))')"
replacement101_sats="$(printf '%s' "${replacement101_spec}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["output_sats"])')"
replacement101_dest="$("${WCLI[@]}" getnewaddress "rbf-conflict-replacement-101" bech32)"
replacement101_btc="$(python3 - "${replacement101_sats}" <<'PY'
from decimal import Decimal
import sys
print(f"{Decimal(sys.argv[1])/Decimal(100_000_000):.8f}")
PY
)"
replacement101_outputs="$(printf '{"%s":%s}' "${replacement101_dest}" "${replacement101_btc}")"
replacement101_raw="$("${CLI[@]}" -named createrawtransaction inputs="${replacement101_inputs}" outputs="${replacement101_outputs}" locktime=0 replaceable=true version=2)"
replacement101_signed="$("${WCLI[@]}" signrawtransactionwithwallet "${replacement101_raw}")"
replacement101_complete="$(printf '%s' "${replacement101_signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${replacement101_complete}" != "yes" ]]; then
  echo "ERROR: wallet failed to sign 101-cluster replacement"
  exit 1
fi
replacement101_hex="$(printf '%s' "${replacement101_signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
replacement101_test="$("${CLI[@]}" testmempoolaccept "[\"${replacement101_hex}\"]")"
read -r allowed101 reason101 < <(
  TEST_JSON="${replacement101_test}" python3 <<'PY'
import json, os
r=json.loads(os.environ["TEST_JSON"])[0]
print("yes" if r["allowed"] else "no", r.get("reject-reason",""))
PY
)
if [[ "${allowed101}" != "no" ]]; then
  echo "ERROR: replacement conflicting with 101 clusters unexpectedly accepted"
  exit 1
fi
if [[ "${reason101}" != "too many potential replacements" ]]; then
  echo "ERROR: 101-cluster replacement rejected for unexpected reason: ${reason101}"
  printf '%s\n' "${replacement101_test}"
  exit 1
fi

# Drop one input. With 100 conflicting clusters and the same ample fee budget,
# the replacement should be accepted.
replacement100_spec="$(build_replacement 100 "${replacement_fee_sats}")"
replacement100_inputs="$(printf '%s' "${replacement100_spec}" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["inputs"],separators=(",",":")))')"
replacement100_sats="$(printf '%s' "${replacement100_spec}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["output_sats"])')"
replacement100_dest="$("${WCLI[@]}" getnewaddress "rbf-conflict-replacement-100" bech32)"
replacement100_btc="$(python3 - "${replacement100_sats}" <<'PY'
from decimal import Decimal
import sys
print(f"{Decimal(sys.argv[1])/Decimal(100_000_000):.8f}")
PY
)"
replacement100_outputs="$(printf '{"%s":%s}' "${replacement100_dest}" "${replacement100_btc}")"
replacement100_raw="$("${CLI[@]}" -named createrawtransaction inputs="${replacement100_inputs}" outputs="${replacement100_outputs}" locktime=0 replaceable=true version=2)"
replacement100_signed="$("${WCLI[@]}" signrawtransactionwithwallet "${replacement100_raw}")"
replacement100_complete="$(printf '%s' "${replacement100_signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${replacement100_complete}" != "yes" ]]; then
  echo "ERROR: wallet failed to sign 100-cluster replacement"
  exit 1
fi
replacement100_hex="$(printf '%s' "${replacement100_signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
replacement100_test="$("${CLI[@]}" testmempoolaccept "[\"${replacement100_hex}\"]")"
allowed100="$(printf '%s' "${replacement100_test}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${allowed100}" != "yes" ]]; then
  echo "ERROR: replacement conflicting with 100 clusters was rejected"
  printf '%s\n' "${replacement100_test}"
  exit 1
fi

replacement100_txid="$("${CLI[@]}" sendrawtransaction "${replacement100_hex}")"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

if "${CLI[@]}" getmempoolentry "${replacement100_txid}" >/dev/null 2>&1; then
  echo "ERROR: accepted 100-cluster replacement remained in mempool after mining"
  exit 1
fi

echo "Bitcoin Core RBF conflict-cluster limit test passed."
echo "conflicting_clusters_rejected=101"
echo "reject_reason_101=${reason101}"
echo "conflicting_clusters_accepted=100"
echo "replacement100_txid=${replacement100_txid}"
