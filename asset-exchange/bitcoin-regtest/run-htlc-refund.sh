#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
WCLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" -rpcwallet=ae-ci)

# Public test fixtures copied from Bitcoin Core's own signrawtransactionwithkey
# functional test. They are regtest/testnet-only and MUST never appear in runtime code.
REDEEM_WIF='cUeKHd5orzT3mz8P9pxyREHfsWtVfgsfDjiZZBcjUBAaGk1BTj7N'
REFUND_WIF='cVKpPfVKSJxKqVpE9awvXNWuLHCa5j5tiE7K6zbUSptFpTEtiFrA'

pubkey_from_wif() {
  local wif="$1"
  local info desc
  info="$("${CLI[@]}" getdescriptorinfo "pk(${wif})")"
  desc="$(printf '%s' "${info}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["descriptor"])')"
  python3 - "${desc}" <<'PY'
import re, sys
m = re.search(r'pk\(([0-9a-fA-F]{66})\)', sys.argv[1])
if not m:
    raise SystemExit("unable to derive compressed pubkey from descriptor")
print(m.group(1).lower())
PY
}

redeem_pubkey="$(pubkey_from_wif "${REDEEM_WIF}")"
refund_pubkey="$(pubkey_from_wif "${REFUND_WIF}")"

current_height="$("${CLI[@]}" getblockcount)"
refund_lock_height="$((current_height + 3))"

secret_hex="$(printf '11%.0s' {1..32})"
secret_hash="$(
  python3 - "${secret_hex}" <<'PY'
import hashlib, sys
print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())
PY
)"

htlc_json="$(
  REDEEM_PUBKEY="${redeem_pubkey}" REFUND_PUBKEY="${refund_pubkey}" SECRET_HASH="${secret_hash}" LOCK_HEIGHT="${refund_lock_height}" \
  node --input-type=module <<'NODE'
import { buildBitcoinHtlcV1 } from "./asset-exchange/settlement/src/bitcoin-htlc-v1.mjs";
const out = buildBitcoinHtlcV1({
  secretHashHex: process.env.SECRET_HASH,
  redeemPubkeyHex: process.env.REDEEM_PUBKEY,
  refundPubkeyHex: process.env.REFUND_PUBKEY,
  refundLockHeight: Number(process.env.LOCK_HEIGHT)
});
process.stdout.write(JSON.stringify(out));
NODE
)"

witness_script="$(printf '%s' "${htlc_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["witnessScriptHex"])')"
script_pubkey="$(printf '%s' "${htlc_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["scriptPubKeyHex"])')"

decoded="$("${CLI[@]}" decodescript "${witness_script}")"
htlc_address="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["segwit"]["address"])')"

funding_amount='0.01000000'
funding_txid="$("${WCLI[@]}" sendtoaddress "${htlc_address}" "${funding_amount}")"
mine_address="$("${WCLI[@]}" getnewaddress "htlc-funding-confirm" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

funding_json="$("${CLI[@]}" getrawtransaction "${funding_txid}" true)"
read -r funding_vout observed_amount observed_spk < <(
  printf '%s' "${funding_json}" | python3 - "${script_pubkey}" <<'PY'
import json, sys
target = sys.argv[1]
data = json.load(sys.stdin)
matches = [v for v in data["vout"] if v["scriptPubKey"]["hex"] == target]
if len(matches) != 1:
    raise SystemExit(f"expected one HTLC output, found {len(matches)}")
v = matches[0]
print(v["n"], format(v["value"], ".8f"), v["scriptPubKey"]["hex"])
PY
)

if [[ "${observed_spk}" != "${script_pubkey}" || "${observed_amount}" != "${funding_amount}" ]]; then
  echo "ERROR: funded HTLC output does not exactly match intended script/value"
  exit 1
fi

refund_destination="$("${WCLI[@]}" getnewaddress "htlc-refund-destination" bech32)"
refund_amount='0.00990000'

inputs_json="$(
  python3 - "${funding_txid}" "${funding_vout}" <<'PY'
import json, sys
print(json.dumps([{
    "txid": sys.argv[1],
    "vout": int(sys.argv[2]),
    "sequence": 0xfffffffd,
}], separators=(",", ":")))
PY
)"
outputs_json="$(
  python3 - "${refund_destination}" "${refund_amount}" <<'PY'
import json, sys
print(json.dumps({sys.argv[1]: float(sys.argv[2])}, separators=(",", ":")))
PY
)"

refund_raw="$(
  "${CLI[@]}" -named createrawtransaction \
    inputs="${inputs_json}" \
    outputs="${outputs_json}" \
    locktime="${refund_lock_height}" \
    replaceable=true \
    version=2
)"

prevouts_json="$(
  python3 - "${funding_txid}" "${funding_vout}" "${script_pubkey}" "${witness_script}" "${funding_amount}" <<'PY'
import json, sys
print(json.dumps([{
    "txid": sys.argv[1],
    "vout": int(sys.argv[2]),
    "scriptPubKey": sys.argv[3],
    "witnessScript": sys.argv[4],
    "amount": float(sys.argv[5]),
}], separators=(",", ":")))
PY
)"
keys_json="$(
  python3 - "${REFUND_WIF}" <<'PY'
import json, sys
print(json.dumps([sys.argv[1]], separators=(",", ":")))
PY
)"

signed="$("${CLI[@]}" signrawtransactionwithkey "${refund_raw}" "${keys_json}" "${prevouts_json}" ALL)"
complete="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${complete}" != "yes" ]]; then
  echo "ERROR: Bitcoin Core could not fully sign/finalize refund path"
  printf '%s\n' "${signed}"
  exit 1
fi
refund_hex="$(printf '%s' "${signed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"

decoded_refund="$("${CLI[@]}" decoderawtransaction "${refund_hex}")"
python3 - "${decoded_refund}" "${refund_lock_height}" <<'PY'
import json, sys
tx = json.loads(sys.argv[1])
lock_height = int(sys.argv[2])
if tx["version"] != 2:
    raise SystemExit("refund tx version mismatch")
if tx["locktime"] != lock_height:
    raise SystemExit("refund tx locktime mismatch")
if len(tx["vin"]) != 1 or tx["vin"][0]["sequence"] != 0xfffffffd:
    raise SystemExit("refund tx sequence mismatch")
PY

early="$("${CLI[@]}" testmempoolaccept "[\"${refund_hex}\"]")"
early_allowed="$(printf '%s' "${early}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${early_allowed}" != "no" ]]; then
  echo "ERROR: refund was accepted before CLTV height"
  exit 1
fi

height_now="$("${CLI[@]}" getblockcount)"
blocks_needed="$((refund_lock_height - height_now))"
if (( blocks_needed > 0 )); then
  "${CLI[@]}" generatetoaddress "${blocks_needed}" "${mine_address}" >/dev/null
fi

mature="$("${CLI[@]}" testmempoolaccept "[\"${refund_hex}\"]")"
mature_allowed="$(printf '%s' "${mature}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${mature_allowed}" != "yes" ]]; then
  echo "ERROR: refund still rejected after CLTV height"
  printf '%s\n' "${mature}"
  exit 1
fi

refund_txid="$("${CLI[@]}" sendrawtransaction "${refund_hex}")"
refund_block="$("${CLI[@]}" generatetoaddress 1 "${mine_address}" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
refund_confirmations="$("${CLI[@]}" getrawtransaction "${refund_txid}" true | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations", 0))')"
if (( refund_confirmations < 1 )); then
  echo "ERROR: refund did not confirm"
  exit 1
fi

"${CLI[@]}" invalidateblock "${refund_block}"
reorg_state="$("${CLI[@]}" getmempoolentry "${refund_txid}" | python3 -c 'import json,sys; print("mempool" if json.load(sys.stdin) else "missing")')"
if [[ "${reorg_state}" != "mempool" ]]; then
  echo "ERROR: refund did not return to mempool after reorg"
  exit 1
fi

"${CLI[@]}" reconsiderblock "${refund_block}"
restored="$("${CLI[@]}" getrawtransaction "${refund_txid}" true | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations", 0))')"
if (( restored < 1 )); then
  echo "ERROR: refund confirmation was not restored"
  exit 1
fi

echo "HTLC refund path regtest passed."
echo "funding_txid=${funding_txid}"
echo "refund_txid=${refund_txid}"
echo "refund_lock_height=${refund_lock_height}"
