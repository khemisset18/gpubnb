#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
CLI="${BITCOIN_BIN_DIR}/bitcoin-cli"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

REDEEM_WIF='cUeKHd5orzT3mz8P9pxyREHfsWtVfgsfDjiZZBcjUBAaGk1BTj7N'
REFUND_WIF='cVKpPfVKSJxKqVpE9awvXNWuLHCa5j5tiE7K6zbUSptFpTEtiFrA'

pubkey_from_wif() {
  local wif="$1"
  local info desc
  info="$("${CLI}" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" getdescriptorinfo "pk(${wif})")"
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
secret_hash="$(printf '33%.0s' {1..32})"

json="$(
  REDEEM_PUBKEY="${redeem_pubkey}" REFUND_PUBKEY="${refund_pubkey}" SECRET_HASH="${secret_hash}" \
  node --input-type=module <<'NODE'
import { buildBitcoinHtlcV1 } from "./asset-exchange/settlement/src/bitcoin-htlc-v1.mjs";
const out = buildBitcoinHtlcV1({
  secretHashHex: process.env.SECRET_HASH,
  redeemPubkeyHex: process.env.REDEEM_PUBKEY,
  refundPubkeyHex: process.env.REFUND_PUBKEY,
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

for opcode in OP_IF OP_SHA256 OP_EQUALVERIFY OP_CHECKSIG OP_ELSE OP_CHECKLOCKTIMEVERIFY OP_VERIFY OP_ENDIF; do
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

canonical_miniscript="wsh(or_i(and_v(v:sha256(${secret_hash}),pk(${redeem_pubkey})),and_v(v:after(500),pk(${refund_pubkey}))))"
descriptor_info="$("${CLI}" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" getdescriptorinfo "${canonical_miniscript}")"
descriptor="$(printf '%s' "${descriptor_info}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["descriptor"])')"
descriptor_address="$("${CLI}" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}" deriveaddresses "${descriptor}" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
script_address="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["segwit"]["address"])')"
if [[ "${descriptor_address}" != "${script_address}" ]]; then
  echo "ERROR: Miniscript descriptor does not compile to reviewed P2WSH output"
  echo "descriptor_address=${descriptor_address}"
  echo "script_address=${script_address}"
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

echo "Bitcoin Core decoded reviewed HTLC script and matched canonical Miniscript descriptor successfully."
echo "witness_script=${witness_script}"
echo "witness_script_hash=${witness_hash}"
echo "script_pubkey=${script_pubkey}"
