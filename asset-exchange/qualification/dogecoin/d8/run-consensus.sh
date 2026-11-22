#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "$#" -ne 5 || "$3" != AUTHORIZE_D8_PRIVATE_BROKER_CONSENSUS_REGTEST ]]; then
  echo 'usage: run-consensus.sh <verified-D0-dir> <new-work-dir> AUTHORIZE_D8_PRIVATE_BROKER_CONSENSUS_REGTEST <execution-commit> <harness-commit>' >&2
  exit 2
fi
[[ "$4" =~ ^[0-9a-f]{40}$ && "$5" =~ ^[0-9a-f]{40}$ ]]
test "$(uname -s)" = Linux
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(realpath -e "$SCRIPT_DIR/../../../..")"
test "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$4"
git -C "$REPO_ROOT" diff --exit-code "$5" HEAD -- \
  asset-exchange/qualification/dogecoin/ asset-exchange/wallet-agent/dogecoin/ asset-exchange/recovery/dogecoin/
git -C "$REPO_ROOT" diff --exit-code HEAD -- \
  asset-exchange/qualification/dogecoin/ asset-exchange/wallet-agent/dogecoin/ asset-exchange/recovery/dogecoin/
test -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard -- \
  asset-exchange/qualification/dogecoin/ asset-exchange/wallet-agent/dogecoin/ asset-exchange/recovery/dogecoin/)"
EVIDENCE_DIR="$(realpath -e "$1")"
LAB_WORK_DIR="$(realpath -m "$2")"
PYTHON_BIN="$(command -v python3)"
PARENT_NET_NS="$(readlink /proc/self/ns/net)"
test ! -e "$LAB_WORK_DIR"
for command in gh unshare ip sudo; do command -v "$command" >/dev/null; done
mkdir -m 700 "$LAB_WORK_DIR"
retain_public_evidence() {
  local status=$?
  trap - EXIT
  # These two paths can only hold disposable fixture keys, never user keys.
  sudo rm -f "$LAB_WORK_DIR/lab/keys/claim.pem" "$LAB_WORK_DIR/lab/keys/refund.pem"
  if sudo test -d "$LAB_WORK_DIR/lab/evidence"; then
    sudo chown "$(id -u):$(id -g)" "$LAB_WORK_DIR/lab"
    sudo chown -R "$(id -u):$(id -g)" "$LAB_WORK_DIR/lab/evidence"
  fi
  exit "$status"
}
trap retain_public_evidence EXIT
# Existing verification-only helper: verifies old D0/D1 evidence, runs no node.
bash "$SCRIPT_DIR/../d0/verify-runtime-evidence.sh" "$EVIDENCE_DIR" "$LAB_WORK_DIR/verification"
"$PYTHON_BIN" -B "$SCRIPT_DIR/broker_consensus.py" --manifest > "$LAB_WORK_DIR/verification/effective-manifest.json"
sudo unshare --net -- /bin/bash -c '
  set -euo pipefail
  ip link set lo up
  ulimit -t 90 -v 1048576 -f 65536
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"
' d8 "$PYTHON_BIN" -B "$SCRIPT_DIR/broker_consensus.py" \
  --evidence "$EVIDENCE_DIR" --verification "$LAB_WORK_DIR/verification" \
  --work "$LAB_WORK_DIR/lab" --authorization "$3" --parent-net-ns "$PARENT_NET_NS" \
  --execution-commit "$4" --harness-commit "$5"
