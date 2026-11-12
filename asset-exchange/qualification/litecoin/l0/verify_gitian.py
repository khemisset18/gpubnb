#!/usr/bin/env python3
"""Fail-closed offline check of two Litecoin Gitian signed build assertions.

This verifies public builders' detached OpenPGP attestations and that their
*claimed* complete output manifests match the reviewed release hash.
It DOES NOT reproduce a build, independently authenticate builder identities,
certify the OS/toolchain, run a native Litecoin binary or qualify L0.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from verify_release import (
    ARCHIVE_NAME, ARCHIVE_SHA256, FINGERPRINT, SOURCE_COMMIT,
    assert_signer, regular_file,
)

GITIAN_REPOSITORY_SHA = "257e8c5e128c40091b9fcd0f7d2327587d04742d"
ASSERT_NAME = "litecoin-core-linux-0.21-build.assert"
SIG_NAME = ASSERT_NAME + ".sig"
MAX_ASSERT_BYTES = 256 * 1024
MAX_SIG_BYTES = 16 * 1024
MAX_KEYRING_BYTES = 128 * 1024
CHECKSUM_ENTRY = re.compile(r"([0-9a-f]{64})  ([A-Za-z0-9_.+/\-]+)\Z")
SOURCE_ENTRY = f"git:{SOURCE_COMMIT} litecoin"


def extract_block(lines: list[str], header: str) -> list[str]:
    indices = [i for i, line in enumerate(lines) if line == header]
    if len(indices) != 1:
        raise ValueError("ltc_l0_gitian_block_missing_or_duplicate")
    contents = []
    for line in lines[indices[0] + 1:]:
        if not line.startswith("    "):
            break
        if not line[4:]:
            raise ValueError("ltc_l0_gitian_empty_block_line")
        contents.append(line[4:])
    if not contents:
        raise ValueError("ltc_l0_gitian_empty_manifest")
    return contents


def assertion_manifests(assertion: bytes) -> dict[str, str]:
    if not assertion or len(assertion) > MAX_ASSERT_BYTES or b"\r" in assertion:
        raise ValueError("ltc_l0_gitian_assertion_size_or_newlines")
    try:
        lines = assertion.decode("ascii").splitlines()
    except UnicodeDecodeError as exc:
        raise ValueError("ltc_l0_gitian_non_ascii") from exc
    if not lines or lines[0] != "--- !!omap":
        raise ValueError("ltc_l0_gitian_assertion_header_invalid")
    outputs = extract_block(lines, "- out_manifest: |")
    inputs = extract_block(lines, "- in_manifest: |-")
    if lines.count("- release: 0.21.5.8-linux") != 1 or lines.count(
            "- name: litecoin-core-linux-0.21") != 1:
        raise ValueError("ltc_l0_gitian_release_profile_invalid")
    if inputs.count(SOURCE_ENTRY) != 1:
        raise ValueError("ltc_l0_gitian_source_commit_mismatch")
    found: dict[str, str] = {}
    for line in outputs:
        match = CHECKSUM_ENTRY.fullmatch(line)
        if match is None:
            raise ValueError("ltc_l0_gitian_output_line_invalid")
        digest, name = match.groups()
        if name.startswith(("/", "./")) or ".." in name.split("/"):
            raise ValueError("ltc_l0_gitian_output_path_invalid")
        if name in found:
            raise ValueError("ltc_l0_gitian_duplicate_output")
        found[name] = digest
    if len(found) < 2 or found.get(ARCHIVE_NAME) != ARCHIVE_SHA256:
        raise ValueError("ltc_l0_gitian_release_archive_hash_mismatch")
    return found


def verify_attestation(assertion: Path, signature: Path, keyring: Path,
                       fingerprint: str) -> tuple[dict[str, str], str]:
    if FINGERPRINT.fullmatch(fingerprint.upper()) is None:
        raise ValueError("ltc_l0_full_signer_fingerprint_required")
    for path, description, maximum in (
        (assertion, "assertion", MAX_ASSERT_BYTES),
        (signature, "signature", MAX_SIG_BYTES),
        (keyring, "keyring", MAX_KEYRING_BYTES),
    ):
        regular_file(path, description)
        if path.stat().st_size > maximum:
            raise ValueError(f"ltc_l0_{description}_oversized")
    if assertion.name != ASSERT_NAME or signature.name != SIG_NAME:
        raise ValueError("ltc_l0_gitian_filename_mismatch")
    manifest = assertion_manifests(assertion.read_bytes())
    with tempfile.TemporaryDirectory(prefix="ltc-l0-gitian-") as home:
        argv = [
            "gpg", "--batch", "--no-tty", "--no-options", "--homedir", home,
            "--no-auto-key-retrieve", "--no-default-keyring",
            "--keyring", str(keyring.resolve()), "--status-fd", "2",
            "--verify", str(signature.resolve()), str(assertion.resolve()),
        ]
        result = subprocess.run(
            argv, stdin=subprocess.DEVNULL,
            capture_output=True, timeout=30, check=False,
        )
    if result.returncode != 0:
        raise ValueError("ltc_l0_gitian_detached_signature_invalid")
    assert_signer(result.stderr, fingerprint)
    return manifest, hashlib.sha256(assertion.read_bytes()).hexdigest()


def verify_pair(david_assertion: Path, david_sig: Path,
                losh_assertion: Path, losh_sig: Path,
                keyring: Path, david_fpr: str, losh_fpr: str) -> dict:
    if david_fpr.upper() == losh_fpr.upper():
        raise ValueError("ltc_l0_gitian_distinct_signers_required")
    first, first_digest = verify_attestation(
        david_assertion, david_sig, keyring, david_fpr)
    second, second_digest = verify_attestation(
        losh_assertion, losh_sig, keyring, losh_fpr)
    if first != second:
        raise ValueError("ltc_l0_gitian_build_outputs_diverge")
    return {
        "gitianRepositoryCommit": GITIAN_REPOSITORY_SHA,
        "sourceCommit": SOURCE_COMMIT,
        "archiveName": ARCHIVE_NAME,
        "archiveSha256": ARCHIVE_SHA256,
        "matchingOutputFiles": len(first),
        "assertionSha256ByBuilder": {
            "davidburkett38": first_digest,
            "losh11": second_digest,
        },
        "bothDetachedSignaturesVerified": True,
        "independentlyAuthenticatedBuilders": False,
        "independentSourceBuildReproduced": False,
        "l0Qualified": False,
        "settlementEnabled": False,
        "status": "L0_PARTIAL_SIGNED_GITIAN_ASSERTIONS_ONLY",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("david-assertion", "david-sig", "losh-assertion",
                   "losh-sig", "trusted-keyring"):
        parser.add_argument("--" + option, type=Path, required=True)
    parser.add_argument("--david-fingerprint", required=True)
    parser.add_argument("--losh-fingerprint", required=True)
    args = parser.parse_args()
    try:
        result = verify_pair(
            args.david_assertion, args.david_sig, args.losh_assertion,
            args.losh_sig, args.trusted_keyring, args.david_fingerprint,
            args.losh_fingerprint,
        )
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({
            "ok": False, "status": "L0_BLOCKED", "reason": str(exc),
        }, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
