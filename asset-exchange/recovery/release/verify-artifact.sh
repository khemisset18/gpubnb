#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 1 ]] || { echo "usage: verify-artifact.sh <dist-dir>" >&2; exit 2; }
dist="$1"

(
  cd "${dist}"
  sha256sum --check --strict SHA256SUMS
)

node --input-type=module - "${dist}/gpu.k.p2p-recovery-tool-v1.spdx.json" <<'NODE'
import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (doc.spdxVersion !== "SPDX-2.3") throw new Error("unexpected SPDX version");
if (doc.packages?.length !== 1) throw new Error("expected one SPDX package");
if (!Array.isArray(doc.files) || doc.files.length !== 8) throw new Error("unexpected SBOM file count");
const names = new Set(doc.files.map((f) => f.fileName));
for (const required of [
  "./asset-exchange/recovery/src/cli.mjs",
  "./asset-exchange/recovery/src/bundle.mjs",
  "./asset-exchange/recovery/src/metadata.mjs",
  "./asset-exchange/core/src/canonical.mjs",
  "./asset-exchange/core/src/errors.mjs",
  "./asset-exchange/core/src/deployment.mjs",
  "./RECOVERY_README.md",
  "./BUILD_INFO.json"
]) {
  if (!names.has(required)) throw new Error(`SBOM missing ${required}`);
}
NODE

echo "Recovery artifact hashes and SBOM verified."
