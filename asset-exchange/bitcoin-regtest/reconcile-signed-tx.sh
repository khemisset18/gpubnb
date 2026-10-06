#!/usr/bin/env bash
set -euo pipefail

: "${BITCOIN_BIN_DIR:?BITCOIN_BIN_DIR required}"
: "${BITCOIN_REGTEST_DATADIR:?BITCOIN_REGTEST_DATADIR required}"

raw_file="${1:?signed raw transaction file required}"
if [[ ! -f "${raw_file}" ]]; then
  echo "ERROR: raw transaction recovery file missing" >&2
  exit 2
fi

raw_hex="$(tr -d '\r\n ' < "${raw_file}")"
if [[ ! "${raw_hex}" =~ ^[0-9a-fA-F]+$ ]]; then
  echo "ERROR: recovery file is not raw transaction hex" >&2
  exit 2
fi

CLI=("${BITCOIN_BIN_DIR}/bitcoin-cli" -regtest -datadir="${BITCOIN_REGTEST_DATADIR}")
decoded="$("${CLI[@]}" decoderawtransaction "${raw_hex}")"
txid="$(printf '%s' "${decoded}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["txid"])')"

if "${CLI[@]}" getmempoolentry "${txid}" >/dev/null 2>&1; then
  rebroadcast="$("${CLI[@]}" sendrawtransaction "${raw_hex}")"
  if [[ "${rebroadcast}" != "${txid}" ]]; then
    echo "ERROR: idempotent mempool rebroadcast returned different txid" >&2
    exit 3
  fi
  echo "MEMPOOL:${txid}"
  exit 0
fi

set +e
chain_json="$("${CLI[@]}" getrawtransaction "${txid}" true 2>/dev/null)"
chain_status=$?
set -e
if [[ "${chain_status}" -eq 0 ]]; then
  confirmations="$(printf '%s' "${chain_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("confirmations",0))')"
  if (( confirmations > 0 )); then
    echo "CONFIRMED:${txid}"
    exit 0
  fi
fi

probe="$("${CLI[@]}" testmempoolaccept "[\"${raw_hex}\"]")"
allowed="$(printf '%s' "${probe}" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)[0]["allowed"] else "no")')"
if [[ "${allowed}" != "yes" ]]; then
  echo "ERROR: recovery transaction is neither known nor currently relayable" >&2
  printf '%s\n' "${probe}" >&2
  exit 4
fi

broadcast="$("${CLI[@]}" sendrawtransaction "${raw_hex}")"
if [[ "${broadcast}" != "${txid}" ]]; then
  echo "ERROR: broadcast returned different txid" >&2
  exit 5
fi
echo "BROADCAST:${txid}"
