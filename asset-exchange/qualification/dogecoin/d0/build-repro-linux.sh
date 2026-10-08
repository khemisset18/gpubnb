#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: build-repro-linux.sh <work-dir> <output-dir>" >&2
  exit 2
fi

WORK_DIR="$(realpath -m "$1")"
OUTPUT_DIR="$(realpath -m "$2")"

DOGE_SOURCE_COMMIT="e0a1c157791544e818c901bd9341896965afbf9d"
DOGE_REPOSITORY="https://github.com/dogecoin/dogecoin.git"
GITIAN_BUILDER_COMMIT="41c325d2f14147e8028fce9a5edd26e7adad30a4"
GITIAN_BUILDER_REPOSITORY="https://github.com/devrandom/gitian-builder.git"
LIEF_URL="https://files.pythonhosted.org/packages/3a/cf/a6ddb755d7f38cd69ca1dd8d7720963cd2f9ff0b15ec9e5ae175910add51/lief-0.12.3-cp38-cp38-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
LIEF_SHA256="c848aadac0816268aeb9dde7cefdb54bf24f78e664a19e97e74c92d3be1bb147"
OFFICIAL_X86_64_SHA256="4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
OUTPUT_NAME="dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"

rm -rf "$WORK_DIR" "$OUTPUT_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"

{
  echo "dogecoin_source_commit=$DOGE_SOURCE_COMMIT"
  echo "gitian_builder_commit=$GITIAN_BUILDER_COMMIT"
  echo "official_x86_64_sha256=$OFFICIAL_X86_64_SHA256"
  echo "runner_kernel=$(uname -srmo)"
  echo "runner_arch=$(uname -m)"
  echo "docker_version=$(docker --version)"
} > "$OUTPUT_DIR/environment.txt"

git clone --filter=blob:none --no-checkout "$DOGE_REPOSITORY" "$WORK_DIR/dogecoin"
git -C "$WORK_DIR/dogecoin" checkout --detach "$DOGE_SOURCE_COMMIT"
test "$(git -C "$WORK_DIR/dogecoin" rev-parse HEAD)" = "$DOGE_SOURCE_COMMIT"
if [[ -n "$(git -C "$WORK_DIR/dogecoin" status --porcelain=v1 --untracked-files=no)" ]]; then
  echo "unexpected dirty Dogecoin checkout" >&2
  exit 1
fi

git clone --filter=blob:none --no-checkout "$GITIAN_BUILDER_REPOSITORY" "$WORK_DIR/gitian-builder"
git -C "$WORK_DIR/gitian-builder" checkout --detach "$GITIAN_BUILDER_COMMIT"
test "$(git -C "$WORK_DIR/gitian-builder" rev-parse HEAD)" = "$GITIAN_BUILDER_COMMIT"

mkdir -p "$WORK_DIR/gitian-builder/inputs"
curl --fail --location --proto '=https' --tlsv1.2 "$LIEF_URL" \
  --output "$WORK_DIR/gitian-builder/inputs/$(basename "$LIEF_URL")"
(
  cd "$WORK_DIR/gitian-builder/inputs"
  echo "$LIEF_SHA256  $(basename "$LIEF_URL")" | sha256sum --check --strict
)

cp "$WORK_DIR/dogecoin/contrib/gitian-descriptors/gitian-linux.yml" "$WORK_DIR/gitian-linux-upstream.yml"
sha256sum "$WORK_DIR/gitian-linux-upstream.yml" > "$OUTPUT_DIR/upstream-descriptor.sha256"

python3 - "$WORK_DIR/gitian-linux-upstream.yml" "$WORK_DIR/gitian-linux-reduced.yml" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
reduced = source

old_hosts = 'HOSTS="i686-pc-linux-gnu x86_64-linux-gnu arm-linux-gnueabihf aarch64-linux-gnu"'
new_hosts = 'HOSTS="i686-pc-linux-gnu x86_64-linux-gnu"'
if old_hosts not in reduced:
    raise SystemExit("expected upstream HOSTS declaration missing")
reduced = reduced.replace(old_hosts, new_hosts, 1)

for line in [
    '- "g++-aarch64-linux-gnu"\n',
    '- "g++-9-aarch64-linux-gnu"\n',
    '- "gcc-9-aarch64-linux-gnu"\n',
    '- "binutils-aarch64-linux-gnu"\n',
    '- "g++-arm-linux-gnueabihf"\n',
    '- "g++-9-arm-linux-gnueabihf"\n',
    '- "gcc-9-arm-linux-gnueabihf"\n',
    '- "binutils-arm-linux-gnueabihf"\n',
]:
    if line not in reduced:
        raise SystemExit(f"expected upstream package line missing: {line.strip()}")
    reduced = reduced.replace(line, "", 1)

Path(sys.argv[2]).write_text(reduced)
PY

sha256sum "$WORK_DIR/gitian-linux-reduced.yml" > "$OUTPUT_DIR/reduced-descriptor.sha256"
cp "$WORK_DIR/gitian-linux-upstream.yml" "$OUTPUT_DIR/"
cp "$WORK_DIR/gitian-linux-reduced.yml" "$OUTPUT_DIR/"

docker pull ubuntu:focal
UBUNTU_REPO_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' ubuntu:focal)"
case "$UBUNTU_REPO_DIGEST" in
  ubuntu@sha256:*) ;;
  *)
    echo "unexpected ubuntu:focal RepoDigest: $UBUNTU_REPO_DIGEST" >&2
    exit 1
    ;;
esac
UBUNTU_DIGEST="${UBUNTU_REPO_DIGEST#ubuntu@sha256:}"
echo "ubuntu_focal_repo_digest=$UBUNTU_REPO_DIGEST" >> "$OUTPUT_DIR/environment.txt"

(
  cd "$WORK_DIR/gitian-builder"
  export MIRROR_HOST=172.17.0.1
  ./bin/make-base-vm --suite focal --arch amd64 --docker --docker-image-digest "$UBUNTU_DIGEST"
)

(
  cd "$WORK_DIR/gitian-builder"
  export USE_DOCKER=1
  ./bin/gbuild \
    -j "${D0_BUILD_JOBS:-2}" \
    -m "${D0_BUILD_MEMORY_MIB:-5000}" \
    --commit "dogecoin=$DOGE_SOURCE_COMMIT" \
    --url "dogecoin=$DOGE_REPOSITORY" \
    "$WORK_DIR/gitian-linux-reduced.yml"
)

BUILT="$(find "$WORK_DIR/gitian-builder/build/out" -maxdepth 1 -type f -name "$OUTPUT_NAME" -print -quit)"
if [[ -z "$BUILT" || ! -f "$BUILT" ]]; then
  echo "expected x86_64 release archive missing" >&2
  find "$WORK_DIR/gitian-builder/build/out" -maxdepth 2 -type f -print >&2 || true
  exit 1
fi

cp "$BUILT" "$OUTPUT_DIR/$OUTPUT_NAME"
cp "$WORK_DIR/gitian-builder/result/"*.yml "$OUTPUT_DIR/" 2>/dev/null || true

ACTUAL_SHA256="$(sha256sum "$OUTPUT_DIR/$OUTPUT_NAME" | awk '{print $1}')"
printf '%s  %s\n' "$ACTUAL_SHA256" "$OUTPUT_NAME" > "$OUTPUT_DIR/SHA256SUMS"

python3 - "$OUTPUT_DIR" "$DOGE_SOURCE_COMMIT" "$GITIAN_BUILDER_COMMIT" "$UBUNTU_REPO_DIGEST" "$ACTUAL_SHA256" "$OFFICIAL_X86_64_SHA256" <<'PY'
import json
from pathlib import Path
import sys

out, source, gitian, ubuntu_digest, actual, official = sys.argv[1:]
evidence = {
    "schema": "GPUBNB:DOGECOIN:D0-INTERNAL-BUILD-EVIDENCE:v1",
    "dogecoinSourceCommit": source,
    "gitianBuilderCommit": gitian,
    "ubuntuFocalRepoDigest": ubuntu_digest,
    "artifact": "dogecoin-1.14.9-x86_64-linux-gnu.tar.gz",
    "artifactSha256": actual,
    "officialObservedSha256": official,
    "officialHashMatch": actual == official,
    "binaryExecuted": False,
    "mainnetUsed": False,
    "realFundsUsed": False,
}
Path(out, "evidence.json").write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
PY

if [[ "$ACTUAL_SHA256" != "$OFFICIAL_X86_64_SHA256" ]]; then
  echo "reproduced archive hash does not match observed official release hash" >&2
  exit 1
fi

echo "Dogecoin D0 internal build reproduced observed x86_64 release hash."
