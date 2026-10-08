#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: build-reproducible.sh <output-dir> <source-sha> <source-date-epoch>" >&2
  exit 2
fi

out_dir="$1"
source_sha="$2"
source_date_epoch="$3"

[[ "${source_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid source SHA" >&2; exit 1; }
[[ "${source_date_epoch}" =~ ^[0-9]+$ ]] || { echo "ERROR: invalid SOURCE_DATE_EPOCH" >&2; exit 1; }

root_name="gpu.k.p2p-recovery-tool-v1"
stage="${out_dir}/stage/${root_name}"
dist="${out_dir}/dist"

rm -rf "${out_dir}"
mkdir -p "${stage}/asset-exchange/recovery/src" "${stage}/asset-exchange/core/src" "${dist}"

install -m 0755 asset-exchange/recovery/src/cli.mjs "${stage}/asset-exchange/recovery/src/cli.mjs"
install -m 0644 asset-exchange/recovery/src/bundle.mjs "${stage}/asset-exchange/recovery/src/bundle.mjs"
install -m 0644 asset-exchange/recovery/src/metadata.mjs "${stage}/asset-exchange/recovery/src/metadata.mjs"
install -m 0644 asset-exchange/recovery/src/strict-json.mjs "${stage}/asset-exchange/recovery/src/strict-json.mjs"
install -m 0644 asset-exchange/core/src/canonical.mjs "${stage}/asset-exchange/core/src/canonical.mjs"
install -m 0644 asset-exchange/core/src/errors.mjs "${stage}/asset-exchange/core/src/errors.mjs"
install -m 0644 asset-exchange/core/src/deployment.mjs "${stage}/asset-exchange/core/src/deployment.mjs"
install -m 0644 asset-exchange/recovery/README.md "${stage}/RECOVERY_README.md"

cat > "${stage}/BUILD_INFO.json" <<EOF
{"artifact":"gpu.k.p2p-recovery-tool-v1","sourceRepository":"https://github.com/khemisset18/gpubnb","sourceCommit":"${source_sha}","sourceDateEpoch":${source_date_epoch},"nodeRequirement":">=22","main":"asset-exchange/recovery/src/cli.mjs"}
EOF

created_iso="$(date -u -d "@${source_date_epoch}" '+%Y-%m-%dT%H:%M:%SZ')"
node asset-exchange/recovery/release/generate-sbom.mjs   "${stage}" "${dist}/${root_name}.spdx.json" "${source_sha}" "${created_iso}"

tar --sort=name --mtime="@${source_date_epoch}" --owner=0 --group=0 --numeric-owner   --format=gnu -C "${out_dir}/stage" -cf "${dist}/${root_name}.tar" "${root_name}"
gzip -n -9 "${dist}/${root_name}.tar"

(
  cd "${dist}"
  sha256sum "${root_name}.tar.gz" "${root_name}.spdx.json" > SHA256SUMS
)

actual_files="$(tar -tzf "${dist}/${root_name}.tar.gz" | sed '/\/$/d' | sort)"
expected_files="$(cat <<'EOF'
gpu.k.p2p-recovery-tool-v1/BUILD_INFO.json
gpu.k.p2p-recovery-tool-v1/RECOVERY_README.md
gpu.k.p2p-recovery-tool-v1/asset-exchange/core/src/canonical.mjs
gpu.k.p2p-recovery-tool-v1/asset-exchange/core/src/deployment.mjs
gpu.k.p2p-recovery-tool-v1/asset-exchange/core/src/errors.mjs
gpu.k.p2p-recovery-tool-v1/asset-exchange/recovery/src/bundle.mjs
gpu.k.p2p-recovery-tool-v1/asset-exchange/recovery/src/cli.mjs
gpu.k.p2p-recovery-tool-v1/asset-exchange/recovery/src/metadata.mjs
gpu.k.p2p-recovery-tool-v1/asset-exchange/recovery/src/strict-json.mjs
EOF
)"
if [[ "${actual_files}" != "${expected_files}" ]]; then
  echo "ERROR: recovery artifact allow-list mismatch" >&2
  diff -u <(printf '%s\n' "${expected_files}") <(printf '%s\n' "${actual_files}") || true
  exit 1
fi

echo "Recovery artifact built reproducibly."
cat "${dist}/SHA256SUMS"
