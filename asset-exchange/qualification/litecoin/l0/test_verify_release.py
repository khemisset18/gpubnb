"""LTC L0 offline-only security tests: no downloaded binary, key or live node."""
from __future__ import annotations

import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import verify_release as ltc

FPR = "0123456789ABCDEF0123456789ABCDEF01234567"
OTHER = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
GOOD_STATUS = f"[GNUPG:] GOODSIG 0123456789ABCDEF Test Signer\n[GNUPG:] VALIDSIG {FPR}\n".encode()
VALID_SUMS = f"{ltc.ARCHIVE_SHA256}  {ltc.ARCHIVE_NAME}\n".encode()


class LitecoinL0Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.archive = root / ltc.ARCHIVE_NAME
        self.archive.write_bytes(b"offline-test-archive")
        self.sums = root / "SHA256SUMS.asc"
        self.sums.write_bytes(b"offline-test-signed-checksum")
        self.keyring = root / "trusted-public.gpg"
        self.keyring.write_bytes(b"public-fixture-only")

    def test_official_release_metadata_matches_existing_litecoin_spec(self) -> None:
        spec = (Path(__file__).resolve().parents[4] / "docs" / "asset-exchange" /
                "LITECOIN_ADAPTER_SPEC_V1.md").read_text(encoding="utf-8")
        for value in (ltc.RELEASE.lstrip("v"), ltc.SOURCE_COMMIT[:7], ltc.ARCHIVE_NAME, ltc.ARCHIVE_SHA256):
            self.assertIn(value, spec)
        self.assertEqual(len(ltc.SOURCE_COMMIT), 40)
        self.assertEqual(len(ltc.ARCHIVE_SHA256), 64)

    def test_signed_manifest_exact_name_and_digest(self) -> None:
        self.assertEqual(ltc.signed_checksum_entry(VALID_SUMS, ltc.ARCHIVE_NAME), ltc.ARCHIVE_SHA256)
        other = b"f" * 64 + b"  second-archive.tar.gz\n"
        self.assertEqual(ltc.signed_checksum_entry(other + VALID_SUMS, ltc.ARCHIVE_NAME), ltc.ARCHIVE_SHA256)

    def test_malformed_or_dangerous_manifest_rejected(self) -> None:
        hostile = (
            b"", VALID_SUMS + VALID_SUMS, VALID_SUMS + b"\n",
            VALID_SUMS.replace(b"  ", b" *"), VALID_SUMS.replace(b".tar.gz", b"../escape.tar.gz"),
            VALID_SUMS.replace(b"  ", b"\t"), VALID_SUMS.replace(b"\n", b"\r\n"),
            VALID_SUMS.replace(b"  ", b"   "), b"\xff" + VALID_SUMS,
            b"f" * (ltc.MAX_SUMS_BYTES + 1),
        )
        for item in hostile:
            with self.subTest(value=item[:50]):
                with self.assertRaises(ValueError):
                    ltc.signed_checksum_entry(item, ltc.ARCHIVE_NAME)

    def test_valid_signature_requires_single_full_pinned_fingerprint(self) -> None:
        ltc.assert_signer(GOOD_STATUS, FPR.lower())
        for status, fingerprint in (
            (GOOD_STATUS, OTHER),
            (GOOD_STATUS, "0123456789ABCDEF"),
            (GOOD_STATUS.replace(b"VALIDSIG", b"BADSIG"), FPR),
            (GOOD_STATUS.replace(b"GOODSIG", b"ERRSIG"), FPR),
            (GOOD_STATUS + GOOD_STATUS, FPR),
            (b"[GNUPG:] GOODSIG 0 Test\n", FPR),
            (b"[GNUPG:] VALIDSIG " + FPR.encode(), FPR),
            (GOOD_STATUS + b"[GNUPG:] REVKEYSIG 0 Test\n", FPR),
            (GOOD_STATUS + b"[GNUPG:] EXPKEYSIG 0 Test\n", FPR),
            (GOOD_STATUS + b"[GNUPG:] SIGEXPIRED\n", FPR),
            (GOOD_STATUS + b"[GNUPG:] TRUST_NEVER\n", FPR),
        ):
            with self.subTest(status=status[-70:], fingerprint=fingerprint):
                with self.assertRaises(ValueError):
                    ltc.assert_signer(status, fingerprint)

    def test_pinned_primary_fingerprint_may_approve_explicit_subkey(self) -> None:
        subkey = OTHER
        status = (f"[GNUPG:] GOODSIG 0 Test\n[GNUPG:] VALIDSIG {subkey}"
                  f" 2026-09-09 1788975885 0 4 0 1 10 00 {FPR}\n").encode()
        ltc.assert_signer(status, FPR)

    def test_archive_hash_size_and_exact_filename(self) -> None:
        payload = self.archive.read_bytes()
        ltc.archive_sha256(self.archive, hashlib.sha256(payload).hexdigest(), len(payload))
        with self.assertRaisesRegex(ValueError, "size_mismatch"):
            ltc.archive_sha256(self.archive, hashlib.sha256(payload).hexdigest(), len(payload) + 1)
        with self.assertRaisesRegex(ValueError, "sha256_mismatch"):
            ltc.archive_sha256(self.archive, "0" * 64, len(payload))
        alternate = self.archive.with_name("litecoin-wrong-version.tar.gz")
        alternate.write_bytes(payload)
        with self.assertRaisesRegex(ValueError, "filename_mismatch"):
            ltc.archive_sha256(alternate, hashlib.sha256(payload).hexdigest(), len(payload))

    def test_symlink_input_rejected_before_any_gpg_use(self) -> None:
        link = self.archive.with_name("linked-archive")
        try:
            link.symlink_to(self.archive)
        except (OSError, NotImplementedError):
            self.skipTest("OS does not support symlinks")
        with self.assertRaisesRegex(ValueError, "symlink_forbidden"):
            ltc.regular_file(link, "archive")

    def test_real_verifier_must_fail_without_external_fingerprint(self) -> None:
        with patch.object(ltc.subprocess, "run") as call:
            with self.assertRaisesRegex(ValueError, "fingerprint_required"):
                ltc.verify_release(self.archive, self.sums, self.keyring, "unverified")
            call.assert_not_called()

    def test_matching_mock_signature_remains_l0_blocked(self) -> None:
        result = subprocess.CompletedProcess([], 0, stdout=VALID_SUMS, stderr=GOOD_STATUS)
        with patch.object(ltc, "archive_sha256") as verify_hash, patch.object(ltc.subprocess, "run", return_value=result) as gpg:
            proof = ltc.verify_release(self.archive, self.sums, self.keyring, FPR)
        verify_hash.assert_called_once_with(self.archive, ltc.ARCHIVE_SHA256, ltc.ARCHIVE_SIZE_BYTES)
        gpg.assert_called_once()
        argv = gpg.call_args.args[0]
        self.assertIn("--no-default-keyring", argv)
        self.assertIn("--no-options", argv)
        self.assertIn("--batch", argv)
        self.assertNotIn("--recv-keys", argv)
        self.assertFalse(proof["l0Qualified"])
        self.assertFalse(proof["sourceTagSignatureIndependentlyVerified"])
        self.assertFalse(proof["litecoinNodeExecuted"])
        self.assertFalse(proof["settlementEnabled"])
        self.assertEqual(proof["status"], "L0_PARTIAL_BINARY_PROVENANCE_ONLY")

    def test_fake_or_failed_gpg_never_returns_a_proof(self) -> None:
        cases = (
            subprocess.CompletedProcess([], 1, stdout=VALID_SUMS, stderr=GOOD_STATUS),
            subprocess.CompletedProcess([], 0, stdout=VALID_SUMS, stderr=b""),
            subprocess.CompletedProcess([], 0, stdout=VALID_SUMS, stderr=GOOD_STATUS.replace(FPR.encode(), OTHER.encode())),
            subprocess.CompletedProcess([], 0, stdout=VALID_SUMS.replace(ltc.ARCHIVE_SHA256.encode(), b"0" * 64), stderr=GOOD_STATUS),
        )
        for response in cases:
            with self.subTest(returncode=response.returncode, stderr=response.stderr[-40:]):
                with patch.object(ltc, "archive_sha256"), patch.object(ltc.subprocess, "run", return_value=response):
                    with self.assertRaises(ValueError):
                        ltc.verify_release(self.archive, self.sums, self.keyring, FPR)


if __name__ == "__main__":
    unittest.main()
