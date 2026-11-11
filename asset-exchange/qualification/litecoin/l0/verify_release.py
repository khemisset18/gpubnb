#!/usr/bin/env python3
"""Offline Litecoin Core L0 binary release verifier (no node or network access).

Checks a local binary archive against both the reviewed Litecoin release pin
and an independently fingerprint-pinned GPG signature on SHA256SUMS.asc.
The caller must obtain the public key fingerprint through an independent,
trusted channel. Successful validation is NOT L0 completion, native execution,
signer qualification, or permission to move funds.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

RELEASE = "v0.21.5.8"
SOURCE_COMMIT = "ec1b6489a900d09cf5991e220dce089c77a232a2"
ARCHIVE_NAME = "litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz"
ARCHIVE_SHA256 = "43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9"
ARCHIVE_SIZE_BYTES = 36_951_482
RELEASE_URL = "https://github.com/litecoin-project/litecoin/releases/tag/v0.21.5.8"
MAX_SUMS_BYTES = 128 * 1024
FINGERPRINT = re.compile(r"[A-F0-9]{40}\Z")
SUM_LINE = re.compile(r"([0-9a-f]{64})  ([A-Za-z0-9_.-]+)\Z")
REJECT_STATUS = {
    "BADSIG", "ERRSIG", "REVKEYSIG", "EXPKEYSIG", "EXPSIG",
    "KEYREVOKED", "KEYEXPIRED", "SIGEXPIRED", "NODATA", "NO_PUBKEY",
    "DECRYPTION_FAILED", "TRUST_NEVER",
}


def regular_file(path: Path, description: str) -> None:
    if path.is_symlink():
        raise ValueError(f"ltc_l0_{description}_symlink_forbidden")
    details = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"ltc_l0_{description}_regular_file_required")


def archive_sha256(archive: Path, expected_sha: str, expected_size: int) -> None:
    regular_file(archive, "archive")
    if archive.name != ARCHIVE_NAME:
        raise ValueError("ltc_l0_archive_filename_mismatch")
    if archive.stat().st_size != expected_size:
        raise ValueError("ltc_l0_archive_size_mismatch")
    digest = hashlib.sha256()
    with archive.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        raise ValueError("ltc_l0_archive_sha256_mismatch")


def signed_checksum_entry(content: bytes, name: str) -> str:
    if len(content) > MAX_SUMS_BYTES or not content or b"\r" in content:
        raise ValueError("ltc_l0_checksum_content_invalid")
    try:
        lines = content.decode("ascii").splitlines()
    except UnicodeDecodeError as exc:
        raise ValueError("ltc_l0_checksum_ascii_required") from exc
    if not lines or len(lines) > 250 or any(not line for line in lines):
        raise ValueError("ltc_l0_checksum_lines_invalid")
    found: dict[str, str] = {}
    for line in lines:
        match = SUM_LINE.fullmatch(line)
        if match is None:
            raise ValueError("ltc_l0_checksum_line_invalid")
        digest, filename = match.groups()
        if filename in found:
            raise ValueError("ltc_l0_checksum_duplicate_name")
        found[filename] = digest
    if name not in found:
        raise ValueError("ltc_l0_checksum_missing_archive")
    return found[name]


def assert_signer(status: bytes, expected_fingerprint: str) -> None:
    fingerprint = expected_fingerprint.upper()
    if FINGERPRINT.fullmatch(fingerprint) is None:
        raise ValueError("ltc_l0_full_signer_fingerprint_required")
    try:
        lines = status.decode("utf-8", errors="strict").splitlines()
    except UnicodeDecodeError as exc:
        raise ValueError("ltc_l0_gpg_status_invalid") from exc
    good_key_ids: list[str] = []
    valid: list[tuple[str, str]] = []
    for line in lines:
        if not line.startswith("[GNUPG:] "):
            continue
        fields = line[len("[GNUPG:] "):].split()
        if not fields:
            continue
        status_code = fields[0]
        if status_code in REJECT_STATUS:
            raise ValueError("ltc_l0_gpg_rejected_signature")
        if status_code == "GOODSIG":
            if len(fields) < 2 or re.fullmatch(r"[A-F0-9]{16}", fields[1]) is None:
                raise ValueError("ltc_l0_gpg_goodsig_malformed")
            good_key_ids.append(fields[1])
        elif status_code == "VALIDSIG":
            # GnuPG format: signing fingerprint, date, timestamp, expiry,
            # signature version, reserved, public-key algorithm, hash
            # algorithm, signature class, optional primary fingerprint.
            # Never mistake arbitrary trailing fields for a primary key.
            if len(fields) not in (10, 11) or FINGERPRINT.fullmatch(fields[1]) is None:
                raise ValueError("ltc_l0_gpg_validsig_malformed")
            if any(not fields[i].isdigit() for i in (3, 4, 5, 6, 7, 8)):
                raise ValueError("ltc_l0_gpg_validsig_malformed")
            primary = fields[10] if len(fields) == 11 else fields[1]
            if FINGERPRINT.fullmatch(primary) is None:
                raise ValueError("ltc_l0_gpg_validsig_malformed")
            valid.append((fields[1], primary))
    if (len(good_key_ids) != 1 or len(valid) != 1
            or good_key_ids[0] != valid[0][0][-16:]
            or fingerprint not in valid[0]):
        raise ValueError("ltc_l0_signer_fingerprint_mismatch")

def verify_release(archive: Path, signed_sums: Path, keyring: Path, signer_fingerprint: str) -> dict:
    # Fail without any GPG execution if the operator supplies an unbounded or
    # ambiguous input. No key lookup, network or default personal keyring.
    if FINGERPRINT.fullmatch(signer_fingerprint.upper()) is None:
        raise ValueError("ltc_l0_full_signer_fingerprint_required")
    for path, name in ((archive, "archive"), (signed_sums, "checksum"), (keyring, "keyring")):
        regular_file(path, name)
    if signed_sums.name != "SHA256SUMS.asc":
        raise ValueError("ltc_l0_signed_checksum_filename_mismatch")
    if signed_sums.stat().st_size > MAX_SUMS_BYTES:
        raise ValueError("ltc_l0_signed_checksum_oversized")
    # Check the exact reviewed binary independently of what the signer says.
    archive_sha256(archive, ARCHIVE_SHA256, ARCHIVE_SIZE_BYTES)
    with tempfile.TemporaryDirectory(prefix="ltc-l0-gpg-") as home:
        args = ["gpg", "--batch", "--no-tty", "--no-options", "--homedir", home,
                "--no-auto-key-retrieve", "--no-default-keyring", "--keyring", str(keyring.resolve()),
                "--status-fd", "2", "--decrypt", str(signed_sums.resolve())]
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=False)
    if result.returncode != 0:
        raise ValueError("ltc_l0_gpg_signature_invalid")
    assert_signer(result.stderr, signer_fingerprint)
    if signed_checksum_entry(result.stdout, ARCHIVE_NAME) != ARCHIVE_SHA256:
        raise ValueError("ltc_l0_signed_checksum_disagrees_with_release_pin")
    return {
        "releaseTag": RELEASE,
        "sourceCommitMetadataPin": SOURCE_COMMIT,
        "archiveName": ARCHIVE_NAME,
        "archiveSha256": ARCHIVE_SHA256,
        "fingerprintPin": signer_fingerprint.upper(),
        "binaryChecksumAndSignatureVerified": True,
        "sourceTagSignatureIndependentlyVerified": False,
        "sourceBuildReproduced": False,
        "litecoinNodeExecuted": False,
        "networkIdentityVerified": False,
        "l0Qualified": False,
        "settlementEnabled": False,
        "status": "L0_PARTIAL_BINARY_PROVENANCE_ONLY",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--signed-sums", type=Path, required=True)
    parser.add_argument("--trusted-keyring", type=Path, required=True)
    parser.add_argument("--trusted-fingerprint", required=True,
                        help="40-hex fingerprint verified independently of this repository")
    opts = parser.parse_args()
    try:
        result = verify_release(opts.archive, opts.signed_sums, opts.trusted_keyring, opts.trusted_fingerprint)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({"ok": False, "status": "L0_BLOCKED", "reason": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
