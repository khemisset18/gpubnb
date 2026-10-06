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
m=re.search(r'pk\(([0-9a-fA-F]{66})\)', sys.argv[1])
if not m: raise SystemExit("unable to derive compressed pubkey")
print(m.group(1).lower())
PY
}

redeem_pubkey="$(pubkey_from_wif "${REDEEM_WIF}")"
refund_pubkey="$(pubkey_from_wif "${REFUND_WIF}")"
secret_hex="$(printf '55%.0s' {1..32})"
secret_hash="$(python3 - "${secret_hex}" <<'PY'
import hashlib, sys
print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())
PY
)"

current_height="$("${CLI[@]}" getblockcount)"
refund_lock_height="$((current_height + 5))"

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
htlc_address="$("${CLI[@]}" decodescript "${witness_script}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["segwit"]["address"])')"

funding_amount='0.01000000'
funding_outputs="$(python3 - "${htlc_address}" "${funding_amount}" <<'PY'
import json, sys
print(json.dumps({sys.argv[1]:float(sys.argv[2])}, separators=(",",":")))
PY
)"

# Prepare the funding transaction but DO NOT broadcast it.
funded="$("${WCLI[@]}" -named walletcreatefundedpsbt \
  inputs='[]' \
  outputs="${funding_outputs}" \
  locktime=0 \
  options='{"replaceable":false,"fee_rate":1}' \
  bip32derivs=true)"
funding_psbt="$(printf '%s' "${funded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["psbt"])')"

# Stable outpoint requirement: every funding input in this proof must be native
# SegWit so witness signatures cannot mutate the txid.
funding_psbt_decoded="$("${CLI[@]}" decodepsbt "${funding_psbt}")"
printf '%s' "${funding_psbt_decoded}" | python3 -c '
import json, sys
data=json.load(sys.stdin)
if not data["inputs"]:
    raise SystemExit("funding PSBT has no inputs")
for i, inp in enumerate(data["inputs"]):
    utxo=inp.get("witness_utxo")
    if not utxo:
        raise SystemExit(f"funding input {i} missing witness_utxo")
    typ=utxo["scriptPubKey"].get("type")
    if typ not in {"witness_v0_keyhash","witness_v0_scripthash","witness_v1_taproot"}:
        raise SystemExit(f"funding input {i} is not native SegWit: {typ}")
'

signed_funding="$("${WCLI[@]}" walletprocesspsbt "${funding_psbt}" true ALL true true)"
funding_complete="$(printf '%s' "${signed_funding}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${funding_complete}" != "yes" ]]; then
  echo "ERROR: funding transaction did not finalize"
  exit 1
fi
funding_hex="$(printf '%s' "${signed_funding}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"
funding_decoded="$("${CLI[@]}" decoderawtransaction "${funding_hex}")"
funding_txid="$(printf '%s' "${funding_decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["txid"])')"

read -r funding_vout observed_amount observed_spk < <(
  FUNDING_JSON="${funding_decoded}" SCRIPT_PUBKEY="${script_pubkey}" python3 <<'PY'
import json, os
data=json.loads(os.environ["FUNDING_JSON"])
matches=[v for v in data["vout"] if v["scriptPubKey"]["hex"] == os.environ["SCRIPT_PUBKEY"]]
if len(matches) != 1:
    raise SystemExit(f"expected one prepared HTLC output, found {len(matches)}")
v=matches[0]
print(v["n"], format(v["value"], ".8f"), v["scriptPubKey"]["hex"])
PY
)
if [[ "${observed_amount}" != "${funding_amount}" || "${observed_spk}" != "${script_pubkey}" ]]; then
  echo "ERROR: prepared funding output mismatch"
  exit 1
fi

if "${CLI[@]}" getmempoolentry "${funding_txid}" >/dev/null 2>&1; then
  echo "ERROR: funding entered mempool before recovery readiness"
  exit 1
fi

# Build refund against the FINAL signed funding txid while funding is still offline.
refund_destination="$("${WCLI[@]}" getnewaddress "recovery-before-lock-refund" bech32)"
refund_amount='0.00999000'
inputs_json="$(python3 - "${funding_txid}" "${funding_vout}" <<'PY'
import json, sys
print(json.dumps([{"txid":sys.argv[1],"vout":int(sys.argv[2]),"sequence":0xfffffffd}], separators=(",",":")))
PY
)"
outputs_json="$(python3 - "${refund_destination}" "${refund_amount}" <<'PY'
import json, sys
print(json.dumps({sys.argv[1]:float(sys.argv[2])}, separators=(",",":")))
PY
)"
refund_raw="$("${CLI[@]}" -named createrawtransaction inputs="${inputs_json}" outputs="${outputs_json}" locktime="${refund_lock_height}" replaceable=true version=2)"
refund_psbt="$("${CLI[@]}" converttopsbt "${refund_raw}")"
refund_psbt="$(
  asset-exchange/bitcoin-regtest/psbt-add-witness-utxo.py \
    "${refund_psbt}" 1000000 "${script_pubkey}"
)"

decoded_refund_psbt="$("${CLI[@]}" decodepsbt "${refund_psbt}")"
printf '%s' "${decoded_refund_psbt}" | python3 -c '
from decimal import Decimal
import json, sys
inp=json.load(sys.stdin)["inputs"][0]
utxo=inp.get("witness_utxo")
if not utxo:
    raise SystemExit("offline refund PSBT missing witness_utxo")
if Decimal(str(utxo["amount"])) != Decimal("0.01000000"):
    raise SystemExit("offline refund witness_utxo amount mismatch")
if utxo["scriptPubKey"]["hex"] != sys.argv[1]:
    raise SystemExit("offline refund witness_utxo script mismatch")
' "${script_pubkey}"

private_descriptor="wsh(or_i(and_v(v:sha256(${secret_hash}),pk(${REDEEM_WIF})),and_v(v:after(${refund_lock_height}),pk(${REFUND_WIF}))))"
descriptors_json="$(python3 - "${private_descriptor}" <<'PY'
import json, sys
print(json.dumps([sys.argv[1]], separators=(",",":")))
PY
)"
signed_refund="$("${CLI[@]}" descriptorprocesspsbt "${refund_psbt}" "${descriptors_json}" ALL true true)"
refund_complete="$(printf '%s' "${signed_refund}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("complete") else "no")')"
if [[ "${refund_complete}" != "yes" ]]; then
  echo "ERROR: refund could not be signed before funding broadcast"
  printf '%s\n' "${signed_refund}"
  exit 1
fi
refund_hex="$(printf '%s' "${signed_refund}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hex"])')"

# Export and validate encrypted recovery bundle BEFORE any lock broadcast.
recovery_dir="${BITCOIN_REGTEST_DATADIR}/standalone-recovery"
mkdir -m 700 "${recovery_dir}"
key_file="${recovery_dir}/recovery.key"
payload_file="${recovery_dir}/payload.json"
bundle_file="${recovery_dir}/bundle.json"
validation_file="${recovery_dir}/validation.json"

FUNDING_HEX="${funding_hex}" FUNDING_TXID="${funding_txid}" REFUND_HEX="${refund_hex}" \
LOCK_HEIGHT="${refund_lock_height}" CREATED_AT="$(( $(date +%s) * 1000 ))" \
python3 > "${payload_file}" <<'PY'
import json, os
payload={
  "metadata":{
    "bundleVersion":1,
    "deploymentId":"ae-regtest-recovery",
    "tradeId":"trade-recovery-before-lock-0001",
    "protocolId":"GPUBNB-ASSET-EXCHANGE-BTC-P2WSH-HTLC-V1",
    "protocolVersion":1,
    "partyRole":"MAKER",
    "chainProfiles":["bitcoin-regtest-v1"],
    "recoveryActions":["REFUND","REBROADCAST","RECONCILE"],
    "createdAtUnixMs":int(os.environ["CREATED_AT"]),
  },
  "artifacts":[
    {"artifactType":"LOCK_TX","chainProfile":"bitcoin-regtest-v1","encoding":"HEX","data":os.environ["FUNDING_HEX"]},
    {"artifactType":"LOCK_TXID","chainProfile":"bitcoin-regtest-v1","encoding":"HEX","data":os.environ["FUNDING_TXID"]},
    {"artifactType":"SIGNED_REFUND_TX","chainProfile":"bitcoin-regtest-v1","encoding":"HEX","data":os.environ["REFUND_HEX"]},
    {"artifactType":"CHAIN_RECOVERY_RECIPE","chainProfile":"bitcoin-regtest-v1","encoding":"JSON","data":json.dumps({"refundLockHeight":int(os.environ["LOCK_HEIGHT"]),"network":"regtest"}, separators=(",",":"))},
  ]
}
print(json.dumps(payload,separators=(",",":")))
PY
chmod 600 "${payload_file}"

node asset-exchange/recovery/src/cli.mjs keygen "${key_file}" >/dev/null
node asset-exchange/recovery/src/cli.mjs encrypt "${key_file}" "${payload_file}" "${bundle_file}" >/dev/null
node asset-exchange/recovery/src/cli.mjs decrypt "${key_file}" "${bundle_file}" "${validation_file}" >/dev/null

python3 - "${validation_file}" "${funding_txid}" "${funding_hex}" "${refund_hex}" <<'PY'
import json, sys
p=json.load(open(sys.argv[1], encoding="utf8"))
arts={a["artifactType"]:a["data"] for a in p["artifacts"]}
if arts["LOCK_TXID"] != sys.argv[2]: raise SystemExit("bundle lock txid mismatch")
if arts["LOCK_TX"] != sys.argv[3]: raise SystemExit("bundle lock transaction mismatch")
if arts["SIGNED_REFUND_TX"] != sys.argv[4]: raise SystemExit("bundle signed refund mismatch")
PY

if grep -q "${funding_txid}" "${bundle_file}" || grep -q "${refund_hex}" "${bundle_file}"; then
  echo "ERROR: encrypted recovery bundle leaked plaintext transaction material"
  exit 1
fi

# Plaintext preparation artifacts are deleted. Only encrypted bundle + user-side key remain.
rm -f "${payload_file}" "${validation_file}"
if "${CLI[@]}" getmempoolentry "${funding_txid}" >/dev/null 2>&1; then
  echo "ERROR: funding was broadcast before bundle export/validation completed"
  exit 1
fi

# ONLY NOW broadcast the already-signed funding transaction.
broadcast_funding="$("${CLI[@]}" sendrawtransaction "${funding_hex}")"
if [[ "${broadcast_funding}" != "${funding_txid}" ]]; then
  echo "ERROR: broadcast funding txid changed from prepared txid"
  exit 1
fi

mine_address="$("${WCLI[@]}" getnewaddress "recovery-before-lock-mining" bech32)"
"${CLI[@]}" generatetoaddress 1 "${mine_address}" >/dev/null

# Simulate loss of wallet/API after funding confirmation. The signed refund must
# remain executable from bundle + key + clean Bitcoin node access.
"${CLI[@]}" unloadwallet "ae-ci" >/dev/null
loaded="$("${CLI[@]}" listwallets)"
if printf '%s' "${loaded}" | grep -q '"ae-ci"'; then
  echo "ERROR: test wallet still loaded during standalone recovery"
  exit 1
fi

height_now="$("${CLI[@]}" getblockcount)"
blocks_needed="$((refund_lock_height - height_now))"
if (( blocks_needed > 0 )); then
  "${CLI[@]}" generatetoaddress "${blocks_needed}" "${mine_address}" >/dev/null
fi

execution_file="${recovery_dir}/execution.json"
node asset-exchange/recovery/src/cli.mjs decrypt "${key_file}" "${bundle_file}" "${execution_file}" >/dev/null
recovered_refund="$(python3 - "${execution_file}" <<'PY'
import json, sys
p=json.load(open(sys.argv[1], encoding="utf8"))
matches=[a["data"] for a in p["artifacts"] if a["artifactType"]=="SIGNED_REFUND_TX"]
if len(matches) != 1: raise SystemExit("expected exactly one signed refund artifact")
print(matches[0])
PY
)"
rm -f "${execution_file}"

probe="$("${CLI[@]}" testmempoolaccept "[\"${recovered_refund}\"]")"
allowed="$(printf '%s' "${probe}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${allowed}" != "yes" ]]; then
  echo "ERROR: standalone recovered refund is not relayable"
  printf '%s\n' "${probe}"
  exit 1
fi

refund_txid="$("${CLI[@]}" sendrawtransaction "${recovered_refund}")"
refund_block="$("${CLI[@]}" generatetoaddress 1 "${mine_address}" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
confirmations="$("${CLI[@]}" getrawtransaction "${refund_txid}" true | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations",0))')"
if (( confirmations < 1 )); then
  echo "ERROR: standalone recovered refund did not confirm"
  exit 1
fi

echo "Recovery-before-lock standalone refund passed."
echo "prepared_funding_txid=${funding_txid}"
echo "standalone_refund_txid=${refund_txid}"
echo "refund_block=${refund_block}"
echo "wallet_loaded_during_refund=no"
