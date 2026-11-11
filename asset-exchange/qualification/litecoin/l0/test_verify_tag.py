"""LTC source-tag signature verification guards (isolated offline fixtures only)."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import verify_tag as tag
from verify_release import RELEASE, SOURCE_COMMIT

FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567"


def oid(data: bytes) -> str:
    return hashlib.sha1(b"tag " + str(len(data)).encode() + b"\0" + data).hexdigest()


class SignedTagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="ltc-tag-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tag = self.root / "v0.21.5.8.tag"
        self.keyring = self.root / "trusted-public.gpg"
        self.keyring.write_bytes(b"public-fixture-only")

    def test_tag_sha_is_not_plain_file_sha(self) -> None:
        self.assertEqual(len(tag.TAG_OBJECT_SHA1), 40)
        self.assertNotEqual(oid(b"sample tag"), hashlib.sha1(b"sample tag").hexdigest())
        with self.assertRaisesRegex(ValueError, "object_oid_mismatch"):
            tag.split_signed_tag(b"object invalid\n")

    def test_invalid_fingerprint_rejected_before_gpg(self) -> None:
        self.tag.write_bytes(b"invalid")
        with patch.object(tag.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "fingerprint_required"):
                tag.verify_tag(self.tag, self.keyring, "short-id")
            run.assert_not_called()

    def test_symlink_and_oversize_rejected(self) -> None:
        self.tag.write_bytes(b"x" * (tag.MAX_TAG_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "tag_size_invalid"):
            tag.verify_tag(self.tag, self.keyring, FINGERPRINT)
        link = self.root / "linked.tag"
        try:
            link.symlink_to(self.tag)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink unsupported")
        with self.assertRaisesRegex(ValueError, "symlink_forbidden"):
            tag.verify_tag(link, self.keyring, FINGERPRINT)

    def test_incomplete_or_retargeted_tag_rejected(self) -> None:
        base = (f"object {SOURCE_COMMIT}\ntype commit\ntag {RELEASE}\n"
                "tagger Fixture <fixture@example.invalid> 1788975885 -0400\n\n"
                f"{RELEASE}\n").encode()
        sig = tag.SIGNATURE_START + b"abc\n" + tag.SIGNATURE_END
        for raw in (base + sig, base + sig + sig,
                    base.replace(SOURCE_COMMIT.encode(), b"0" * 40) + sig,
                    base + tag.SIGNATURE_START + b"abc"):
            with self.subTest(length=len(raw)), patch.object(tag, "TAG_OBJECT_SHA1", oid(raw)):
                if raw == base + sig:
                    # Only structural validity: signature cryptography checked by GPG.
                    tag.split_signed_tag(raw)
                else:
                    with self.assertRaises(ValueError):
                        tag.split_signed_tag(raw)

    def test_gpg_expiration_rejected_despite_zero_exit(self) -> None:
        raw = (f"object {SOURCE_COMMIT}\ntype commit\ntag {RELEASE}\n"
               "tagger Fixture <fixture@example.invalid> 1788975885 -0400\n\n"
               f"{RELEASE}\n").encode() + tag.SIGNATURE_START + b"fixture\n" + tag.SIGNATURE_END
        self.tag.write_bytes(raw)
        simulated = subprocess.CompletedProcess(
            [], 0, stdout=b"",
            stderr=(f"[GNUPG:] GOODSIG {FINGERPRINT[-16:]} Test\n"
                    f"[GNUPG:] VALIDSIG {FINGERPRINT} 2026-09-09 1788975885 0 4 0 1 10 00 {FINGERPRINT}\n"
                    "[GNUPG:] EXPKEYSIG 3620E9D387E55666 Expired\n").encode(),
        )
        with patch.object(tag, "TAG_OBJECT_SHA1", oid(raw)), patch.object(
                tag.subprocess, "run", return_value=simulated):
            with self.assertRaisesRegex(ValueError, "gpg_rejected_signature"):
                tag.verify_tag(self.tag, self.keyring, FINGERPRINT)

    @unittest.skipUnless(shutil.which("gpg"), "GnuPG required for real detached signature test")
    def test_real_ephemeral_signature_and_tamper(self) -> None:
        home = self.root / "fixture-gnupg"
        home.mkdir(mode=0o700)
        cmd = ["gpg", "--batch", "--yes", "--homedir", str(home),
               "--pinentry-mode", "loopback", "--passphrase", ""]
        def run(*argv: str) -> subprocess.CompletedProcess:
            return subprocess.run(cmd + list(argv), capture_output=True,
                                  check=True, timeout=25)
        uid = "LTC L0 tag test <ltc-tag-test@example.invalid>"
        run("--quick-generate-key", uid, "ed25519", "sign", "0")
        listing = run("--with-colons", "--fingerprint", "--list-keys", uid).stdout.decode()
        fprs = [line.split(":")[9] for line in listing.splitlines()
                if line.startswith("fpr:")]
        self.assertEqual(len(fprs), 1)
        fpr = fprs[0]
        run("--output", str(self.keyring), "--export", fpr)
        payload = (f"object {SOURCE_COMMIT}\ntype commit\ntag {RELEASE}\n"
                   "tagger Fixture <fixture@example.invalid> 1788975885 -0400\n\n"
                   f"{RELEASE}\n").encode()
        unsigned = self.root / "tag.payload"
        signature = self.root / "tag.sig"
        unsigned.write_bytes(payload)
        run("--armor", "--local-user", fpr, "--detach-sign",
            "--output", str(signature), str(unsigned))
        raw = payload + signature.read_bytes()
        self.tag.write_bytes(raw)
        with patch.object(tag, "TAG_OBJECT_SHA1", oid(raw)):
            result = tag.verify_tag(self.tag, self.keyring, fpr)
        self.assertTrue(result["tagSignatureCryptographicallyVerifiedWithProvidedKey"])
        self.assertFalse(result["l0Qualified"])
        self.assertFalse(result["settlementEnabled"])
        altered = payload.replace(SOURCE_COMMIT.encode(), b"0" * 40) + signature.read_bytes()
        self.tag.write_bytes(altered)
        with patch.object(tag, "TAG_OBJECT_SHA1", oid(altered)):
            with self.assertRaisesRegex(ValueError, "tag_payload_mismatch"):
                tag.verify_tag(self.tag, self.keyring, fpr)
        tampered_sig = raw.replace(b"-----END PGP SIGNATURE-----",
                                   b"-----END PGP SIGNATURE----X")
        self.tag.write_bytes(tampered_sig)
        with patch.object(tag, "TAG_OBJECT_SHA1", oid(tampered_sig)):
            with self.assertRaisesRegex(ValueError, "armor_invalid"):
                tag.verify_tag(self.tag, self.keyring, fpr)


if __name__ == "__main__":
    unittest.main()
