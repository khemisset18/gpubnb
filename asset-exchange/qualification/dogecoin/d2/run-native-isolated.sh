#!/usr/bin/env bash
# Manual first-slice Dogecoin D2 native test on a fresh loopback-only Linux
# namespace. Never run from a PR/push trigger or on a public network.
set -euo pipefail
umask 077
SCOPE='AUTHORIZE_DOGE_D2_SYNTHETIC_SIGNING_AND_PRIVATE_REGTEST_ONLY'
ARCHIVE_SHA='4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8'
if [[ "$#" -ne 3 || "$3" != "$SCOPE" ]]; then
  echo "usage: $0 <verified-D0-evidence-dir> <new-empty-work-directory> $SCOPE" >&2
  exit 2
fi
[[ "$(uname -s)" == Linux ]] || { echo 'Linux namespace required' >&2; exit 2; }
for c in gh sudo unshare ip python3 node sha256sum readlink realpath; do command -v "$c" >/dev/null || { echo "Missing $c" >&2; exit 2; }; done
EVIDENCE_DIR="$(realpath -e "$1")"
NEW_WORK_DIR="$(realpath -m "$2")"
[[ ! -e "$NEW_WORK_DIR" ]] || { echo 'Work directory must not exist' >&2; exit 2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node)"
PARENT_NS="$(readlink /proc/self/ns/net)"
ARCHIVE="$EVIDENCE_DIR/dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"
[[ -f "$ARCHIVE" && -f "$EVIDENCE_DIR/provenance.sigstore.json" && -f "$EVIDENCE_DIR/sbom-attestation.sigstore.json" ]] || {
  echo 'Expected D0 archive and signed provenance/SPDX bundles required' >&2; exit 2;
}
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE" | sha256sum --check --strict
mkdir -m 700 "$NEW_WORK_DIR"
mkdir -m 700 "$NEW_WORK_DIR/verification"
mkdir -m 700 "$NEW_WORK_DIR/verified-bin"

VERIFY_FLAGS=(
  --repo khemisset18/gpubnb
  --signer-workflow khemisset18/gpubnb/.github/workflows/asset-exchange-dogecoin-d0-repro.yml
  --signer-digest 99724d5b66b9475dcb96f6c471c75ce01ed60f9a
  --source-digest 99724d5b66b9475dcb96f6c471c75ce01ed60f9a
  --source-ref refs/heads/asset-exchange/doge-d0-cohort-validation-20261029
  --deny-self-hosted-runners --format json
)
gh attestation verify "$ARCHIVE" --bundle "$EVIDENCE_DIR/provenance.sigstore.json" \
  "${VERIFY_FLAGS[@]}" > "$NEW_WORK_DIR/verification/provenance.json"
gh attestation verify "$ARCHIVE" --bundle "$EVIDENCE_DIR/sbom-attestation.sigstore.json" \
  --predicate-type https://spdx.dev/Document/v2.3 "${VERIFY_FLAGS[@]}" \
  > "$NEW_WORK_DIR/verification/spdx.json"

# The known archive is signed and hash-pinned. Extract ONLY the expected
# executable regular file; no symlinks, traversal, or untrusted tar paths.
python3 - "$ARCHIVE" "$NEW_WORK_DIR/verified-bin/dogecoind" <<'PY'
import os, pathlib, shutil, sys, tarfile
archive, target = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tar:
    member = tar.getmember('dogecoin-1.14.9/bin/dogecoind')
    if not member.isfile() or member.size < 1000000 or member.size > 150000000:
        raise SystemExit('expected regular Dogecoin executable not present')
    source = tar.extractfile(member)
    if source is None:
        raise SystemExit('expected Dogecoin member cannot be read')
    with open(target, 'xb') as output:
        shutil.copyfileobj(source, output)
os.chmod(target, 0o700)
PY
sha256sum "$NEW_WORK_DIR/verified-bin/dogecoind" > "$NEW_WORK_DIR/verification/dogecoind.sha256"

# The only native financial operations below are synthetic private Regtest.
# Keep Node and dogecoind within the new network namespace. The runner itself
# enforces a different netns, only loopback interface and no routing table.
STATUS=0
sudo unshare --net -- /bin/bash -c '
  set -euo pipefail
  ip link set lo up
  ulimit -t 600 -f 1048576
  exec /usr/bin/env -i \
    PATH="$(dirname "$1"):/usr/bin:/bin" \
    AE_D2_NATIVE_SCOPE="$2" \
    AE_D0_VERIFIED_ARCHIVE_SHA256="$3" \
    AE_PARENT_NET_NS="$4" \
    "$1" --max-old-space-size=256 "$5" "$2" "$6" "$7"
' d2 "$NODE_BIN" "$SCOPE" "$ARCHIVE_SHA" "$PARENT_NS" \
  "$SCRIPT_DIR/native-regtest.mjs" "$NEW_WORK_DIR/verified-bin/dogecoind" \
  "$NEW_WORK_DIR/verification/native-first-slice.json" || STATUS=$?

# Only public JSON/verification hashes are returned to the caller. The native
# runner destroys its private dogecoind datadir and transient test signers.
if sudo test -f "$NEW_WORK_DIR/verification/native-first-slice.json"; then
  sudo chown "$(id -u):$(id -g)" "$NEW_WORK_DIR/verification/native-first-slice.json"
  sha256sum "$NEW_WORK_DIR/verification/native-first-slice.json" \
    > "$NEW_WORK_DIR/verification/native-first-slice.sha256"
fi
exit "$STATUS"
