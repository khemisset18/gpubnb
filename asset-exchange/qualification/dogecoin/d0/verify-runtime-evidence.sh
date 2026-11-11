#!/usr/bin/env bash
# Verify the preserved D0/D1 handoff only. This helper never loads Dogecoin.
set -euo pipefail
umask 077
if [[ "$#" -ne 2 ]]; then
  echo 'usage: verify-runtime-evidence.sh <verified-D0-dir> <new-verification-dir>' >&2
  exit 2
fi
EVIDENCE_DIR="$(realpath -e "$1")"
VERIFY_DIR="$(realpath -m "$2")"
PYTHON_BIN="$(command -v python3)"
test ! -e "$VERIFY_DIR"
mkdir -m 700 "$VERIFY_DIR"
gh api repos/khemisset18/gpubnb/actions/runs/40866305437 > "$VERIFY_DIR/d0-run.json"
"$PYTHON_BIN" - "$VERIFY_DIR/d0-run.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['id'] == 40866305437 and r['run_attempt'] == 1
assert r['status'] == 'completed' and r['conclusion'] == 'success'
assert r['head_sha'] == '99724d5b66b9475dcb96f6c471c75ce01ed60f9a'
assert r['repository']['id'] == 1305325878 and r['repository']['owner']['id'] == 103233875
PY
# Revalidate the preserved D1 success identity; do not re-execute D1.
gh api repos/khemisset18/gpubnb/actions/runs/40892872892 > "$VERIFY_DIR/d1-run.json"
"$PYTHON_BIN" - "$VERIFY_DIR/d1-run.json" <<'PY_D1'
import json, sys
r = json.load(open(sys.argv[1]))
assert r['id'] == 40892872892 and r['run_attempt'] == 1
assert r['status'] == 'completed' and r['conclusion'] == 'success'
assert r['head_sha'] == '1636df354d4fafd2cc2d9ab8595f4dca52582ad7'
assert r['repository']['id'] == 1305325878 and r['repository']['owner']['id'] == 103233875
PY_D1
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
  > "$VERIFY_DIR/provenance.json"
gh attestation verify "$EVIDENCE_DIR/dogecoin-1.14.9-x86_64-linux-gnu.tar.gz" \
  --bundle "$EVIDENCE_DIR/sbom-attestation.sigstore.json" \
  --predicate-type https://spdx.dev/Document/v2.3 "${VERIFY_FLAGS[@]}" \
  > "$VERIFY_DIR/sbom.json"
