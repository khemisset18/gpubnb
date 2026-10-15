"""Offline integrity check only; never execute or install the archived binaries."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zipfile

SOURCE = "2b055992f7521505d0387dd4c876e36794fffd63"
NAMES = {"gpubnb-windows-stream.exe", "gpubnb-windows-worker.exe",
         "GPUbnbWindowsMedia.dll", "gpubnb-agent.exe"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(manifest, archive):
    require(manifest["kind"] == "gpubnb-stage4-unsigned-amd64-evidence", "wrong_manifest_kind")
    require(manifest["sourceCommit"] == SOURCE, "wrong_source_commit")
    payload = Path(archive).read_bytes()
    require(len(payload) == manifest["archive"]["sizeBytes"], "archive_size_mismatch")
    require(hashlib.sha256(payload).hexdigest() == manifest["archive"]["sha256"], "archive_hash_mismatch")
    files = manifest["files"]
    require(len(files) == 4 and {f["name"] for f in files} == NAMES, "wrong_payload_files")
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        require(len(names) == len(set(names)), "duplicate_zip_members")
        require(all("/" not in n and "\\" not in n for n in names), "non_flat_zip_members")
        ci = json.loads(bundle.read("ci-build-manifest.json"))
        require(ci["sourceCommit"] == SOURCE, "ci_source_mismatch")
        require(ci["workflowCommit"] == manifest["provenance"]["workflowCommit"], "workflow_commit_mismatch")
        require(str(ci["runId"]) == str(manifest["provenance"]["runId"]), "run_id_mismatch")
        require(ci["jobKey"] == manifest["provenance"]["jobKey"], "job_key_mismatch")
        for line in bundle.read("SHA256SUMS").decode("utf-8-sig").splitlines():
            digest, name = line.split("  ", 1)
            require(hashlib.sha256(bundle.read(name)).hexdigest() == digest, "ci_checksum_mismatch:" + name)
        for record in files:
            name = record["name"]
            data = bundle.read(name)
            require(record["sourceCommit"] == SOURCE, "file_source_mismatch:" + name)
            require(record["architecture"] == "AMD64", "file_architecture_mismatch:" + name)
            require(record["signed"] is False and record["installable"] is False, "unsigned_evidence_only:" + name)
            require(record["finalSignedSha256"] is None, "signed_digest_not_allowed:" + name)
            require(len(data) == record["sizeBytes"], "file_size_mismatch:" + name)
            require(hashlib.sha256(data).hexdigest() == record["sha256"], "file_hash_mismatch:" + name)
            original = next(f for f in ci["files"] if f["name"] == name)
            require(original["sha256"] == record["sha256"], "ci_file_hash_mismatch:" + name)
            require(data[:2] == b"MZ", "not_a_pe:" + name)
            pe = struct.unpack_from("<I", data, 0x3C)[0]
            require(data[pe:pe + 4] == b"PE\0\0", "bad_pe_header:" + name)
            require(struct.unpack_from("<H", data, pe + 4)[0] == 0x8664, "not_amd64:" + name)
            require(struct.unpack_from("<H", data, pe + 24)[0] == 0x20B, "not_pe32_plus:" + name)
            require(struct.unpack_from("<I", data, pe + 24 + 112 + 4 * 8 + 4)[0] == 0, "certificate_table_not_empty:" + name)
    require(manifest["security"]["signingPerformed"] is False, "signing_not_allowed")
    require(manifest["status"]["installation"] == "NO-GO", "installation_must_remain_blocked")
    return {"verifiedFiles": len(files), "sourceCommit": SOURCE,
            "archiveSha256": manifest["archive"]["sha256"],
            "binariesExecuted": False, "installationAuthorized": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--archive", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(json.loads(args.manifest.read_text()), args.archive), indent=2))
    except (ValueError, KeyError, StopIteration, struct.error, zipfile.BadZipFile) as error:
        raise SystemExit("verification_failed:" + str(error)) from None
