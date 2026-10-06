#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
CLI="${BITCOIN_BIN_DIR}/bitcoin-cli"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

json="$(
  node --input-type=module <<'NODE'
import { buildBitcoinHtlcV1 } from "./asset-exchange/settlement/src/bitcoin-htlc-v1.mjs";
const out = buildBitcoinHtlcV1({
  secretHashHex: "33".repeat(32),
  redeemPubkeyHex: "02" + "11".repeat(32),
  refundPubkeyHex: "03" + "22".repeat(32),
  refundLockHeight: 500
});
process.stdout.write(JSON.stringify(out));
NODE
)"

witness_script="$(printf '%s' "${json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["witnessScriptHex"])')"
script_pubkey="$(printf '%s' "${json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["scriptPubKeyHex"])')"
witness_hash="$(printf '%s' "${json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["witnessScriptHashHex"])')"

decoded="$("${CLI}" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" decodescript "${witness_script}")"
asm="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["asm"])')"

for opcode in OP_IF OP_SHA256 OP_EQUALVERIFY OP_CHECKSIG OP_ELSE OP_CHECKLOCKTIMEVERIFY OP_DROP OP_ENDIF; do
  if [[ " ${asm} " != *" ${opcode} "* ]]; then
    echo "ERROR: Bitcoin Core decode missing ${opcode}"
    echo "${asm}"
    exit 1
  fi
done

count_checksig="$(grep -o 'OP_CHECKSIG' <<<"${asm}" | wc -l | tr -d ' ')"
if [[ "${count_checksig}" != "2" ]]; then
  echo "ERROR: expected exactly two OP_CHECKSIG operations, got ${count_checksig}"
  exit 1
fi

python3 - "${witness_script}" "${witness_hash}" "${script_pubkey}" <<'PY'
import hashlib, sys
script = bytes.fromhex(sys.argv[1])
expected_hash = sys.argv[2]
expected_spk = sys.argv[3]
actual_hash = hashlib.sha256(script).hexdigest()
if actual_hash != expected_hash:
    raise SystemExit("witness script SHA256 mismatch")
actual_spk = "0020" + actual_hash
if actual_spk != expected_spk:
    raise SystemExit("P2WSH scriptPubKey mismatch")
PY

echo "Bitcoin Core decoded reviewed HTLC script successfully."
echo "witness_script=${witness_script}"
echo "witness_script_hash=${witness_hash}"
echo "script_pubkey=${script_pubkey}"
