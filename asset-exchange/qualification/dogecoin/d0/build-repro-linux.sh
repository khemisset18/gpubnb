#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: build-repro-linux.sh <work-dir> <output-dir>" >&2
  exit 2
fi

WORK_DIR="$(realpath -m "$1")"
OUTPUT_DIR="$(realpath -m "$2")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
FOCAL_SNAPSHOT_ID="20241212T000000Z"
FOCAL_SNAPSHOT_URL="https://snapshot.ubuntu.com/ubuntu/$FOCAL_SNAPSHOT_ID"
OFFICIAL_FOCAL_MANIFEST_A="$SCRIPT_DIR/official-focal-amd64-KunNw0n.manifest"
OFFICIAL_FOCAL_MANIFEST_B="$SCRIPT_DIR/official-focal-amd64-slightlyskepticalpotat.manifest"
test -f "$OFFICIAL_FOCAL_MANIFEST_A"
test -f "$OFFICIAL_FOCAL_MANIFEST_B"

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
  echo "focal_snapshot_id=$FOCAL_SNAPSHOT_ID"
  echo "focal_snapshot_url=$FOCAL_SNAPSHOT_URL"
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
curl --fail --location --proto '=https' --tlsv1.2 --retry 4 --retry-all-errors --retry-delay 2 "$LIEF_URL" \
  --output "$WORK_DIR/gitian-builder/inputs/$(basename "$LIEF_URL")"
(
  cd "$WORK_DIR/gitian-builder/inputs"
  echo "$LIEF_SHA256  $(basename "$LIEF_URL")" | sha256sum --check --strict
)

mkdir -p "$WORK_DIR/gitian-builder/cache/common"
curl --fail --location --proto '=https' --tlsv1.2 --retry 4 --retry-all-errors --retry-delay 2 "$ZLIB_FOSSIL_URL"   --output "$WORK_DIR/gitian-builder/cache/common/zlib-1.3.tar.gz"
(
  cd "$WORK_DIR/gitian-builder/cache/common"
  echo "$ZLIB_SHA256  zlib-1.3.tar.gz" | sha256sum --check --strict
)

curl --fail --location --proto '=https' --tlsv1.2 --retry 4 --retry-all-errors --retry-delay 2 "$EXPAT_URL" \
  --output "$WORK_DIR/gitian-builder/cache/common/expat-2.6.2.tar.bz2"
(
  cd "$WORK_DIR/gitian-builder/cache/common"
  echo "$EXPAT_SHA256  expat-2.6.2.tar.bz2" | sha256sum --check --strict
)

UPSTREAM_DESCRIPTOR="$WORK_DIR/dogecoin/contrib/gitian-descriptors/gitian-linux.yml"
UPSTREAM_DESCRIPTOR_BLOB="$(git -C "$WORK_DIR/dogecoin" rev-parse "$DOGE_SOURCE_COMMIT:contrib/gitian-descriptors/gitian-linux.yml")"
test "$(git hash-object "$UPSTREAM_DESCRIPTOR")" = "$UPSTREAM_DESCRIPTOR_BLOB"
UPSTREAM_DESCRIPTOR_SHA256="$(sha256sum "$UPSTREAM_DESCRIPTOR" | awk '{print $1}')"
printf '%s  %s\n' "$UPSTREAM_DESCRIPTOR_SHA256" "contrib/gitian-descriptors/gitian-linux.yml" > "$OUTPUT_DIR/upstream-descriptor.sha256"
cp "$UPSTREAM_DESCRIPTOR" "$OUTPUT_DIR/gitian-linux-upstream.yml"

download_depends_for_host() {
  local host="$1"
  local attempt
  for attempt in 1 2 3; do
    if make -C "$WORK_DIR/dogecoin/depends" -s download-one \
      HOST="$host" \
      SOURCES_PATH="$WORK_DIR/gitian-builder/cache/common" \
      FALLBACK_DOWNLOAD_PATH="$DEPENDS_FALLBACK_URL"; then
      return 0
    fi
    echo "depends prefetch failed for $host (attempt $attempt/3)" >&2
    sleep 2
  done
  return 1
}

for host in i686-pc-linux-gnu x86_64-linux-gnu arm-linux-gnueabihf aarch64-linux-gnu; do
  download_depends_for_host "$host"
done

(
  cd "$WORK_DIR/gitian-builder/cache/common"
  find . -maxdepth 1 -type f -printf '%P\0' \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) > "$OUTPUT_DIR/depends-source-cache.SHA256SUMS"
DEPENDS_CACHE_MANIFEST_SHA256="$(sha256sum "$OUTPUT_DIR/depends-source-cache.SHA256SUMS" | awk '{print $1}')"
DEPENDS_CACHE_FILE_COUNT="$(wc -l < "$OUTPUT_DIR/depends-source-cache.SHA256SUMS" | tr -d ' ')"
test "$DEPENDS_CACHE_FILE_COUNT" -gt 0

FOCAL_ROOTFS="$WORK_DIR/focal-rootfs"
sudo rm -rf "$FOCAL_ROOTFS"
sudo debootstrap \
  --variant=minbase \
  --arch=amd64 \
  --include=ca-certificates \
  focal \
  "$FOCAL_ROOTFS" \
  "$FOCAL_SNAPSHOT_URL"

sudo tee "$FOCAL_ROOTFS/etc/apt/sources.list" >/dev/null <<EOF
deb $FOCAL_SNAPSHOT_URL focal main restricted universe multiverse
deb $FOCAL_SNAPSHOT_URL focal-updates main restricted universe multiverse
deb $FOCAL_SNAPSHOT_URL focal-backports main restricted universe multiverse
deb $FOCAL_SNAPSHOT_URL focal-security main restricted universe multiverse
EOF
sudo tee "$FOCAL_ROOTFS/etc/apt/apt.conf.d/99-gpubnb-focal-snapshot" >/dev/null <<'EOF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "3";
EOF

sudo chroot "$FOCAL_ROOTFS" apt-get update
sudo chroot "$FOCAL_ROOTFS" env DEBIAN_FRONTEND=noninteractive apt-get --no-install-recommends -y install \
  pciutils build-essential git subversion language-pack-en wget lsb-release sudo \
  linux-image-generic grub-pc openssh-server

if ! sudo chroot "$FOCAL_ROOTFS" id ubuntu >/dev/null 2>&1; then
  sudo chroot "$FOCAL_ROOTFS" useradd -ms /bin/bash -U ubuntu
fi

check_snapshot_candidate() {
  local package="$1"
  local expected="$2"
  local actual
  actual="$(sudo chroot "$FOCAL_ROOTFS" apt-cache policy "$package" | awk '/Candidate:/ {print $2; exit}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "historical Focal candidate mismatch: $package expected=$expected actual=$actual" >&2
    exit 1
  fi
  printf "%s=%s\n" "$package" "$actual"
}
{
  check_snapshot_candidate apt "2.0.10"
  check_snapshot_candidate binutils "2.34-6ubuntu1.9"
  check_snapshot_candidate curl "7.68.0-1ubuntu2.24"
  check_snapshot_candidate git "1:2.25.1-1ubuntu3.13"
  check_snapshot_candidate libc6 "2.31-0ubuntu9.16"
  check_snapshot_candidate ca-certificates "20240203~20.04.1"
  check_snapshot_candidate libfreetype6 "2.10.1-2ubuntu0.3"
  check_snapshot_candidate intel-microcode "3.20241112.0ubuntu0.20.04.1"
  check_snapshot_candidate libexpat1 "2.2.9-1ubuntu0.8"
} | tee "$OUTPUT_DIR/focal-snapshot-key-candidates.txt"

sudo chroot "$FOCAL_ROOTFS" dpkg-query -W -f='${Package}\t${Version}\n' | LC_ALL=C sort > "$OUTPUT_DIR/focal-bootstrap-packages.txt"
FOCAL_BOOTSTRAP_MANIFEST_SHA256="$(sha256sum "$OUTPUT_DIR/focal-bootstrap-packages.txt" | awk '{print $1}')"
FOCAL_BOOTSTRAP_PACKAGE_COUNT="$(wc -l < "$OUTPUT_DIR/focal-bootstrap-packages.txt" | tr -d ' ')"
echo "focal_bootstrap_manifest_sha256=$FOCAL_BOOTSTRAP_MANIFEST_SHA256" >> "$OUTPUT_DIR/environment.txt"
echo "focal_bootstrap_package_count=$FOCAL_BOOTSTRAP_PACKAGE_COUNT" >> "$OUTPUT_DIR/environment.txt"

sudo tar --numeric-owner --xattrs --acls -C "$FOCAL_ROOTFS" -c . | \
  docker import \
    --change 'ENV DEBIAN_FRONTEND=noninteractive' \
    --change 'USER ubuntu:ubuntu' \
    --change 'WORKDIR /home/ubuntu' \
    --change 'CMD ["sleep", "infinity"]' \
    - base-focal-amd64 >/dev/null
docker image inspect base-focal-amd64 >/dev/null
mkdir -p "$WORK_DIR/gitian-builder/var"

if ! (
  cd "$WORK_DIR/gitian-builder"
  export USE_DOCKER=1
  ./bin/gbuild \
    -j "${D0_BUILD_JOBS:-2}" \
    -m "${D0_BUILD_MEMORY_MIB:-5000}" \
    --commit "dogecoin=$DOGE_SOURCE_COMMIT" \
    --url "dogecoin=$DOGE_REPOSITORY" \
    "$UPSTREAM_DESCRIPTOR"
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

GITIAN_BASE_MANIFEST="$WORK_DIR/gitian-builder/var/base-focal-amd64.manifest"
if [[ ! -f "$GITIAN_BASE_MANIFEST" ]]; then
  echo "Gitian base manifest missing" >&2
  exit 1
fi
cp "$GITIAN_BASE_MANIFEST" "$OUTPUT_DIR/gitian-base-focal-amd64.manifest"
GITIAN_BASE_MANIFEST_SHA256="$(sha256sum "$GITIAN_BASE_MANIFEST" | awk '{print $1}')"

if cmp -s "$GITIAN_BASE_MANIFEST" "$OFFICIAL_FOCAL_MANIFEST_A"; then
  OFFICIAL_FOCAL_MANIFEST_VARIANT="KunNw0n"
elif cmp -s "$GITIAN_BASE_MANIFEST" "$OFFICIAL_FOCAL_MANIFEST_B"; then
  OFFICIAL_FOCAL_MANIFEST_VARIANT="slightlyskepticalpotat"
else
  echo "Gitian base manifest does not match either official Dogecoin 1.14.9 attestation" >&2
  diff -u "$OFFICIAL_FOCAL_MANIFEST_A" "$GITIAN_BASE_MANIFEST" | head -n 120 >&2 || true
  exit 1
fi
echo "official_focal_manifest_variant=$OFFICIAL_FOCAL_MANIFEST_VARIANT" >> "$OUTPUT_DIR/environment.txt"
echo "gitian_base_manifest_sha256=$GITIAN_BASE_MANIFEST_SHA256" >> "$OUTPUT_DIR/environment.txt"

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

python3 - "$OUTPUT_DIR" "$DOGE_SOURCE_COMMIT" "$GITIAN_BUILDER_COMMIT" "$FOCAL_BOOTSTRAP_MANIFEST_SHA256" "$FOCAL_BOOTSTRAP_PACKAGE_COUNT" "$ACTUAL_SHA256" "$OFFICIAL_X86_64_SHA256" "$DEPENDS_FALLBACK_URL" "$LIEF_SHA256" "$ZLIB_FOSSIL_URL" "$ZLIB_SHA256" "$EXPAT_URL" "$EXPAT_SHA256" "$UPSTREAM_DESCRIPTOR_SHA256" "$DEPENDS_CACHE_MANIFEST_SHA256" "$DEPENDS_CACHE_FILE_COUNT" "$FOCAL_SNAPSHOT_ID" "$FOCAL_SNAPSHOT_URL" "$GITIAN_BASE_MANIFEST_SHA256" "$OFFICIAL_FOCAL_MANIFEST_VARIANT" <<'PY'
import json
from pathlib import Path
import sys

out, source, gitian, focal_bootstrap_manifest_sha256, focal_bootstrap_package_count, actual, official, fallback_url, lief_sha256, zlib_url, zlib_sha256, expat_url, expat_sha256, descriptor_sha256, cache_manifest_sha256, cache_file_count, focal_snapshot_id, focal_snapshot_url, gitian_base_manifest_sha256, official_focal_manifest_variant = sys.argv[1:]
evidence = {
    "schema": "GPUBNB:DOGECOIN:D0-INTERNAL-BUILD-EVIDENCE:v1",
    "dogecoinSourceCommit": source,
    "gitianBuilderCommit": gitian,
    "focalBootstrapMethod": "debootstrap",
    "focalBootstrapPackageManifestSha256": focal_bootstrap_manifest_sha256,
    "focalBootstrapPackageCount": int(focal_bootstrap_package_count),
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
    "gitianDescriptorSha256": descriptor_sha256,
    "dependsSourceCacheManifestSha256": cache_manifest_sha256,
    "dependsSourceCacheFileCount": int(cache_file_count),
    "focalSnapshotId": focal_snapshot_id,
    "focalSnapshotUrl": focal_snapshot_url,
    "gitianBaseManifestSha256": gitian_base_manifest_sha256,
    "officialFocalManifestVariant": official_focal_manifest_variant,
    "gitianDescriptorModified": False,
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
