#!/usr/bin/env python3
"""Offline, non-executing Stage 4 provenance/PE verifier (standard library only).

The manifest hash, commit and public certificate pin MUST come from the trusted
CI run, not from the directory being checked. Authenticode is checked separately
by verify-stage4-package.ps1 on Windows. No hardware qualification is implied.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
from pathlib import Path

NAMES = ("gpubnb-agent.exe", "gpubnb-windows-stream.exe",
         "gpubnb-windows-worker.exe", "GPUbnbWindowsMedia.dll")
PROTOCOLS = {"worker": 1, "mediaTransport": 2, "browserMedia": 1,
             "browserInput": 1, "mediaAbi": 2}
HEX = re.compile(r"^[0-9a-f]{64}$")


def require(ok, code):
    if not ok:
        raise ValueError(code)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pe_info(path):
    b = Path(path).read_bytes()
    require(len(b) >= 512 and b[:2] == b"MZ", "stage4_invalid_pe")
    p = struct.unpack_from("<I", b, 60)[0]
    require(64 <= p <= len(b) - 264 and b[p:p+4] == b"PE\0\0", "stage4_invalid_pe")
    machine, count = struct.unpack_from("<HH", b, p+4)
    opt_size = struct.unpack_from("<H", b, p+20)[0]
    o = p+24
    require(machine == 0x8664 and struct.unpack_from("<H", b, o)[0] == 0x20B,
            "stage4_not_amd64")
    require(opt_size >= 240 and 1 <= count <= 96 and o+opt_size+count*40 <= len(b),
            "stage4_invalid_pe_sections")
    require(struct.unpack_from("<I", b, o+108)[0] >= 14, "stage4_invalid_pe_directories")
    sections = []
    for i in range(count):
        start = o+opt_size+i*40
        virtual_size, rva, raw_size, raw = struct.unpack_from("<IIII", b, start+8)
        require(raw+raw_size <= len(b), "stage4_invalid_pe_section_bounds")
        sections.append((rva, max(virtual_size, raw_size), raw, raw_size))

    def at(rva, size):
        for base, length, raw, raw_size in sections:
            delta = rva-base
            if 0 <= delta and delta+size <= min(length, raw_size):
                return raw+delta
        raise ValueError("stage4_invalid_pe_rva")

    imports = set()
    for directory, stride, name_offset in ((1, 20, 12), (13, 32, 4)):
        rva, size = struct.unpack_from("<II", b, o+112+directory*8)
        if not rva:
            require(size == 0, "stage4_invalid_pe_import_directory")
            continue
        require(stride <= size <= 1024*1024, "stage4_invalid_pe_import_directory")
        terminated = False
        for i in range(min(size//stride, 512)):
            offset = at(rva+i*stride, stride)
            descriptor = b[offset:offset+stride]
            if not any(descriptor):
                terminated = True
                break
            if directory == 13:
                require(struct.unpack_from("<I", descriptor)[0] == 1,
                        "stage4_delay_import_must_use_rva")
            name_rva = struct.unpack_from("<I", descriptor, name_offset)[0]
            name_start = at(name_rva, 1)
            end = b.find(b"\0", name_start, min(name_start+260, len(b)))
            require(end != -1, "stage4_invalid_import_name")
            name = b[name_start:end].decode("ascii").lower()
            require(re.fullmatch(r"[a-z0-9_.-]+\.dll", name) is not None,
                    "stage4_invalid_import_name")
            imports.add(name)
        require(terminated, "stage4_unterminated_imports")
    cert_offset, cert_size = struct.unpack_from("<II", b, o+112+4*8)
    require((cert_offset == 0 and cert_size == 0) or
            (cert_offset > 0 and cert_size >= 8 and cert_offset+cert_size <= len(b)),
            "stage4_invalid_certificate_table")
    return {"architecture": "AMD64", "imports": sorted(imports),
            "certificateTablePresent": bool(cert_size)}


def check_identity(identity, commit, publisher):
    a, h, w, m = (identity[x] for x in ("agent", "helper", "worker", "media"))
    require(a.get("frozen") is True and a.get("agentVersion") == "0.6.6" and
            a.get("buildCommit") == commit[:12], "stage4_agent_identity_mismatch")
    require(h.get("sourceCommit") == w.get("sourceCommit") == m.get("sourceCommit") == commit,
            "stage4_component_commit_mismatch")
    require(h.get("workerSignerSha256") == w.get("mediaSignerSha256") == publisher,
            "stage4_embedded_pin_mismatch")
    require(h.get("mutationAuthority") == "release-candidate", "stage4_wrong_helper_authority")
    for field, key in (("workerProtocol", "worker"), ("mediaTransportProtocol", "mediaTransport"),
                       ("browserMediaProtocol", "browserMedia"), ("browserInputProtocol", "browserInput")):
        require(h.get(field) == PROTOCOLS[key], "stage4_protocol_mismatch")
    require(m.get("mediaAbi") == 2 and m.get("nvencApi") == "13.0", "stage4_media_abi_mismatch")


def verify(directory, manifest_hash, commit, publisher, status="unsigned"):
    root = Path(directory).resolve(strict=True)
    require(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, "stage4_exact_commit_required")
    require(HEX.fullmatch(publisher) is not None and len(set(publisher)) > 1,
            "stage4_real_publisher_pin_required")
    manifest = root / "stage4.manifest.json"
    require(HEX.fullmatch(manifest_hash) is not None and sha(manifest) == manifest_hash,
            "stage4_manifest_hash_mismatch")
    m = json.loads(manifest.read_text(encoding="utf-8-sig"))
    expected_kind = "STAGE4_UNSIGNED_PRIVATE_CANDIDATE" if status == "unsigned" else "LOCAL_TEST_ONLY_NOT_RELEASE"
    require(m.get("schemaVersion") == 2 and m.get("kind") == expected_kind and
            m.get("signatureStatus") == status and m.get("installable") is False and
            m.get("publicBookabilityEnabled") is False and m.get("iddDriverIncluded") is False,
            "stage4_private_package_policy_mismatch")
    require(m.get("sourceCommit") == commit, "stage4_manifest_commit_mismatch")
    require(m.get("publisherSha256") == publisher, "stage4_manifest_publisher_mismatch")
    require(m.get("protocols") == PROTOCOLS, "stage4_protocol_mismatch")
    records = m.get("files", [])
    require(len(records) == 4 and sorted(x.get("name", "") for x in records) == sorted(NAMES),
            "stage4_exactly_four_components_required")
    for p in root.rglob("*"):
        require(not p.is_symlink(), "stage4_link_forbidden")
        if p.is_file():
            require(p.suffix.lower() not in (".pfx", ".p12", ".pem", ".key", ".env") and
                    not p.name.lower().startswith(".env"), "stage4_key_or_secret_file_forbidden")
            if p.suffix.lower() in (".dll", ".exe"):
                require(p.parent == root and p.name in NAMES, "stage4_unexpected_binary")
    for record in records:
        p = root / record["name"]
        require(p.is_file(), "stage4_component_missing:"+record["name"])
        require(sha(p) == record.get("sha256"), "stage4_component_hash_mismatch:"+record["name"])
        info = pe_info(p)
        require(info["architecture"] == record.get("architecture") and
                info["imports"] == record.get("imports"), "stage4_pe_metadata_mismatch")
        if status == "unsigned":
            require(not info["certificateTablePresent"], "stage4_source_must_be_unsigned")
        else:
            require(info["certificateTablePresent"], "stage4_signature_table_missing")
    identity_path = root / "build-identities.json"
    require(sha(identity_path) == m.get("buildIdentitiesSha256"), "stage4_identity_hash_mismatch")
    check_identity(json.loads(identity_path.read_text(encoding="utf-8-sig")), commit, publisher)
    if status == "private-signed":
        require(HEX.fullmatch(m.get("unsignedManifestSha256", "")) is not None,
                "stage4_unsigned_provenance_missing")
    return m


def create(directory, commit, publisher):
    root = Path(directory)
    check_identity(json.loads((root/"build-identities.json").read_text(encoding="utf-8-sig")), commit, publisher)
    m = {"schemaVersion": 2, "kind": "STAGE4_UNSIGNED_PRIVATE_CANDIDATE",
         "signatureStatus": "unsigned", "sourceCommit": commit, "publisherSha256": publisher,
         "protocols": PROTOCOLS, "installable": False, "iddDriverIncluded": False,
         "publicBookabilityEnabled": False, "nvencApi": "13.0",
         "nvCodecHeadersCommit": "e844e5b26f46bb77479f063029595293aa8f812d",
         "minimumNvidiaWindowsDriver": "570.00", "agentVersion": "0.6.6",
         "buildIdentitiesSha256": sha(root/"build-identities.json"),
         "files": [{"name": n, "sha256": sha(root/n), **pe_info(root/n)} for n in NAMES]}
    (root/"stage4.manifest.json").write_text(json.dumps(m, indent=2)+"\n", encoding="utf-8")
    digest = sha(root/"stage4.manifest.json")
    verify(root, digest, commit, publisher)
    sums = [f"{x['sha256']}  {x['name']}" for x in m["files"]]
    sums.append(f"{digest}  stage4.manifest.json")
    (root/"SHA256SUMS").write_text("\n".join(sums)+"\n", encoding="ascii")
    return {"ok": True, "manifestSha256": digest, "sourceCommit": commit, "filesVerified": 4,
            "signatureStatus": "unsigned", "installable": False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=("create", "verify", "inspect"))
    p.add_argument("--directory")
    p.add_argument("--file")
    p.add_argument("--commit")
    p.add_argument("--publisher")
    p.add_argument("--manifest-sha256")
    p.add_argument("--status", choices=("unsigned", "private-signed"), default="unsigned")
    a = p.parse_args()
    if a.command == "inspect":
        print(json.dumps(pe_info(a.file)))
    elif a.command == "create":
        print(json.dumps(create(a.directory, a.commit, a.publisher)))
    else:
        verify(a.directory, a.manifest_sha256, a.commit, a.publisher, a.status)
        print(json.dumps({"ok": True, "filesVerified": 4, "signatureStatus": a.status,
                          "authenticodeVerified": False, "hardwareQualified": False}))


if __name__ == "__main__":
    main()
