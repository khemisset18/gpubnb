#!/usr/bin/env python3
"""Offline, fail-closed GPG verification of the pinned annotated Litecoin Core tag.

This tool verifies the *original annotated tag object bytes*, not a GitHub
"verified" badge, a lightweight tag, a remote URL or an unsigned archive.
The operator must authenticate the GPG signing fingerprint separately.
A successful result is only a partial L0 cryptographic fact, not approval
of a signer identity, release binaries, reproducibility or settlement.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from verify_release import FINGERPRINT, RELEASE, SOURCE_COMMIT, assert_signer, regular_file

TAG_OBJECT_SHA1 = "ee2aea3fc3fd95213d1a041d561b52e07ae6dc63"
MAX_TAG_BYTES = 64 * 1024
SIGNATURE_START = b"-----BEGIN PGP SIGNATURE-----\n"
SIGNATURE_END = b"-----END PGP SIGNATURE-----\n"


def split_signed_tag(raw: bytes) -> tuple[bytes, bytes]:
    """Require the exact annotated Git object, then extract the signed bytes."""
    if not raw or len(raw) > MAX_TAG_BYTES:
        raise ValueError("ltc_l0_tag_size_invalid")
    # A Git annotated-tag OID is SHA-1 over the typed object, not over
    # the payload alone. The detached GPG signature authenticates its content.
    header = b"tag " + str(len(raw)).encode("ascii") + b"\0"
    if hashlib.sha1(header + raw).hexdigest() != TAG_OBJECT_SHA1:
        raise ValueError("ltc_l0_tag_object_oid_mismatch")
    start = raw.find(SIGNATURE_START)
    if start < 0 or raw.count(SIGNATURE_START) != 1:
        raise ValueError("ltc_l0_tag_signature_missing_or_ambiguous")
    payload, signature = raw[:start], raw[start:]
    prefix = (
        f"object {SOURCE_COMMIT}\ntype commit\ntag {RELEASE}\ntagger "
    ).encode("ascii")
    if not payload.startswith(prefix) or not payload.endswith(
            b"\n\n" + RELEASE.encode("ascii") + b"\n"):
        raise ValueError("ltc_l0_tag_payload_mismatch")
    if (not signature.endswith(SIGNATURE_END)
            or signature.count(SIGNATURE_END) != 1 or b"\r" in signature):
        raise ValueError("ltc_l0_tag_signature_armor_invalid")
    return payload, signature


def verify_tag(tag_object: Path, keyring: Path, trusted_fingerprint: str) -> dict:
    fingerprint = trusted_fingerprint.upper()
    if FINGERPRINT.fullmatch(fingerprint) is None:
        raise ValueError("ltc_l0_full_signer_fingerprint_required")
    for path, description in ((tag_object, "tag"), (keyring, "keyring")):
        regular_file(path, description)
    if tag_object.stat().st_size > MAX_TAG_BYTES:
        raise ValueError("ltc_l0_tag_size_invalid")
    payload, signature = split_signed_tag(tag_object.read_bytes())
    with tempfile.TemporaryDirectory(prefix="ltc-l0-tag-") as home:
        payload_path = Path(home) / "tag.payload"
        signature_path = Path(home) / "tag.sig"
        payload_path.write_bytes(payload)
        signature_path.write_bytes(signature)
        args = [
            "gpg", "--batch", "--no-tty", "--no-options", "--homedir", home,
            "--no-auto-key-retrieve", "--no-default-keyring",
            "--keyring", str(keyring.resolve()), "--status-fd", "2",
            "--verify", str(signature_path), str(payload_path),
        ]
        result = subprocess.run(
            args, capture_output=True, stdin=subprocess.DEVNULL,
            timeout=30, check=False,
        )
    if result.returncode != 0:
        raise ValueError("ltc_l0_tag_gpg_signature_invalid")
    # GPG can return success even when an EXPIRED key signed the tag.
    # All fail statuses are checked independently of the exit code.
    assert_signer(result.stderr, fingerprint)
    return {
        "releaseTag": RELEASE,
        "sourceCommit": SOURCE_COMMIT,
        "annotatedTagObject": TAG_OBJECT_SHA1,
        "signerFingerprint": fingerprint,
        "tagSignatureCryptographicallyVerifiedWithProvidedKey": True,
        "signerIdentityIndependentlyAuthenticated": False,
        "binaryChecksumAndSignatureVerified": False,
        "sourceBuildReproduced": False,
        "l0Qualified": False,
        "settlementEnabled": False,
        "status": "L0_PARTIAL_SIGNED_TAG_ONLY",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag-object", type=Path, required=True)
    parser.add_argument("--trusted-keyring", type=Path, required=True)
    parser.add_argument("--trusted-fingerprint", required=True)
    opts = parser.parse_args()
    try:
        result = verify_tag(
            opts.tag_object, opts.trusted_keyring, opts.trusted_fingerprint,
        )
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({
            "ok": False, "status": "L0_BLOCKED", "reason": str(exc)
        }, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
