#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: verify-source-artifact.sh <dist-dir> <expected-source-sha> <expected-source-tree>" >&2
  exit 2
fi

dist="$1"
expected_sha="$2"
expected_tree="$3"
root="gpu.k.p2p-asset-exchange-source-v1"
archive="${dist}/${root}.tar.gz"
sbom="${dist}/${root}.spdx.json"

[[ "${expected_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid expected source sha" >&2; exit 1; }
[[ "${expected_tree}" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid expected source tree" >&2; exit 1; }
[[ -f "${archive}" ]] || { echo "ERROR: source archive missing" >&2; exit 1; }
[[ -f "${sbom}" ]] || { echo "ERROR: source SBOM missing" >&2; exit 1; }
[[ -f "${dist}/SHA256SUMS" ]] || { echo "ERROR: SHA256SUMS missing" >&2; exit 1; }

(
  cd "${dist}"
  sha256sum --check --strict SHA256SUMS
)

python3 - "${archive}" "${sbom}" "${expected_sha}" "${expected_tree}" <<'PY'
from __future__ import annotations
import fnmatch
import hashlib
import json
import posixpath
import re
import sys
import tarfile
from pathlib import PurePosixPath

archive_path, sbom_path, expected_sha, expected_tree = sys.argv[1:5]
root = "gpu.k.p2p-asset-exchange-source-v1"

def allowed(relative: str) -> bool:
    return (
        relative == "SOURCE_BUNDLE_INFO.json"
        or relative.startswith("asset-exchange/")
        or relative.startswith("docs/asset-exchange/")
        or (
            relative.startswith(".github/workflows/")
            and "/" not in relative[len(".github/workflows/"):]
            and fnmatch.fnmatch(
                relative[len(".github/workflows/"):],
                "asset-exchange-*.yml",
            )
        )
    )

with open(sbom_path, "r", encoding="utf-8") as f:
    doc=json.load(f)

if doc.get("spdxVersion") != "SPDX-2.3":
    raise SystemExit("unexpected SPDX version")
packages=doc.get("packages")
if not isinstance(packages, list) or len(packages) != 1:
    raise SystemExit("expected exactly one SPDX package")
files=doc.get("files")
if not isinstance(files, list) or not files:
    raise SystemExit("SPDX file list missing")

sbom_by_name={}
for entry in files:
    name=entry.get("fileName")
    if not isinstance(name, str) or not name.startswith("./"):
        raise SystemExit(f"invalid SPDX file name: {name!r}")
    relative=name[2:]
    if not allowed(relative):
        raise SystemExit(f"SPDX contains path outside Asset Exchange scope: {relative}")
    if relative in sbom_by_name:
        raise SystemExit(f"duplicate SPDX file entry: {relative}")
    sbom_by_name[relative]=entry

tar_bytes={}
with tarfile.open(archive_path, "r:gz") as tf:
    for member in tf.getmembers():
        p=PurePosixPath(member.name)
        if p.is_absolute() or ".." in p.parts or "\\" in member.name:
            raise SystemExit(f"unsafe tar path: {member.name}")
        if member.issym() or member.islnk():
            raise SystemExit(f"links forbidden: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f"unsupported tar entry: {member.name}")
        if member.name != root and not member.name.startswith(root + "/"):
            raise SystemExit(f"entry outside bundle root: {member.name}")
        if not member.isfile():
            continue
        relative=posixpath.relpath(member.name, root)
        if relative.startswith("../") or not allowed(relative):
            raise SystemExit(f"file outside Asset Exchange scope: {relative}")
        fobj=tf.extractfile(member)
        if fobj is None:
            raise SystemExit(f"unable to read member: {member.name}")
        if relative in tar_bytes:
            raise SystemExit(f"duplicate tar file: {relative}")
        tar_bytes[relative]=fobj.read()

if set(tar_bytes) != set(sbom_by_name):
    missing=sorted(set(sbom_by_name)-set(tar_bytes))
    extra=sorted(set(tar_bytes)-set(sbom_by_name))
    raise SystemExit(f"tar/SBOM file-set mismatch missing={missing} extra={extra}")

sha1_values=[]
for relative in sorted(tar_bytes):
    data=tar_bytes[relative]
    actual_sha1=hashlib.sha1(data).hexdigest()
    actual_sha256=hashlib.sha256(data).hexdigest()
    sha1_values.append(actual_sha1)
    checksums=sbom_by_name[relative].get("checksums")
    if not isinstance(checksums, list):
        raise SystemExit(f"missing SPDX checksums: {relative}")
    cmap={c.get("algorithm"):c.get("checksumValue") for c in checksums if isinstance(c,dict)}
    if cmap.get("SHA1") != actual_sha1:
        raise SystemExit(f"SPDX SHA1 mismatch: {relative}")
    if cmap.get("SHA256") != actual_sha256:
        raise SystemExit(f"SPDX SHA256 mismatch: {relative}")

verification_code=hashlib.sha1("".join(sorted(sha1_values)).encode()).hexdigest()
package=packages[0]
if package.get("packageVerificationCode",{}).get("packageVerificationCodeValue") != verification_code:
    raise SystemExit("SPDX packageVerificationCode mismatch")

archive_sha256=hashlib.sha256(open(archive_path,"rb").read()).hexdigest()
package_checksums=package.get("checksums")
if not isinstance(package_checksums,list) or not any(
    isinstance(x,dict) and x.get("algorithm")=="SHA256" and x.get("checksumValue")==archive_sha256
    for x in package_checksums
):
    raise SystemExit("SPDX package archive SHA256 mismatch")

info=json.loads(tar_bytes["SOURCE_BUNDLE_INFO.json"].decode("utf-8"))
if info.get("sourceCommit") != expected_sha:
    raise SystemExit("SOURCE_BUNDLE_INFO sourceCommit mismatch")
if info.get("sourceTree") != expected_tree:
    raise SystemExit("SOURCE_BUNDLE_INFO sourceTree mismatch")
if info.get("artifact") != root or info.get("bundleVersion") != 1:
    raise SystemExit("SOURCE_BUNDLE_INFO identity mismatch")

if doc.get("documentNamespace") != f"https://github.com/khemisset18/gpubnb/spdx/asset-exchange-source/{expected_sha}":
    raise SystemExit("SPDX documentNamespace mismatch")
if package.get("versionInfo") != expected_sha[:12]:
    raise SystemExit("SPDX versionInfo mismatch")

external=package.get("externalRefs")
expected_commit=f"https://github.com/khemisset18/gpubnb/commit/{expected_sha}"
if not isinstance(external,list):
    raise SystemExit("SPDX externalRefs missing")
if not any(isinstance(x,dict) and x.get("referenceType")=="source-commit" and x.get("referenceLocator")==expected_commit for x in external):
    raise SystemExit("SPDX source commit reference mismatch")
if not any(isinstance(x,dict) and x.get("referenceType")=="git-tree" and x.get("referenceLocator")==expected_tree for x in external):
    raise SystemExit("SPDX git tree reference mismatch")

print(
    f"Asset Exchange source audit bundle verified: files={len(tar_bytes)} "
    f"source={expected_sha} tree={expected_tree} archive_sha256={archive_sha256}"
)
PY

echo "Asset Exchange source audit bundle hashes, scope, SBOM, and source identity verified."
