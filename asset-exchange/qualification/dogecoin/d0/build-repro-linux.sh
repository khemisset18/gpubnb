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
DEPENDS_FALLBACK_URL="https://download.bitcoincashnode.org/depends-sources"
ZLIB_FOSSIL_URL="https://zlib.net/fossils/zlib-1.3.tar.gz"
ZLIB_SHA256="ff0ba4c292013dbc27530b3a81e1f9a813cd39de01ca5e0f8bf355702efa593e"
EXPAT_URL="https://github.com/libexpat/libexpat/releases/download/R_2_6_2/expat-2.6.2.tar.bz2"
EXPAT_SHA256="9c7c1b5dcbc3c237c500a8fb1493e14d9582146dd9b42aa8d3ffb856a3b927e0"
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
  echo "depends_fallback_url=$DEPENDS_FALLBACK_URL"
  echo "zlib_fossil_url=$ZLIB_FOSSIL_URL"
  echo "zlib_sha256=$ZLIB_SHA256"
  echo "expat_url=$EXPAT_URL"
  echo "expat_sha256=$EXPAT_SHA256"
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

collect_diagnostics() {
  local rc=$?
  set +e
  mkdir -p "$OUTPUT_DIR/diagnostics"
  for candidate in     "$WORK_DIR/gitian-builder/var/install.log"     "$WORK_DIR/gitian-builder/var/build.log"     "$WORK_DIR/gitian-builder/var/target.log"     "$WORK_DIR/gitian-builder/var/build-script"; do
    if [[ -f "$candidate" ]]; then
      cp "$candidate" "$OUTPUT_DIR/diagnostics/$(basename "$candidate")"
    fi
  done
  find "$WORK_DIR/gitian-builder/var" -maxdepth 1 -type f -name 'base-*.manifest' -exec cp '{}' "$OUTPUT_DIR/diagnostics/" \; 2>/dev/null || true
  find "$WORK_DIR/gitian-builder/result" -maxdepth 1 -type f -name '*.yml' -exec cp '{}' "$OUTPUT_DIR/diagnostics/" \; 2>/dev/null || true
  exit "$rc"
}
trap collect_diagnostics EXIT

mkdir -p "$WORK_DIR/gitian-builder/inputs"
curl --fail --location --proto '=https' --tlsv1.2 "$LIEF_URL" \
  --output "$WORK_DIR/gitian-builder/inputs/$(basename "$LIEF_URL")"
(
  cd "$WORK_DIR/gitian-builder/inputs"
  echo "$LIEF_SHA256  $(basename "$LIEF_URL")" | sha256sum --check --strict
)

mkdir -p "$WORK_DIR/gitian-builder/cache/common"
curl --fail --location --proto '=https' --tlsv1.2 "$ZLIB_FOSSIL_URL"   --output "$WORK_DIR/gitian-builder/cache/common/zlib-1.3.tar.gz"
(
  cd "$WORK_DIR/gitian-builder/cache/common"
  echo "$ZLIB_SHA256  zlib-1.3.tar.gz" | sha256sum --check --strict
)

curl --fail --location --proto '=https' --tlsv1.2 "$EXPAT_URL" \
  --output "$WORK_DIR/gitian-builder/cache/common/expat-2.6.2.tar.bz2"
(
  cd "$WORK_DIR/gitian-builder/cache/common"
  echo "$EXPAT_SHA256  expat-2.6.2.tar.bz2" | sha256sum --check --strict
)

cp "$WORK_DIR/dogecoin/contrib/gitian-descriptors/gitian-linux.yml" "$WORK_DIR/gitian-linux-upstream.yml"
sha256sum "$WORK_DIR/gitian-linux-upstream.yml" > "$OUTPUT_DIR/upstream-descriptor.sha256"

python3 - "$WORK_DIR/gitian-linux-upstream.yml" "$WORK_DIR/gitian-linux-reduced.yml" "$DEPENDS_FALLBACK_URL" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
reduced = source
fallback_url = sys.argv[3]

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

tz_line = '  export TZ="UTC"\n'
if tz_line not in reduced:
    raise SystemExit("expected TZ export missing from upstream descriptor")
reduced = reduced.replace(
    tz_line,
    tz_line + f'  export FALLBACK_DOWNLOAD_PATH="{fallback_url}"\n',
    1,
)

Path(sys.argv[2]).write_text(reduced)
PY

sha256sum "$WORK_DIR/gitian-linux-reduced.yml" > "$OUTPUT_DIR/reduced-descriptor.sha256"
cp "$WORK_DIR/gitian-linux-upstream.yml" "$OUTPUT_DIR/"
cp "$WORK_DIR/gitian-linux-reduced.yml" "$OUTPUT_DIR/"

CANONICAL_FOCAL_REF="public.ecr.aws/ubuntu/ubuntu:focal"
docker pull "$CANONICAL_FOCAL_REF"
UBUNTU_REPO_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$CANONICAL_FOCAL_REF")"
case "$UBUNTU_REPO_DIGEST" in
  public.ecr.aws/ubuntu/ubuntu@sha256:*) ;;
  *)
    echo "unexpected Canonical ECR RepoDigest: $UBUNTU_REPO_DIGEST" >&2
    exit 1
    ;;
esac
echo "ubuntu_focal_repo_digest=$UBUNTU_REPO_DIGEST" >> "$OUTPUT_DIR/environment.txt"

mkdir -p "$WORK_DIR/gitian-builder/docker"
cat > "$WORK_DIR/gitian-builder/docker/base-focal-amd64.Dockerfile" <<EOF
FROM $UBUNTU_REPO_DIGEST
ENV DEBIAN_FRONTEND=noninteractive
RUN echo 'Acquire::http { Proxy "http://172.17.0.1:3142"; };' > /etc/apt/apt.conf.d/50cacher
RUN apt-get update && apt-get --no-install-recommends -y install pciutils build-essential git subversion language-pack-en wget lsb-release sudo linux-image-generic grub-pc openssh-server
RUN useradd -ms /bin/bash -U ubuntu
USER ubuntu:ubuntu
WORKDIR /home/ubuntu
CMD ["sleep", "infinity"]
EOF

docker build   -f "$WORK_DIR/gitian-builder/docker/base-focal-amd64.Dockerfile"   -t base-focal-amd64   "$WORK_DIR/gitian-builder/docker"

docker image inspect base-focal-amd64 >/dev/null

if ! (
  cd "$WORK_DIR/gitian-builder"
  export USE_DOCKER=1
  ./bin/gbuild \
    -j "${D0_BUILD_JOBS:-2}" \
    -m "${D0_BUILD_MEMORY_MIB:-5000}" \
    --commit "dogecoin=$DOGE_SOURCE_COMMIT" \
    --url "dogecoin=$DOGE_REPOSITORY" \
    "$WORK_DIR/gitian-linux-reduced.yml"
); then
  echo "Gitian build failed; emitting bounded diagnostics." >&2
  for candidate in \
    "$WORK_DIR/gitian-builder/var/install.log" \
    "$WORK_DIR/gitian-builder/var/target.log" \
    "$WORK_DIR/gitian-builder/var/build.log"; do
    if [[ -f "$candidate" ]]; then
      echo "::group::$(basename "$candidate")" >&2
      tail -n 300 "$candidate" >&2 || true
      echo "::endgroup::" >&2
    fi
  done
  exit 1
fi

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

python3 - "$OUTPUT_DIR" "$DOGE_SOURCE_COMMIT" "$GITIAN_BUILDER_COMMIT" "$UBUNTU_REPO_DIGEST" "$ACTUAL_SHA256" "$OFFICIAL_X86_64_SHA256" "$DEPENDS_FALLBACK_URL" "$LIEF_SHA256" "$ZLIB_FOSSIL_URL" "$ZLIB_SHA256" "$EXPAT_URL" "$EXPAT_SHA256" <<'PY'
import json
from pathlib import Path
import sys

out, source, gitian, ubuntu_digest, actual, official, fallback_url, lief_sha256, zlib_url, zlib_sha256, expat_url, expat_sha256 = sys.argv[1:]
evidence = {
    "schema": "GPUBNB:DOGECOIN:D0-INTERNAL-BUILD-EVIDENCE:v1",
    "dogecoinSourceCommit": source,
    "gitianBuilderCommit": gitian,
    "ubuntuFocalRepoDigest": ubuntu_digest,
    "artifact": "dogecoin-1.14.9-x86_64-linux-gnu.tar.gz",
    "artifactSha256": actual,
    "officialObservedSha256": official,
    "officialHashMatch": actual == official,
    "dependsFallbackUrl": fallback_url,
    "liefInputSha256": lief_sha256,
    "zlibFossilUrl": zlib_url,
    "zlibInputSha256": zlib_sha256,
    "expatUrl": expat_url,
    "expatInputSha256": expat_sha256,
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
