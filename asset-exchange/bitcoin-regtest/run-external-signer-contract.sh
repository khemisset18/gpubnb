#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
MOCK_SIGNER="${GPUBNB_MOCK_SIGNER:?GPUBNB_MOCK_SIGNER required}"

signers="$("${CLI[@]}" enumeratesigners)"
read -r signer_count fingerprint model < <(
  printf '%s' "${signers}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
items=d.get("signers",[])
if len(items) != 1:
    print(len(items), "", "")
else:
    print(len(items), items[0].get("fingerprint",""), items[0].get("name",""))
'
)
if [[ "${signer_count}" != "1" || "${fingerprint}" != "deadbeef" ]]; then
  echo "ERROR: Bitcoin Core did not enumerate exactly the expected mock signer"
  printf '%s\n' "${signers}"
  exit 1
fi

psbt_fixture="$(
  python3 - <<'PY'
import base64
print(base64.b64encode(b"psbt\xff\x00").decode())
PY
)"

assert_error() {
  local expected="$1"
  shift
  local out
  out="$("$@")"
  ERROR_JSON="${out}" EXPECTED="${expected}" python3 - <<'PY'
import json, os
d=json.loads(os.environ["ERROR_JSON"])
expected=os.environ["EXPECTED"]
msg=d.get("error","")
if expected not in msg:
    raise SystemExit(f"expected error containing {expected!r}, got {msg!r}")
PY
}

assert_error "unexpected signer fingerprint"   "${MOCK_SIGNER}" --stdin --fingerprint 00000000 --chain regtest   <<<"signtx ${psbt_fixture}"

assert_error "unexpected signer chain"   "${MOCK_SIGNER}" --stdin --fingerprint deadbeef --chain main   <<<"signtx ${psbt_fixture}"

assert_error "invalid psbt base64"   "${MOCK_SIGNER}" --stdin --fingerprint deadbeef --chain regtest   <<<"signtx not-base64!"

bad_magic="$(
  python3 - <<'PY'
import base64
print(base64.b64encode(b"notpsbt").decode())
PY
)"
assert_error "invalid psbt magic"   "${MOCK_SIGNER}" --stdin --fingerprint deadbeef --chain regtest   <<<"signtx ${bad_magic}"

assert_error "mock signer intentionally refuses signing"   "${MOCK_SIGNER}" --stdin --fingerprint deadbeef --chain regtest   <<<"signtx ${psbt_fixture}"

echo "Bitcoin Core external signer contract test passed."
echo "signer_fingerprint=${fingerprint}"
echo "signer_model=${model:-gpubnb-ci-mock}"
echo "signing_behavior=fail_closed_no_fallback"
