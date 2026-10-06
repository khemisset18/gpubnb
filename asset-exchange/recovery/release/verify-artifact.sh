#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo "usage: verify-artifact.sh <dist-dir> [expected-source-sha]" >&2
  exit 2
fi

dist="$1"
expected_source_sha="${2:-}"

if [[ -n "${expected_source_sha}" && ! "${expected_source_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: invalid expected source SHA" >&2
  exit 1
fi

archive="${dist}/gpu.k.p2p-recovery-tool-v1.tar.gz"
sbom="${dist}/gpu.k.p2p-recovery-tool-v1.spdx.json"

[[ -f "${archive}" ]] || { echo "ERROR: recovery archive missing" >&2; exit 1; }
[[ -f "${sbom}" ]] || { echo "ERROR: recovery SBOM missing" >&2; exit 1; }
[[ -f "${dist}/SHA256SUMS" ]] || { echo "ERROR: SHA256SUMS missing" >&2; exit 1; }

(
  cd "${dist}"
  sha256sum --check --strict SHA256SUMS
)

python3 - "${archive}" "${sbom}" "${expected_source_sha}" <<'PY'
from __future__ import annotations

import hashlib
import json
import posixpath
import re
import sys
import tarfile
from pathlib import PurePosixPath

archive_path, sbom_path, expected_source_sha = sys.argv[1:4]
root = "gpu.k.p2p-recovery-tool-v1"

expected_files = {
    "BUILD_INFO.json",
    "RECOVERY_README.md",
    "asset-exchange/core/src/canonical.mjs",
    "asset-exchange/core/src/deployment.mjs",
    "asset-exchange/core/src/errors.mjs",
    "asset-exchange/recovery/src/bundle.mjs",
    "asset-exchange/recovery/src/cli.mjs",
    "asset-exchange/recovery/src/metadata.mjs",
}

with open(sbom_path, "r", encoding="utf-8") as f:
    doc = json.load(f)

if doc.get("spdxVersion") != "SPDX-2.3":
    raise SystemExit("unexpected SPDX version")
packages = doc.get("packages")
if not isinstance(packages, list) or len(packages) != 1:
    raise SystemExit("expected exactly one SPDX package")
files = doc.get("files")
if not isinstance(files, list) or len(files) != len(expected_files):
    raise SystemExit("unexpected SPDX file count")

sbom_by_name = {}
for entry in files:
    name = entry.get("fileName")
    if not isinstance(name, str) or not name.startswith("./"):
        raise SystemExit(f"invalid SPDX file name: {name!r}")
    relative = name[2:]
    if relative in sbom_by_name:
        raise SystemExit(f"duplicate SPDX file entry: {relative}")
    sbom_by_name[relative] = entry

if set(sbom_by_name) != expected_files:
    missing = sorted(expected_files - set(sbom_by_name))
    extra = sorted(set(sbom_by_name) - expected_files)
    raise SystemExit(f"SPDX allow-list mismatch missing={missing} extra={extra}")

tar_bytes = {}
with tarfile.open(archive_path, "r:gz") as tf:
    for member in tf.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe tar path: {member.name}")
        if "\\" in member.name:
            raise SystemExit(f"non-canonical tar path separator: {member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"links forbidden in recovery artifact: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f"unsupported tar entry type: {member.name}")
        if not member.name.startswith(root + "/") and member.name != root:
            raise SystemExit(f"entry outside artifact root: {member.name}")
        if member.isfile():
            relative = posixpath.relpath(member.name, root)
            if relative.startswith("../"):
                raise SystemExit(f"entry escaped artifact root: {member.name}")
            extracted = tf.extractfile(member)
            if extracted is None:
                raise SystemExit(f"unable to read tar member: {member.name}")
            if relative in tar_bytes:
                raise SystemExit(f"duplicate tar file: {relative}")
            tar_bytes[relative] = extracted.read()

if set(tar_bytes) != expected_files:
    missing = sorted(expected_files - set(tar_bytes))
    extra = sorted(set(tar_bytes) - expected_files)
    raise SystemExit(f"tar allow-list mismatch missing={missing} extra={extra}")

sha1_values = []
for relative in sorted(expected_files):
    data = tar_bytes[relative]
    actual_sha1 = hashlib.sha1(data).hexdigest()
    actual_sha256 = hashlib.sha256(data).hexdigest()
    sha1_values.append(actual_sha1)

    checksums = sbom_by_name[relative].get("checksums")
    if not isinstance(checksums, list):
        raise SystemExit(f"missing checksums for {relative}")
    checksum_map = {
        c.get("algorithm"): c.get("checksumValue")
        for c in checksums
        if isinstance(c, dict)
    }
    if checksum_map.get("SHA1") != actual_sha1:
        raise SystemExit(f"SPDX SHA1 mismatch for {relative}")
    if checksum_map.get("SHA256") != actual_sha256:
        raise SystemExit(f"SPDX SHA256 mismatch for {relative}")

verification_code = hashlib.sha1("".join(sorted(sha1_values)).encode()).hexdigest()
package = packages[0]
reported_code = (
    package.get("packageVerificationCode", {})
    .get("packageVerificationCodeValue")
)
if reported_code != verification_code:
    raise SystemExit("SPDX packageVerificationCode mismatch")

build_info = json.loads(tar_bytes["BUILD_INFO.json"].decode("utf-8"))
source_commit = build_info.get("sourceCommit")
if not isinstance(source_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", source_commit):
    raise SystemExit("BUILD_INFO sourceCommit invalid")
if expected_source_sha and source_commit != expected_source_sha:
    raise SystemExit(
        f"BUILD_INFO sourceCommit mismatch expected={expected_source_sha} actual={source_commit}"
    )
if build_info.get("artifact") != root:
    raise SystemExit("BUILD_INFO artifact name mismatch")
if build_info.get("main") != "asset-exchange/recovery/src/cli.mjs":
    raise SystemExit("BUILD_INFO main entry mismatch")

expected_namespace = f"https://github.com/khemisset18/gpubnb/spdx/recovery-tool/{source_commit}"
if doc.get("documentNamespace") != expected_namespace:
    raise SystemExit("SPDX documentNamespace/sourceCommit mismatch")
if package.get("versionInfo") != source_commit[:12]:
    raise SystemExit("SPDX versionInfo/sourceCommit mismatch")

external_refs = package.get("externalRefs")
expected_locator = f"https://github.com/khemisset18/gpubnb/commit/{source_commit}"
if not isinstance(external_refs, list) or not any(
    isinstance(ref, dict)
    and ref.get("referenceType") == "source-commit"
    and ref.get("referenceLocator") == expected_locator
    for ref in external_refs
):
    raise SystemExit("SPDX source-commit external reference mismatch")

print(
    "Recovery artifact internal files, SBOM hashes, package verification code, "
    f"and source binding verified for {source_commit}."
)
PY

echo "Recovery artifact hashes, contents, SBOM, and source binding verified."
