"""Fail-closed validation of independent Dogecoin D0 build evidence.

Inputs are untrusted GitHub Actions artifacts. This module does not extract or
execute release binaries and does not grant settlement or Mainnet authority.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

ARTIFACT = "dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"
OFFICIAL_SHA256 = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
SOURCE_COMMIT = "e0a1c157791544e818c901bd9341896965afbf9d"
GITIAN_COMMIT = "41c325d2f14147e8028fce9a5edd26e7adad30a4"
SCHEMA = "GPUBNB:DOGECOIN:D0-INTERNAL-BUILD-EVIDENCE:v1"
MAX_EVIDENCE_BYTES = 64 * 1024

EXPECTED = {
    "schema": SCHEMA,
    "artifact": ARTIFACT,
    "dogecoinSourceCommit": SOURCE_COMMIT,
    "gitianBuilderCommit": GITIAN_COMMIT,
    "officialObservedSha256": OFFICIAL_SHA256,
    "focalBootstrapMethod": "debootstrap",
    "dependsFallbackUrl": "https://download.bitcoincashnode.org/depends-sources",
    "liefInputSha256": "c848aadac0816268aeb9dde7cefdb54bf24f78e664a19e97e74c92d3be1bb147",
    "zlibFossilUrl": "https://zlib.net/fossils/zlib-1.3.tar.gz",
    "zlibInputSha256": "ff0ba4c292013dbc27530b3a81e1f9a813cd39de01ca5e0f8bf355702efa593e",
    "expatUrl": "https://github.com/libexpat/libexpat/releases/download/R_2_6_2/expat-2.6.2.tar.bz2",
    "expatInputSha256": "9c7c1b5dcbc3c237c500a8fb1493e14d9582146dd9b42aa8d3ffb856a3b927e0",
    "officialHashMatch": True,
    "gitianDescriptorModified": False,
    "binaryExecuted": False,
    "mainnetUsed": False,
    "realFundsUsed": False,
}

# Compare recorded hashes to the actual GitHub Actions evidence attachments.
HASHED_EVIDENCE_FILES = {
    "gitianDescriptorSha256": "gitian-linux-upstream.yml",
    "dependsSourceCacheManifestSha256": "depends-source-cache.SHA256SUMS",
    "focalBootstrapPackageManifestSha256": "focal-bootstrap-packages.txt",
    "gitianBaseManifestSha256": "gitian-base-focal-amd64.manifest",
}


def _unique_keys(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key in D0 evidence: {key}")
        result[key] = value
    return result


def _regular_file(root: Path, name: str) -> Path:
    path = root / name
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"missing or symlinked D0 evidence file: {name}")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_evidence(root: Path, actual_artifact_sha256: str) -> dict:
    """Return validated evidence or raise ValueError before provenance output."""
    evidence_file = _regular_file(root, "evidence.json")
    if evidence_file.stat().st_size > MAX_EVIDENCE_BYTES:
        raise ValueError("D0 evidence JSON exceeds 64 KiB")
    try:
        evidence = json.loads(evidence_file.read_text(encoding="utf-8"), object_pairs_hook=_unique_keys)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid D0 evidence JSON") from exc
    if not isinstance(evidence, dict):
        raise ValueError("D0 evidence must be a JSON object")

    for key, expected in EXPECTED.items():
        actual = evidence.get(key)
        if type(actual) is not type(expected) or actual != expected:
            raise ValueError(f"D0 evidence pin or safety invariant mismatch: {key}")

    if evidence.get("artifactSha256") != actual_artifact_sha256 or actual_artifact_sha256 != OFFICIAL_SHA256:
        raise ValueError("D0 artifact hash is not the official pinned hash")

    for key, filename in HASHED_EVIDENCE_FILES.items():
        actual = evidence.get(key)
        if not isinstance(actual, str) or not re.fullmatch(r"[0-9a-f]{64}", actual):
            raise ValueError(f"D0 evidence invalid hash: {key}")
        if _sha256(_regular_file(root, filename)) != actual:
            raise ValueError(f"D0 evidence file digest mismatch: {filename}")

    for key in ("dependsSourceCacheFileCount", "focalBootstrapPackageCount"):
        if type(evidence.get(key)) is not int or evidence[key] <= 0:
            raise ValueError(f"D0 evidence invalid package/source count: {key}")

    snapshot = evidence.get("focalSnapshotId")
    if not isinstance(snapshot, str) or not re.fullmatch(r"20\d{6}T\d{6}Z", snapshot):
        raise ValueError("D0 evidence invalid Focal snapshot ID")
    if evidence.get("focalSnapshotUrl") != f"https://snapshot.ubuntu.com/ubuntu/{snapshot}":
        raise ValueError("D0 evidence snapshot URL and ID differ")
    if evidence.get("officialFocalManifestVariant") not in ("KunNw0n", "slightlyskepticalpotat"):
        raise ValueError("D0 evidence unknown official Focal manifest variant")

    return evidence
