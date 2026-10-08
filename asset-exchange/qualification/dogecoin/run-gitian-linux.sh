#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: run-gitian-linux.sh <output-dir>" >&2
  exit 2
fi

readonly OUTPUT_DIR="$1"
readonly DOGECOIN_REPO="https://github.com/dogecoin/dogecoin.git"
readonly DOGECOIN_COMMIT="e0a1c157791544e818c901bd9341896965afbf9d"
readonly GITIAN_BUILDER_REPO="https://github.com/devrandom/gitian-builder.git"
readonly GITIAN_BUILDER_COMMIT="41c325d2f14147e8028fce9a5edd26e7adad30a4"
readonly LIEF_URL="https://depends.dogecoincore.org/lief-0.12.3-cp38-cp38-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
readonly LIEF_SHA256="c848aadac0816268aeb9dde7cefdb54bf24f78e664a19e97e74c92d3be1bb147"
readonly OFFICIAL_X86_64_SHA256="4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
readonly EXPECTED_ARCHIVE="dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$OUTPUT_DIR"

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  apt-cacher-ng ca-certificates curl git gnupg ruby wget
sudo systemctl restart apt-cacher-ng

docker version

source_dir="$work/dogecoin-source"
git init -q "$source_dir"
git -C "$source_dir" remote add origin "$DOGECOIN_REPO"
git -C "$source_dir" fetch --depth 1 origin "$DOGECOIN_COMMIT"
git -C "$source_dir" checkout --detach -q FETCH_HEAD
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$DOGECOIN_COMMIT" ]]
source_tree="$(git -C "$source_dir" rev-parse 'HEAD^{tree}')"
descriptor_sha256="$(sha256sum "$source_dir/contrib/gitian-descriptors/gitian-linux.yml" | awk '{print $1}')"
gitian_script_sha256="$(sha256sum "$source_dir/contrib/gitian-build.sh" | awk '{print $1}')"

builder_dir="$work/gitian-builder"
git init -q "$builder_dir"
git -C "$builder_dir" remote add origin "$GITIAN_BUILDER_REPO"
git -C "$builder_dir" fetch --depth 1 origin "$GITIAN_BUILDER_COMMIT"
git -C "$builder_dir" checkout --detach -q FETCH_HEAD
[[ "$(git -C "$builder_dir" rev-parse HEAD)" == "$GITIAN_BUILDER_COMMIT" ]]

mkdir -p "$builder_dir/inputs"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$LIEF_URL" \
  --output "$builder_dir/inputs/$(basename "$LIEF_URL")"
echo "$LIEF_SHA256  $builder_dir/inputs/$(basename "$LIEF_URL")" | sha256sum -c --strict

# Resolve the mutable Ubuntu tag to an immutable digest before creating the Gitian base image.
docker pull ubuntu:focal
ubuntu_ref="$(docker image inspect ubuntu:focal --format '{{index .RepoDigests 0}}')"
ubuntu_digest="${ubuntu_ref##*@sha256:}"
[[ "$ubuntu_digest" =~ ^[0-9a-f]{64}$ ]]

(
  cd "$builder_dir"
  ./bin/make-base-vm --suite focal --arch amd64 --docker --docker-image-digest "$ubuntu_digest"
)

cp "$source_dir/contrib/gitian-descriptors/gitian-linux.yml" "$work/gitian-linux.yml"
export USE_DOCKER=1
(
  cd "$builder_dir"
  ./bin/gbuild -j 2 -m 6000 \
    --commit "dogecoin=$DOGECOIN_COMMIT" \
    --url "dogecoin=$DOGECOIN_REPO" \
    "$work/gitian-linux.yml" 2>&1 | tee "$OUTPUT_DIR/gbuild.log"
)

archive_path="$(find "$builder_dir/build/out" -maxdepth 1 -type f -name "$EXPECTED_ARCHIVE" -print -quit)"
if [[ -z "$archive_path" || ! -f "$archive_path" ]]; then
  echo "ERROR: expected x86_64 archive not produced" >&2
  find "$builder_dir/build/out" -maxdepth 2 -type f -print >&2 || true
  exit 1
fi

cp "$archive_path" "$OUTPUT_DIR/$EXPECTED_ARCHIVE"
cp "$work/gitian-linux.yml" "$OUTPUT_DIR/gitian-linux.yml"

archive_sha256="$(sha256sum "$OUTPUT_DIR/$EXPECTED_ARCHIVE" | awk '{print $1}')"
archive_size="$(stat -c '%s' "$OUTPUT_DIR/$EXPECTED_ARCHIVE")"

python3 - "$OUTPUT_DIR/BUILD_INFO.json" <<PY
import json, pathlib
path = pathlib.Path(__import__('sys').argv[1])
data = {
  "schemaVersion": 1,
  "dogecoinRepository": "$DOGECOIN_REPO",
  "dogecoinCommit": "$DOGECOIN_COMMIT",
  "dogecoinTree": "$source_tree",
  "gitianDescriptorSha256": "$descriptor_sha256",
  "gitianBuildScriptSha256": "$gitian_script_sha256",
  "gitianBuilderRepository": "$GITIAN_BUILDER_REPO",
  "gitianBuilderCommit": "$GITIAN_BUILDER_COMMIT",
  "ubuntuFocalImageDigest": "sha256:$ubuntu_digest",
  "liefUrl": "$LIEF_URL",
  "liefSha256": "$LIEF_SHA256",
  "archive": "$EXPECTED_ARCHIVE",
  "archiveSha256": "$archive_sha256",
  "archiveSize": int("$archive_size"),
  "observedOfficialArchiveSha256": "$OFFICIAL_X86_64_SHA256",
  "finalReleaseBinaryExecuted": False
}
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

sha256sum "$OUTPUT_DIR/$EXPECTED_ARCHIVE" "$OUTPUT_DIR/gitian-linux.yml" "$OUTPUT_DIR/BUILD_INFO.json" > "$OUTPUT_DIR/SHA256SUMS"

echo "Dogecoin Gitian x86_64 build completed without executing the release binary."
cat "$OUTPUT_DIR/BUILD_INFO.json"
