#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ ( "$#" -ne 3 && "$#" -ne 4 && "$#" -ne 6 ) || "$3" != AUTHORIZE_D6_PRIVATE_MULTINODE_REGTEST ]]; then
  echo 'usage: run-multinode.sh <verified-D0-dir> <new-work-dir> AUTHORIZE_D6_PRIVATE_MULTINODE_REGTEST [suite [handoff-dir handoff-sha256]]' >&2
  exit 2
fi
LAB_SUITE="${4:-multinode}"
[[ "$LAB_SUITE" == multinode || "$LAB_SUITE" == fee-pinning || "$LAB_SUITE" == recovery-handoff || "$LAB_SUITE" == recovery-independent || "$LAB_SUITE" == recovery-resume || "$LAB_SUITE" == auxpow-expanded || "$LAB_SUITE" == recovery-funding-reorg ]]
EXTRA_ARGUMENTS=()
if [[ "$LAB_SUITE" == recovery-* || "$LAB_SUITE" == auxpow-expanded ]]; then
  [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
  EXTRA_ARGUMENTS+=(--execution-commit "$GITHUB_SHA")
fi
if [[ "$LAB_SUITE" == recovery-independent || "$LAB_SUITE" == recovery-resume || "$LAB_SUITE" == auxpow-expanded || "$LAB_SUITE" == recovery-funding-reorg ]]; then
  [[ "$#" -eq 6 && "$6" =~ ^[0-9a-f]{64}$ ]]
  EXTRA_ARGUMENTS+=(--handoff-directory "$(realpath -e "$5")" --handoff-sha256 "$6")
else
  [[ "$#" -ne 6 ]]
fi
test "$(uname -s)" = Linux
EVIDENCE_DIR="$(realpath -e "$1")"
LAB_WORK_DIR="$(realpath -m "$2")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$(command -v python3)"
PARENT_NET_NS="$(readlink /proc/self/ns/net)"
test ! -e "$LAB_WORK_DIR"
for command in gh unshare ip sudo; do command -v "$command" >/dev/null; done
mkdir -m 700 "$LAB_WORK_DIR"
retain_public_evidence() {
  local status=$?
  trap - EXIT
  if sudo test -d "$LAB_WORK_DIR/lab/evidence"; then
    sudo chown "$(id -u):$(id -g)" "$LAB_WORK_DIR/lab"
    sudo chown -R "$(id -u):$(id -g)" "$LAB_WORK_DIR/lab/evidence"
  fi
  if sudo test -d "$LAB_WORK_DIR/lab/handoff"; then
    sudo chown -R "$(id -u):$(id -g)" "$LAB_WORK_DIR/lab/handoff"
  fi
  exit "$status"
}
trap retain_public_evidence EXIT
bash "$SCRIPT_DIR/../d0/verify-runtime-evidence.sh" "$EVIDENCE_DIR" "$LAB_WORK_DIR/verification"
"$PYTHON_BIN" -B "$SCRIPT_DIR/multinode.py" --manifest --lab-suite "$LAB_SUITE" > "$LAB_WORK_DIR/verification/effective-manifest.json"
sudo unshare --net -- /bin/bash -c '
  set -euo pipefail
  ip link set lo up
  ulimit -t 600 -v 2097152 -f 1048576
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"
' d6 "$PYTHON_BIN" -B "$SCRIPT_DIR/multinode.py" \
  --evidence "$EVIDENCE_DIR" --verification "$LAB_WORK_DIR/verification" \
  --work "$LAB_WORK_DIR/lab" --authorization "$3" --parent-net-ns "$PARENT_NET_NS" --lab-suite "$LAB_SUITE" "${EXTRA_ARGUMENTS[@]}"
