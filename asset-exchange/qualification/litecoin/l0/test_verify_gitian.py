"""Offline adversarial Gitian manifest and detached-signature guard tests."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import verify_gitian as gitian
from verify_release import ARCHIVE_NAME, ARCHIVE_SHA256, SOURCE_COMMIT

DAVID = "0123456789ABCDEF0123456789ABCDEF01234567"
LOSH = "AABBCCDDEEFF00112233445566778899AABBCCDD"


def assertion(digest: str = ARCHIVE_SHA256, src: str = SOURCE_COMMIT,
              outputs: str = "") -> bytes:
    if not outputs:
        outputs = (f"    {digest}  {ARCHIVE_NAME}\n"
                   f"    {'f' * 64}  src/litecoin-0.21.5.8.tar.gz\n")
    return (f"--- !!omap\n- out_manifest: |\n{outputs}"
            f"- in_manifest: |-\n    {'a' * 64}  descriptor.yml\n"
            f"    git:{src} litecoin\n"
            "- base_manifests: !!omap\n- release: 0.21.5.8-linux\n"
            "- name: litecoin-core-linux-0.21\n- type: build\n- optionals:\n"
           ).encode("ascii")


def gpg_status(fpr: str) -> bytes:
    return (f"[GNUPG:] GOODSIG {fpr[-16:]} Ephemeral\n"
            f"[GNUPG:] VALIDSIG {fpr} 2026-09-09 1788975885 0 4 0 22 10 00 {fpr}\n").encode()


class GitianL0Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.a = root / "david" / gitian.ASSERT_NAME
        self.asig = self.a.with_name(gitian.SIG_NAME)
        self.b = root / "losh" / gitian.ASSERT_NAME
        self.bsig = self.b.with_name(gitian.SIG_NAME)
        for path in (self.a, self.b):
            path.parent.mkdir()
            path.write_bytes(assertion())
        for path in (self.asig, self.bsig):
            path.write_bytes(b"fixture-signature")
        self.keyring = root / "public.gpg"
        self.keyring.write_bytes(b"fixture-keyring")

    def test_valid_manifest_is_exactly_pinned(self) -> None:
        found = gitian.assertion_manifests(assertion())
        self.assertEqual(found[ARCHIVE_NAME], ARCHIVE_SHA256)
        self.assertEqual(len(found), 2)
        self.assertEqual(len(gitian.GITIAN_REPOSITORY_SHA), 40)

    def test_manifest_rejects_tampered_source_archive_and_structure(self) -> None:
        for content in (
            assertion(digest="0" * 64),
            assertion(src="0" * 40),
            assertion() + assertion(),
            assertion().replace(b"--- !!omap", b"--- !python", 1),
            assertion().replace(b"  src/litecoin-", b"  ../litecoin-"),
            assertion().replace(b"- release: 0.21.5.8-linux",
                                b"- release: 0.21.5.7-linux"),
            assertion().replace(b"- in_manifest: |-", b"- in_manifest: >"),
            assertion().replace(b"  src/litecoin-", b"  " + ARCHIVE_NAME.encode() + b"/../../src/litecoin-"),
        ):
            with self.subTest(payload=content[:75]):
                with self.assertRaises(ValueError):
                    gitian.assertion_manifests(content)

    def test_duplicate_outputs_and_mismatched_outputs_rejected(self) -> None:
        duplicate = (f"    {ARCHIVE_SHA256}  {ARCHIVE_NAME}\n" * 2)
        with self.assertRaisesRegex(ValueError, "duplicate_output"):
            gitian.assertion_manifests(assertion(outputs=duplicate))
        distinct = assertion().replace(b"f" * 64, b"a" * 64)
        self.b.write_bytes(distinct)
        responses = iter([
            subprocess.CompletedProcess([], 0, b"", gpg_status(DAVID)),
            subprocess.CompletedProcess([], 0, b"", gpg_status(LOSH)),
        ])
        with patch.object(gitian.subprocess, "run", side_effect=lambda *a, **k: next(responses)):
            with self.assertRaisesRegex(ValueError, "outputs_diverge"):
                gitian.verify_pair(self.a, self.asig, self.b, self.bsig,
                                   self.keyring, DAVID, LOSH)

    def test_bad_fingerprint_rejected_without_gpg(self) -> None:
        with patch.object(gitian.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "fingerprint_required"):
                gitian.verify_attestation(self.a, self.asig, self.keyring, "short")
            run.assert_not_called()

    def test_expired_or_wrong_signer_never_passes(self) -> None:
        statuses = (
            gpg_status(DAVID) + b"[GNUPG:] EXPKEYSIG 66778899AABBCCDD expired\n",
            gpg_status(LOSH),
            gpg_status(DAVID) + b"[GNUPG:] BADSIG 0000000000000000 bad\n",
        )
        for status in statuses:
            with self.subTest(status=status[-60:]), patch.object(
                    gitian.subprocess, "run",
                    return_value=subprocess.CompletedProcess([], 0, b"", status)):
                with self.assertRaises(ValueError):
                    gitian.verify_attestation(self.a, self.asig, self.keyring, DAVID)

    def test_symlink_and_oversize_inputs_rejected(self) -> None:
        self.a.write_bytes(b"y" * (gitian.MAX_ASSERT_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "oversized"):
            gitian.verify_attestation(self.a, self.asig, self.keyring, DAVID)
        # Reset the first adversarial input: isolate the next symlink guard.
        self.a.write_bytes(assertion())
        link = self.a.parent / "link.sig"
        try:
            link.symlink_to(self.asig)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks unsupported")
        with self.assertRaisesRegex(ValueError, "symlink_forbidden"):
            gitian.verify_attestation(self.a, link, self.keyring, DAVID)

    @unittest.skipUnless(shutil.which("gpg"), "GnuPG required for real fixture signature test")
    def test_two_real_ephemeral_detached_signatures(self) -> None:
        home = self.a.parent.parent / "gnupg"
        home.mkdir(mode=0o700)
        prefix = ["gpg", "--batch", "--yes", "--homedir", str(home),
                  "--pinentry-mode", "loopback", "--passphrase", ""]
        def gpg(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(prefix + list(args), capture_output=True, check=True, timeout=25)
        signer = []
        for name in ("david-fixture", "losh-fixture"):
            uid = f"LTC {name} <{name}@example.invalid>"
            gpg("--quick-generate-key", uid, "ed25519", "sign", "0")
            lines = gpg("--with-colons", "--fingerprint", "--list-keys", uid).stdout.decode()
            fprs = [line.split(":")[9] for line in lines.splitlines()
                    if line.startswith("fpr:")]
            self.assertEqual(len(fprs), 1)
            signer.append(fprs[0])
        gpg("--output", str(self.keyring), "--export", *signer)
        for a, sig, fpr in ((self.a, self.asig, signer[0]), (self.b, self.bsig, signer[1])):
            gpg("--local-user", fpr, "--detach-sign", "--output", str(sig), str(a))
        result = gitian.verify_pair(self.a, self.asig, self.b, self.bsig,
                                    self.keyring, signer[0], signer[1])
        self.assertTrue(result["bothDetachedSignaturesVerified"])
        self.assertFalse(result["independentSourceBuildReproduced"])
        self.assertFalse(result["l0Qualified"])
        self.assertFalse(result["settlementEnabled"])
        self.b.write_bytes(assertion().replace(ARCHIVE_NAME.encode(), b"wrong-archive.tar.gz"))
        with self.assertRaises(ValueError):
            gitian.verify_pair(self.a, self.asig, self.b, self.bsig,
                               self.keyring, signer[0], signer[1])


if __name__ == "__main__":
    unittest.main()
