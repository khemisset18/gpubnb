#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tarfile
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: compare-evidence.py <replica-a-dir> <replica-b-dir> <output-dir>")

a_dir = Path(sys.argv[1])
b_dir = Path(sys.argv[2])
out_dir = Path(sys.argv[3])
out_dir.mkdir(parents=True, exist_ok=True)

artifact_name = "dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"
official_sha256 = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def load_evidence(root: Path) -> dict:
    return json.loads((root / "evidence.json").read_text())

a_artifact = a_dir / artifact_name
b_artifact = b_dir / artifact_name
if not a_artifact.is_file() or not b_artifact.is_file():
    raise SystemExit("one or both independent build artifacts are missing")

a_hash = sha256(a_artifact)
b_hash = sha256(b_artifact)
if a_hash != b_hash:
    raise SystemExit(f"independent builds differ: {a_hash} != {b_hash}")
if a_hash != official_sha256:
    raise SystemExit(f"reproducible build does not match observed official hash: {a_hash}")

a_ev = load_evidence(a_dir)
b_ev = load_evidence(b_dir)
for key in (
    "dogecoinSourceCommit",
    "gitianBuilderCommit",
    "ubuntuFocalRepoDigest",
    "officialObservedSha256",
    "dependsFallbackUrl",
    "liefInputSha256",
    "zlibFossilUrl",
    "zlibInputSha256",
    "expatUrl",
    "expatInputSha256",
    "gitianDescriptorSha256",
    "dependsSourceCacheManifestSha256",
    "dependsSourceCacheFileCount",
    "gitianDescriptorModified",
):
    if a_ev.get(key) != b_ev.get(key):
        raise SystemExit(f"replica environment mismatch for {key}: {a_ev.get(key)!r} != {b_ev.get(key)!r}")

if a_ev.get("gitianDescriptorModified") is not False or b_ev.get("gitianDescriptorModified") is not False:
    raise SystemExit("D0 evidence indicates the upstream Gitian descriptor was modified")
if a_ev.get("binaryExecuted") or b_ev.get("binaryExecuted"):
    raise SystemExit("D0 evidence unexpectedly records binary execution")

files = []
with tarfile.open(a_artifact, "r:gz") as tf:
    for member in tf.getmembers():
        name = member.name
        parts = Path(name).parts
        if name.startswith("/") or ".." in parts:
            raise SystemExit(f"unsafe archive path: {name}")
        if member.issym() or member.islnk():
            files.append({
                "name": name,
                "type": "symlink" if member.issym() else "hardlink",
                "target": member.linkname,
            })
            continue
        if member.isdir():
            continue
        if not member.isfile():
            raise SystemExit(f"unsupported archive member type: {name}")
        extracted = tf.extractfile(member)
        if extracted is None:
            raise SystemExit(f"unable to read archive member: {name}")
        data = extracted.read()
        files.append({
            "name": name,
            "type": "file",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })

source_commit = a_ev["dogecoinSourceCommit"]
gitian_commit = a_ev["gitianBuilderCommit"]
ubuntu_digest = a_ev["ubuntuFocalRepoDigest"]

spdx_files = []
relationships = []
for index, entry in enumerate(files):
    if entry["type"] != "file":
        continue
    spdx_id = f"SPDXRef-File-{index:05d}"
    spdx_files.append({
        "fileName": "./" + entry["name"],
        "SPDXID": spdx_id,
        "checksums": [{"algorithm": "SHA256", "checksumValue": entry["sha256"]}],
        "licenseConcluded": "NOASSERTION",
        "copyrightText": "NOASSERTION",
    })
    relationships.append({
        "spdxElementId": "SPDXRef-Package-Dogecoin-Core-1.14.9",
        "relationshipType": "CONTAINS",
        "relatedSpdxElement": spdx_id,
    })

sbom = {
    "spdxVersion": "SPDX-2.3",
    "dataLicense": "CC0-1.0",
    "SPDXID": "SPDXRef-DOCUMENT",
    "name": "gpu.k.p2p-dogecoin-1.14.9-internal-reproduction",
    "documentNamespace": f"https://github.com/khemisset18/gpubnb/spdx/dogecoin-d0/{source_commit}/{a_hash}",
    "creationInfo": {
        "creators": ["Tool: gpu.k.p2p Dogecoin D0 evidence generator v1"],
    },
    "packages": [{
        "name": "Dogecoin Core",
        "SPDXID": "SPDXRef-Package-Dogecoin-Core-1.14.9",
        "versionInfo": "1.14.9",
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": True,
        "checksums": [{"algorithm": "SHA256", "checksumValue": a_hash}],
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "NOASSERTION",
        "copyrightText": "NOASSERTION",
        "externalRefs": [
            {
                "referenceCategory": "OTHER",
                "referenceType": "source-commit",
                "referenceLocator": f"https://github.com/dogecoin/dogecoin/commit/{source_commit}",
            },
            {
                "referenceCategory": "OTHER",
                "referenceType": "build-tool-commit",
                "referenceLocator": f"https://github.com/devrandom/gitian-builder/commit/{gitian_commit}",
            },
            {
                "referenceCategory": "OTHER",
                "referenceType": "build-base-image",
                "referenceLocator": ubuntu_digest,
            },
        ],
    }],
    "files": spdx_files,
    "relationships": [
        {
            "spdxElementId": "SPDXRef-DOCUMENT",
            "relationshipType": "DESCRIBES",
            "relatedSpdxElement": "SPDXRef-Package-Dogecoin-Core-1.14.9",
        },
        *relationships,
    ],
}
(out_dir / "dogecoin-1.14.9-internal-reproduction.spdx.json").write_text(
    json.dumps(sbom, indent=2, sort_keys=True) + "\n"
)

provenance = {
    "schema": "GPUBNB:DOGECOIN:D0-INTERNAL-REPRO-PROVENANCE:v1",
    "status": "INTERNAL_REPRODUCTION_MATCH",
    "overallDogecoinD0": "BLOCKED_PENDING_TRUST_POLICY_REVIEW",
    "artifact": artifact_name,
    "sha256": a_hash,
    "matchesObservedOfficialSha256": True,
    "independentBuildsByteIdentical": True,
    "dogecoinSourceCommit": source_commit,
    "gitianBuilderCommit": gitian_commit,
    "ubuntuFocalRepoDigest": ubuntu_digest,
    "dependsFallbackUrl": a_ev["dependsFallbackUrl"],
    "liefInputSha256": a_ev["liefInputSha256"],
    "zlibFossilUrl": a_ev["zlibFossilUrl"],
    "zlibInputSha256": a_ev["zlibInputSha256"],
    "expatUrl": a_ev["expatUrl"],
    "expatInputSha256": a_ev["expatInputSha256"],
    "gitianDescriptorSha256": a_ev["gitianDescriptorSha256"],
    "dependsSourceCacheManifestSha256": a_ev["dependsSourceCacheManifestSha256"],
    "dependsSourceCacheFileCount": a_ev["dependsSourceCacheFileCount"],
    "gitianDescriptorModified": False,
    "binaryExecuted": False,
    "mainnetUsed": False,
    "realFundsUsed": False,
    "upstreamPrebuiltSignerProvenance": "BLOCKED",
}
(out_dir / "provenance.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
(out_dir / "archive-members.json").write_text(json.dumps(files, indent=2, sort_keys=True) + "\n")

(out_dir / artifact_name).write_bytes(a_artifact.read_bytes())
(out_dir / "SHA256SUMS").write_text(
    f"{a_hash}  {artifact_name}\n"
    f"{sha256(out_dir / 'dogecoin-1.14.9-internal-reproduction.spdx.json')}  dogecoin-1.14.9-internal-reproduction.spdx.json\n"
    f"{sha256(out_dir / 'provenance.json')}  provenance.json\n"
)

print(json.dumps(provenance, indent=2, sort_keys=True))
