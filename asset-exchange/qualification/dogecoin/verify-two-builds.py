#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, pathlib, posixpath, re, sys, tarfile

EXPECTED_ARCHIVE = "dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"
EXPECTED_OFFICIAL = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
EXPECTED_SOURCE = "e0a1c157791544e818c901bd9341896965afbf9d"
EXPECTED_BUILDER = "41c325d2f14147e8028fce9a5edd26e7adad30a4"

if len(sys.argv) != 4:
    raise SystemExit("usage: verify-two-builds.py <build-a> <build-b> <evidence-dir>")
a_dir, b_dir, evidence_dir = map(pathlib.Path, sys.argv[1:])
evidence_dir.mkdir(parents=True, exist_ok=True)


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_info(root: pathlib.Path) -> dict:
    return json.loads((root / "BUILD_INFO.json").read_text(encoding="utf-8"))


def safe_tar_inventory(path: pathlib.Path) -> list[dict]:
    rows = []
    with tarfile.open(path, "r:gz") as tf:
        for member in tf.getmembers():
            normalized = posixpath.normpath(member.name)
            if member.name.startswith("/") or normalized == ".." or normalized.startswith("../"):
                raise SystemExit(f"unsafe tar path: {member.name}")
            if member.isdev() or member.isfifo():
                raise SystemExit(f"unsafe tar entry type: {member.name}")
            if member.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
                    raise SystemExit(f"escaping tar symlink: {member.name} -> {member.linkname}")
                rows.append({"name": member.name, "type": "SYMLINK", "target": member.linkname})
                continue
            if member.islnk():
                target = posixpath.normpath(member.linkname)
                if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
                    raise SystemExit(f"escaping tar hardlink: {member.name} -> {member.linkname}")
                rows.append({"name": member.name, "type": "HARDLINK", "target": member.linkname})
                continue
            if member.isfile():
                f = tf.extractfile(member)
                if f is None:
                    raise SystemExit(f"cannot read tar member: {member.name}")
                data = f.read()
                rows.append({
                    "name": member.name,
                    "type": "FILE",
                    "size": len(data),
                    "sha1": hashlib.sha1(data).hexdigest(),
                    "sha256": hashlib.sha256(data).hexdigest(),
                })
            elif member.isdir():
                rows.append({"name": member.name, "type": "DIRECTORY"})
            else:
                raise SystemExit(f"unsupported tar entry type: {member.name}")
    return rows

archive_a = a_dir / EXPECTED_ARCHIVE
archive_b = b_dir / EXPECTED_ARCHIVE
info_a = load_info(a_dir)
info_b = load_info(b_dir)
sha_a = sha256(archive_a)
sha_b = sha256(archive_b)
bytes_equal = archive_a.read_bytes() == archive_b.read_bytes()
identity_fields = [
    "dogecoinRepository", "dogecoinCommit", "dogecoinTree", "gitianDescriptorSha256",
    "gitianBuildScriptSha256", "gitianBuilderRepository", "gitianBuilderCommit",
    "ubuntuFocalImageDigest", "liefSha256", "qrencodeSha256", "zlibSha256", "archive"
]
identity_equal = all(info_a.get(k) == info_b.get(k) for k in identity_fields)
source_ok = info_a.get("dogecoinCommit") == EXPECTED_SOURCE == info_b.get("dogecoinCommit")
builder_ok = info_a.get("gitianBuilderCommit") == EXPECTED_BUILDER == info_b.get("gitianBuilderCommit")
no_execution = info_a.get("finalReleaseBinaryExecuted") is False and info_b.get("finalReleaseBinaryExecuted") is False
official_match = sha_a == EXPECTED_OFFICIAL == sha_b

inventory = safe_tar_inventory(archive_a)
regular_files = [row for row in inventory if row["type"] == "FILE"]
package_id = "SPDXRef-Package-Dogecoin-Core-1.14.9-linux-x86_64"
spdx_files = []
relationships = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": package_id}]
for i, row in enumerate(regular_files, 1):
    fid = f"SPDXRef-File-{i}"
    spdx_files.append({
        "fileName": "./" + row["name"],
        "SPDXID": fid,
        "checksums": [
            {"algorithm": "SHA1", "checksumValue": row["sha1"]},
            {"algorithm": "SHA256", "checksumValue": row["sha256"]},
        ],
        "licenseConcluded": "NOASSERTION",
        "copyrightText": "NOASSERTION",
    })
    relationships.append({"spdxElementId": package_id, "relationshipType": "CONTAINS", "relatedSpdxElement": fid})

created = os.environ.get("EVIDENCE_CREATED_ISO", "")
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", created):
    raise SystemExit("EVIDENCE_CREATED_ISO must be deterministic UTC ISO-8601")

sbom = {
    "spdxVersion": "SPDX-2.3",
    "dataLicense": "CC0-1.0",
    "SPDXID": "SPDXRef-DOCUMENT",
    "name": "gpu.k.p2p-dogecoin-d0-rebuild-1.14.9-linux-x86_64",
    "documentNamespace": f"https://github.com/khemisset18/gpubnb/spdx/dogecoin-d0/{EXPECTED_SOURCE}/{sha_a}",
    "creationInfo": {"created": created, "creators": ["Tool: gpu.k.p2p Dogecoin D0 verifier v1"]},
    "packages": [{
        "name": "Dogecoin Core",
        "SPDXID": package_id,
        "versionInfo": "1.14.9",
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": True,
        "checksums": [{"algorithm": "SHA256", "checksumValue": sha_a}],
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "MIT",
        "copyrightText": "NOASSERTION",
        "externalRefs": [
            {"referenceCategory": "OTHER", "referenceType": "source-commit", "referenceLocator": f"https://github.com/dogecoin/dogecoin/commit/{EXPECTED_SOURCE}"}
        ],
    }],
    "files": spdx_files,
    "relationships": relationships,
}
(evidence_dir / "dogecoin-1.14.9-x86_64-linux-gnu.spdx.json").write_text(json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8")

result = {
    "schemaVersion": 1,
    "status": "PASS" if all([bytes_equal, identity_equal, source_ok, builder_ok, no_execution, official_match]) else "BLOCKED",
    "checks": {
        "independentBuildBytesEqual": bytes_equal,
        "buildIdentityEqual": identity_equal,
        "sourceCommitPinned": source_ok,
        "gitianBuilderPinned": builder_ok,
        "finalReleaseBinaryNotExecuted": no_execution,
        "matchesObservedOfficialArchiveSha256": official_match,
        "tarSafetyInventoryPassed": True,
    },
    "archiveSha256BuildA": sha_a,
    "archiveSha256BuildB": sha_b,
    "expectedOfficialArchiveSha256": EXPECTED_OFFICIAL,
    "buildA": info_a,
    "buildB": info_b,
    "tarEntryCount": len(inventory),
    "regularFileCount": len(regular_files),
}
(evidence_dir / "DOGECOIN_D0_BUILD_EVIDENCE.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")

with (evidence_dir / "SHA256SUMS").open("w", encoding="utf-8") as f:
    for name in sorted(["DOGECOIN_D0_BUILD_EVIDENCE.json", "dogecoin-1.14.9-x86_64-linux-gnu.spdx.json"]):
        f.write(f"{sha256(evidence_dir / name)}  {name}\n")

print(json.dumps(result, indent=2, sort_keys=True))
if result["status"] != "PASS":
    raise SystemExit(1)
