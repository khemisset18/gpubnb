"""Adversarial tests for provenance-bound Stage 4 archive instructions.

Runs without Windows, credentials, GitHub, PE execution or physical machines.
"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import stage4_bundle_instructions as bundle  # noqa: E402

COMMIT = "0123456789abcdef" * 2 + "01234567"
PUBLISHER = "a1" * 32


class Stage4BundleInstructionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = {
            "sourceCommit": COMMIT,
            "publisherSha256": PUBLISHER,
            "kind": "STAGE4_UNSIGNED_PRIVATE_CANDIDATE",
            "signatureStatus": "unsigned",
            "installable": False,
            "publicBookabilityEnabled": False,
        }
        self._write_manifest()

    def _write_manifest(self):
        raw = (json.dumps(self.data, sort_keys=True) + "\n").encode()
        (self.root / "stage4.manifest.json").write_bytes(raw)
        self.digest = hashlib.sha256(raw).hexdigest()

    def _create(self):
        bundle.create(self.root, COMMIT, PUBLISHER, self.digest)

    def _verify(self):
        bundle.verify(self.root, COMMIT, PUBLISHER, self.digest)

    def test_current_provenance_and_no_historical_instructions(self):
        self._create()
        self._verify()
        entries = list((self.root / "instructions").iterdir())
        self.assertEqual([p.name for p in entries], ["README.md"])
        body = entries[0].read_text("utf-8")
        self.assertIn(COMMIT, body)
        self.assertIn(PUBLISHER, body)
        self.assertIn(self.digest, body)
        self.assertIn("NON INSTALLABLE", body)
        self.assertNotIn("/pull/303", body)
        self.assertNotIn("db149c275c0b1a1bf7e5079448f0532328fd0491", body)

    def test_rejects_stale_or_modified_readme(self):
        self._create()
        p = self.root / "instructions" / "README.md"
        p.write_text(p.read_text("utf-8").replace(COMMIT, "f" * 40), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "not_bound_to_manifest"):
            self._verify()

    def test_rejects_extra_old_signing_guide(self):
        self._create()
        (self.root / "instructions" / "SIGNATURE-PRIVEE.md").write_text("old SHA")
        with self.assertRaisesRegex(ValueError, "stale_or_unexpected_file"):
            self._verify()

    def test_rejects_preexisting_instructions_on_creation(self):
        (self.root / "instructions").mkdir()
        with self.assertRaises(FileExistsError):
            self._create()

    def test_rejects_manifest_tampering(self):
        self._create()
        previous_digest = self.digest
        self.data["sourceCommit"] = "f" * 40
        self._write_manifest()
        with self.assertRaisesRegex(ValueError, "manifest_digest_mismatch"):
            bundle.verify(self.root, COMMIT, PUBLISHER, previous_digest)

    def test_rejects_installable_flag(self):
        self.data["installable"] = True
        self._write_manifest()
        with self.assertRaisesRegex(ValueError, "manifest_provenance_mismatch"):
            self._create()

    def test_rejects_wrong_publisher_even_with_matching_manifest_digest(self):
        self.data["publisherSha256"] = "c3" * 32
        self._write_manifest()
        with self.assertRaisesRegex(ValueError, "manifest_provenance_mismatch"):
            self._create()

    def test_rejects_signed_source(self):
        self.data["signatureStatus"] = "private-signed"
        self._write_manifest()
        with self.assertRaisesRegex(ValueError, "manifest_provenance_mismatch"):
            self._create()

    def test_rejects_short_sha(self):
        with self.assertRaisesRegex(ValueError, "invalid_provenance_hash"):
            self.assertIsNone(bundle.expected_readme("abcd", PUBLISHER, self.digest))


if __name__ == "__main__":
    unittest.main()
