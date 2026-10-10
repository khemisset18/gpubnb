"""Regression tests for fail-closed D0 provenance input validation."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from validate_evidence import EXPECTED, HASHED_EVIDENCE_FILES, OFFICIAL_SHA256, load_evidence


class D0EvidenceValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.evidence = dict(EXPECTED)
        self.evidence.update({
            "artifactSha256": OFFICIAL_SHA256,
            "focalSnapshotId": "20241212T000000Z",
            "focalSnapshotUrl": "https://snapshot.ubuntu.com/ubuntu/20241212T000000Z",
            "officialFocalManifestVariant": "KunNw0n",
            "dependsSourceCacheFileCount": 2,
            "focalBootstrapPackageCount": 2,
        })
        for key, name in HASHED_EVIDENCE_FILES.items():
            content = (name + "\n").encode("utf-8")
            (self.root / name).write_bytes(content)
            self.evidence[key] = hashlib.sha256(content).hexdigest()
        self.write_evidence()

    def write_evidence(self):
        (self.root / "evidence.json").write_text(json.dumps(self.evidence) + "\n")

    def assert_rejected(self):
        self.write_evidence()
        with self.assertRaises(ValueError):
            load_evidence(self.root, OFFICIAL_SHA256)

    def test_accepts_complete_matching_evidence(self):
        self.assertEqual(load_evidence(self.root, OFFICIAL_SHA256), self.evidence)

    def test_rejects_missing_safety_assertions(self):
        for field in ("binaryExecuted", "mainnetUsed", "realFundsUsed", "gitianDescriptorModified"):
            with self.subTest(field=field):
                saved = self.evidence.pop(field)
                self.assert_rejected()
                self.evidence[field] = saved

    def test_rejects_false_safety_assertions_and_non_boolean_types(self):
        for field in ("binaryExecuted", "mainnetUsed", "realFundsUsed"):
            with self.subTest(field=field):
                self.evidence[field] = True
                self.assert_rejected()
                self.evidence[field] = 0
                self.assert_rejected()
                self.evidence[field] = False

    def test_rejects_duplicate_json_keys(self):
        text = json.dumps(self.evidence)
        text = text[:-1] + ',"mainnetUsed":false}'
        (self.root / "evidence.json").write_text(text)
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            load_evidence(self.root, OFFICIAL_SHA256)

    def test_rejects_mismatched_source_commit(self):
        self.evidence["dogecoinSourceCommit"] = "0" * 40
        self.assert_rejected()

    def test_rejects_declared_hash_that_differs_from_file(self):
        (self.root / "gitian-linux-upstream.yml").write_text("tampered\n")
        self.assert_rejected()

    def test_rejects_missing_or_symlinked_evidence(self):
        filename = "focal-bootstrap-packages.txt"
        (self.root / filename).unlink()
        self.assert_rejected()
        (self.root / filename).symlink_to(self.root / "gitian-linux-upstream.yml")
        self.assert_rejected()

    def test_rejects_unpinned_snapshot_transport(self):
        self.evidence["focalSnapshotUrl"] = "http://snapshot.ubuntu.com/ubuntu/20241212T000000Z"
        self.assert_rejected()

    def test_rejects_bad_declared_archive_digest(self):
        self.evidence["artifactSha256"] = "0" * 64
        self.assert_rejected()

    def test_rejects_oversized_evidence(self):
        (self.root / "evidence.json").write_text(" " * (64 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            load_evidence(self.root, OFFICIAL_SHA256)

    def test_rejects_boolean_counts(self):
        self.evidence["focalBootstrapPackageCount"] = True
        self.assert_rejected()


if __name__ == "__main__":
    unittest.main()
