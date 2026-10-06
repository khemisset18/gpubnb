#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
WCLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" -rpcwallet=ae-ci)

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
    raise SystemExit("unable to derive compressed pubkey")
print(m.group(1).lower())
PY
}

redeem_pubkey="$(pubkey_from_wif "${REDEEM_WIF}")"
refund_pubkey="$(pubkey_from_wif "${REFUND_WIF}")"
secret_hex="$(printf '11%.0s' {1..32})"
wrong_secret_hex="$(printf '22%.0s' {1..32})"
secret_hash="$(python3 - "${secret_hex}" <<'PY'
import hashlib, sys
print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())
PY
)"

current_height="$("${CLI[@]}" getblockcount)"
refund_lock_height="$((current_height + 10))"

htlc_json="$(
  REDEEM_PUBKEY="${redeem_pubkey}" REFUND_PUBKEY="${refund_pubkey}" SECRET_HASH="${secret_hash}" LOCK_HEIGHT="${refund_lock_height}" \
  node --input-type=module <<'NODE'
import { buildBitcoinHtlcV1 } from "./asset-exchange/settlement/src/bitcoin-htlc-v1.mjs";
process.stdout.write(JSON.stringify(buildBitcoinHtlcV1({
  secretHashHex: process.env.SECRET_HASH,
  redeemPubkeyHex: process.env.REDEEM_PUBKEY,
  refundPubkeyHex: process.env.REFUND_PUBKEY,
  refundLockHeight: Number(process.env.LOCK_HEIGHT)
})));
NODE
)"
witness_script="$(printf '%s' "${htlc_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["witnessScriptHex"])')"
script_pubkey="$(printf '%s' "${htlc_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["scriptPubKeyHex"])')"
decoded="$("${CLI[@]}" decodescript "${witness_script}")"
htlc_address="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["segwit"]["address"])')"

funding_amount='0.01000000'
funding_txid="$("${WCLI[@]}" sendtoaddress "${htlc_address}" "${funding_amount}")"
mine_address="$("${WCLI[@]}" getnewaddress "htlc-redeem-confirm" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

funding_json="$("${CLI[@]}" getrawtransaction "${funding_txid}" true)"
read -r funding_vout observed_amount observed_spk < <(
  FUNDING_JSON="${funding_json}" SCRIPT_PUBKEY="${script_pubkey}" python3 <<'PY'
import json, os
data = json.loads(os.environ["FUNDING_JSON"])
matches = [v for v in data["vout"] if v["scriptPubKey"]["hex"] == os.environ["SCRIPT_PUBKEY"]]
if len(matches) != 1:
    raise SystemExit(f"expected one HTLC output, found {len(matches)}")
v = matches[0]
print(v["n"], format(v["value"], ".8f"), v["scriptPubKey"]["hex"])
PY
)
if [[ "${observed_amount}" != "${funding_amount}" || "${observed_spk}" != "${script_pubkey}" ]]; then
  echo "ERROR: redeem funding output mismatch"
  exit 1
fi

destination="$("${WCLI[@]}" getnewaddress "htlc-redeem-destination" bech32)"
redeem_amount='0.00990000'
inputs_json="$(python3 - "${funding_txid}" "${funding_vout}" <<'PY'
import json, sys
print(json.dumps([{"txid":sys.argv[1],"vout":int(sys.argv[2]),"sequence":0xfffffffd}], separators=(",",":")))
PY
)"
outputs_json="$(python3 - "${destination}" "${redeem_amount}" <<'PY'
import json, sys
print(json.dumps({sys.argv[1]:float(sys.argv[2])}, separators=(",",":")))
PY
)"
redeem_raw="$("${CLI[@]}" -named createrawtransaction inputs="${inputs_json}" outputs="${outputs_json}" locktime=0 replaceable=true version=2)"
base_psbt="$("${CLI[@]}" converttopsbt "${redeem_raw}")"

correct_psbt="$(asset-exchange/bitcoin-regtest/psbt-add-sha256-preimage.py "${base_psbt}" "${secret_hash}" "${secret_hex}")"
decoded_psbt="$("${CLI[@]}" decodepsbt "${correct_psbt}")"
python3 - "${decoded_psbt}" "${secret_hash}" "${secret_hex}" <<'PY'
import json, sys
data=json.loads(sys.argv[1])
m=data["inputs"][0].get("sha256_preimages", {})
if m.get(sys.argv[2]) != sys.argv[3]:
    raise SystemExit("Bitcoin Core did not decode expected SHA256 preimage")
PY

private_descriptor="wsh(or_i(and_v(v:sha256(${secret_hash}),pk(${REDEEM_WIF})),and_v(v:after(${refund_lock_height}),pk(${REFUND_WIF}))))"
descriptors_json="$(python3 - "${private_descriptor}" <<'PY'
import json, sys
print(json.dumps([sys.argv[1]], separators=(",",":")))
PY
)"

# Wrong preimage associated with the expected hash must not produce an accepted spend.
wrong_psbt="$(asset-exchange/bitcoin-regtest/psbt-add-sha256-preimage.py --allow-mismatch "${base_psbt}" "${secret_hash}" "${wrong_secret_hex}")"
wrong_processed="$("${CLI[@]}" descriptorprocesspsbt "${wrong_psbt}" "${descriptors_json}" ALL true true)"
wrong_complete="$(printf '%s' "${wrong_processed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${wrong_complete}" == "yes" ]]; then
  wrong_hex="$(printf '%s' "${wrong_processed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
  wrong_accept="$("${CLI[@]}" testmempoolaccept "[\"${wrong_hex}\"]")"
  wrong_allowed="$(printf '%s' "${wrong_accept}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
  if [[ "${wrong_allowed}" != "no" ]]; then
    echo "ERROR: wrong preimage spend was accepted"
    exit 1
  fi
fi

# Correct preimage without redeem private key cannot finalize before the refund height.
public_redeem_private_refund="wsh(or_i(and_v(v:sha256(${secret_hash}),pk(${redeem_pubkey})),and_v(v:after(${refund_lock_height}),pk(${REFUND_WIF}))))"
wrong_key_descs="$(python3 - "${public_redeem_private_refund}" <<'PY'
import json, sys
print(json.dumps([sys.argv[1]], separators=(",",":")))
PY
)"
wrong_key="$("${CLI[@]}" descriptorprocesspsbt "${correct_psbt}" "${wrong_key_descs}" ALL true true)"
wrong_key_complete="$(printf '%s' "${wrong_key}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${wrong_key_complete}" != "no" ]]; then
  echo "ERROR: redeem finalized without redeem private key before CLTV"
  exit 1
fi

processed="$("${CLI[@]}" descriptorprocesspsbt "${correct_psbt}" "${descriptors_json}" ALL true true)"
complete="$(printf '%s' "${processed}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${complete}" != "yes" ]]; then
  echo "ERROR: correct preimage/key did not finalize redeem"
  printf '%s\n' "${processed}"
  exit 1
fi
redeem_hex="$(printf '%s' "${processed}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
redeem_decoded="$("${CLI[@]}" decoderawtransaction "${redeem_hex}")"
python3 - "${redeem_decoded}" "${secret_hex}" "${witness_script}" <<'PY'
import json, sys
tx=json.loads(sys.argv[1])
w=tx["vin"][0].get("txinwitness", [])
if sys.argv[2] not in w:
    raise SystemExit("redeem witness missing expected preimage")
if sys.argv[3] not in w:
    raise SystemExit("redeem witness missing reviewed witness script")
PY

accepted="$("${CLI[@]}" testmempoolaccept "[\"${redeem_hex}\"]")"
allowed="$(printf '%s' "${accepted}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${allowed}" != "yes" ]]; then
  echo "ERROR: correct redeem rejected"
  printf '%s\n' "${accepted}"
  exit 1
fi

redeem_txid="$("${CLI[@]}" sendrawtransaction "${redeem_hex}")"
redeem_block="$("${CLI[@]}" generatetoaddress 1 "${mine_address}" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
conf="$("${CLI[@]}" getrawtransaction "${redeem_txid}" true | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations",0))')"
if (( conf < 1 )); then echo "ERROR: redeem did not confirm"; exit 1; fi

"${CLI[@]}" invalidateblock "${redeem_block}"
"${CLI[@]}" getmempoolentry "${redeem_txid}" >/dev/null
"${CLI[@]}" reconsiderblock "${redeem_block}"
restored="$("${CLI[@]}" getrawtransaction "${redeem_txid}" true | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations",0))')"
if (( restored < 1 )); then echo "ERROR: redeem confirmation not restored"; exit 1; fi

echo "HTLC redeem path regtest passed."
echo "funding_txid=${funding_txid}"
echo "redeem_txid=${redeem_txid}"
echo "refund_lock_height=${refund_lock_height}"
