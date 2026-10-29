#!/usr/bin/env bash
# Distinct user authorization is required before invoking this.
set -euo pipefail
umask 077
if [[ "$#" -ne 3 || "$3" != AUTHORIZE_D2_SCRIPT_DIAGNOSTICS ]]; then
  echo 'usage: run-isolated.sh <verified-D0-dir> <new-work-dir> AUTHORIZE_D2_SCRIPT_DIAGNOSTICS' >&2
  exit 2
fi
test "$(uname -s)" = Linux
EVIDENCE_DIR="$(realpath -e "$1")"
D2_WORK_DIR="$(realpath -m "$2")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$(command -v python3)"
PARENT_NET_NS="$(readlink /proc/self/ns/net)"
test ! -e "$D2_WORK_DIR"
for command in gh unshare ip sudo; do command -v "$command" >/dev/null; done
mkdir -m 700 "$D2_WORK_DIR"
mkdir -m 700 "$D2_WORK_DIR/verification"
retain_public_evidence() {
  local status=$?
  trap - EXIT
  # The caller cannot traverse the root-owned 0700 regtest directory yet.
  # Test as root before returning ownership of public evidence only.
  if sudo test -d "$D2_WORK_DIR/regtest-run/evidence"; then
    # The node namespace runs as root. Return only public evidence ownership to
    # the caller; data, cookies and executable copies remain private to root.
    sudo chown "$(id -u):$(id -g)" "$D2_WORK_DIR/regtest-run"
    sudo chown -R "$(id -u):$(id -g)" "$D2_WORK_DIR/regtest-run/evidence"
  fi
  exit "$status"
}
trap retain_public_evidence EXIT
gh api repos/khemisset18/gpubnb/actions/runs/40866305437 > "$D2_WORK_DIR/verification/d0-run.json"
"$PYTHON_BIN" - "$D2_WORK_DIR/verification/d0-run.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['id'] == 40866305437 and r['run_attempt'] == 1
assert r['status'] == 'completed' and r['conclusion'] == 'success'
assert r['head_sha'] == '99724d5b66b9475dcb96f6c471c75ce01ed60f9a'
assert r['repository']['id'] == 1305325878 and r['repository']['owner']['id'] == 103233875
PY
# Revalidate the preserved D1 success identity; do not re-execute D1.
gh api repos/khemisset18/gpubnb/actions/runs/40892872892 > "$D2_WORK_DIR/verification/d1-run.json"
"$PYTHON_BIN" - "$D2_WORK_DIR/verification/d1-run.json" <<'PY_D1'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['id'] == 40892872892 and r['run_attempt'] == 1
assert r['status'] == 'completed' and r['conclusion'] == 'success'
assert r['head_sha'] == '1636df354d4fafd2cc2d9ab8595f4dca52582ad7'
assert r['repository']['id'] == 1305325878 and r['repository']['owner']['id'] == 103233875
PY_D1
# Publish the exact operations before any Dogecoin executable/library is loaded.
"$PYTHON_BIN" "$SCRIPT_DIR/script_diagnostics.py" --manifest > "$D2_WORK_DIR/verification/effective-manifest.json"
cat "$D2_WORK_DIR/verification/effective-manifest.json"
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
  > "$D2_WORK_DIR/verification/provenance.json"
gh attestation verify "$EVIDENCE_DIR/dogecoin-1.14.9-x86_64-linux-gnu.tar.gz" \
  --bundle "$EVIDENCE_DIR/sbom-attestation.sigstore.json" \
  --predicate-type https://spdx.dev/Document/v2.3 "${VERIFY_FLAGS[@]}" \
  > "$D2_WORK_DIR/verification/sbom.json"
# No Dogecoin process exists before this network-isolation boundary.
sudo unshare --net -- /bin/bash -c '
  set -euo pipefail
  ip link set lo up
  ulimit -t 420 -v 2097152 -f 1048576
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"
' d2 "$PYTHON_BIN" "$SCRIPT_DIR/script_diagnostics.py" \
  --evidence "$EVIDENCE_DIR" --verification "$D2_WORK_DIR/verification" \
  --work "$D2_WORK_DIR/regtest-run" --authorization "$3" --parent-net-ns "$PARENT_NET_NS"
