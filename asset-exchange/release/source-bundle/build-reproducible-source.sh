#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: build-reproducible-source.sh <output-root> <source-sha> <source-date-epoch>" >&2
  exit 2
fi

out_root="$1"
source_sha="$2"
source_epoch="$3"
bundle_root="gpu.k.p2p-asset-exchange-source-v1"
archive_name="${bundle_root}.tar.gz"
sbom_name="${bundle_root}.spdx.json"

[[ "${source_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid source sha" >&2; exit 1; }
[[ "${source_epoch}" =~ ^[0-9]+$ ]] || { echo "ERROR: invalid source date epoch" >&2; exit 1; }

git cat-file -e "${source_sha}^{commit}"
source_tree="$(git rev-parse "${source_sha}^{tree}")"
[[ "${source_tree}" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid source tree" >&2; exit 1; }

rm -rf "${out_root}"
mkdir -p "${out_root}/stage/${bundle_root}" "${out_root}/dist"
stage="${out_root}/stage/${bundle_root}"
dist="${out_root}/dist"

mapfile -t workflow_paths < <(
  git ls-tree --name-only "${source_sha}:.github/workflows"     | awk '/^asset-exchange-.*\.yml$/ { print ".github/workflows/" $0 }'
)
if (( ${#workflow_paths[@]} == 0 )); then
  echo "ERROR: no dedicated Asset Exchange workflows found" >&2
  exit 1
fi

# Read bytes only from the committed Git object, never from an uncommitted
# working tree. This makes the source SHA the actual build input.
git archive --format=tar "${source_sha}"   asset-exchange   docs/asset-exchange   "${workflow_paths[@]}"   | tar -xf - -C "${stage}"

if find "${stage}" -type l -print -quit | grep -q .; then
  echo "ERROR: symlinks are forbidden in Asset Exchange source bundle" >&2
  exit 1
fi

SOURCE_SHA="${source_sha}" SOURCE_TREE="${source_tree}" SOURCE_EPOCH="${source_epoch}" python3 - "${stage}/SOURCE_BUNDLE_INFO.json" <<'PY'
import json, os, sys
path=sys.argv[1]
data={
    "artifact":"gpu.k.p2p-asset-exchange-source-v1",
    "bundleVersion":1,
    "sourceCommit":os.environ["SOURCE_SHA"],
    "sourceTree":os.environ["SOURCE_TREE"],
    "sourceDateEpoch":int(os.environ["SOURCE_EPOCH"]),
    "scope":[
        ".github/workflows/asset-exchange-*.yml",
        "asset-exchange/**",
        "docs/asset-exchange/**",
    ],
}
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, sort_keys=True, separators=(",",":"))
    f.write("\n")
PY
chmod 0644 "${stage}/SOURCE_BUNDLE_INFO.json"

archive="${dist}/${archive_name}"
(
  cd "${out_root}/stage"
  tar     --sort=name     --mtime="@${source_epoch}"     --owner=0     --group=0     --numeric-owner     --pax-option=delete=atime,delete=ctime     -cf - "${bundle_root}"     | gzip -n > "${archive}"
)

archive_sha="$(sha256sum "${archive}" | awk '{print $1}')"
node asset-exchange/release/source-bundle/generate-sbom.mjs   "${stage}"   "${source_sha}"   "${source_tree}"   "${source_epoch}"   "${archive_sha}"   > "${dist}/${sbom_name}"

(
  cd "${dist}"
  sha256sum "${archive_name}" "${sbom_name}" > SHA256SUMS
)

echo "Built reproducible Asset Exchange source audit bundle."
echo "source_sha=${source_sha}"
echo "source_tree=${source_tree}"
echo "archive_sha256=${archive_sha}"
