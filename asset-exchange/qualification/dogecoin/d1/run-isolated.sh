#!/usr/bin/env bash
# PREPARED ONLY: distinct user authorization is required before invoking this.
set -euo pipefail
umask 077
if [[ "$#" -ne 3 || "$3" != AUTHORIZE_D1_ISOLATED_REGTEST ]]; then
  echo 'usage: run-isolated.sh <verified-D0-dir> <new-work-dir> AUTHORIZE_D1_ISOLATED_REGTEST' >&2
  exit 2
fi
test "$(uname -s)" = Linux
EVIDENCE_DIR="$(realpath -e "$1")"
D1_WORK_DIR="$(realpath -m "$2")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$(command -v python3)"
PARENT_NET_NS="$(readlink /proc/self/ns/net)"
test ! -e "$D1_WORK_DIR"
for command in gh unshare ip sudo; do command -v "$command" >/dev/null; done
mkdir -m 700 "$D1_WORK_DIR"
mkdir -m 700 "$D1_WORK_DIR/verification"
retain_public_evidence() {
  local status=$?
  trap - EXIT
  if [[ -d "$D1_WORK_DIR/regtest-run/evidence" ]]; then
    # The node namespace runs as root. Return only public evidence ownership to
    # the caller; data, cookies and executable copies remain private to root.
    sudo chown "$(id -u):$(id -g)" "$D1_WORK_DIR/regtest-run"
    sudo chown -R "$(id -u):$(id -g)" "$D1_WORK_DIR/regtest-run/evidence"
  fi
  exit "$status"
}
trap retain_public_evidence EXIT
VERIFY_FLAGS=(
  --repo khemisset18/gpubnb
  --signer-workflow khemisset18/gpubnb/.github/workflows/asset-exchange-dogecoin-d0-repro.yml
  --signer-digest 99724d5b66b9475dcb96f6c471c75ce01ed60f9a
  --source-digest 99724d5b66b9475dcb96f6c471c75ce01ed60f9a
  --source-ref refs/heads/asset-exchange/doge-d0-cohort-validation-20261029
  --deny-self-hosted-runners --format json
)
gh attestation verify "$EVIDENCE_DIR/dogecoin-1.14.9-x86_64-linux-gnu.tar.gz" \
  --bundle "$EVIDENCE_DIR/provenance.sigstore.json" "${VERIFY_FLAGS[@]}" \
  > "$D1_WORK_DIR/verification/provenance.json"
gh attestation verify "$EVIDENCE_DIR/dogecoin-1.14.9-x86_64-linux-gnu.tar.gz" \
  --bundle "$EVIDENCE_DIR/sbom-attestation.sigstore.json" \
  --predicate-type https://spdx.dev/Document/v2.3 "${VERIFY_FLAGS[@]}" \
  > "$D1_WORK_DIR/verification/sbom.json"
# No Dogecoin process exists before this network-isolation boundary.
sudo unshare --net -- /bin/bash -c '
  set -euo pipefail
  ip link set lo up
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"
' d1 "$PYTHON_BIN" "$SCRIPT_DIR/network_identity.py" \
  --evidence "$EVIDENCE_DIR" --verification "$D1_WORK_DIR/verification" \
  --work "$D1_WORK_DIR/regtest-run" --authorization "$3" --parent-net-ns "$PARENT_NET_NS"
