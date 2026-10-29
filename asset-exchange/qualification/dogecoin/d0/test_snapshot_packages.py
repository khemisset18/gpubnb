"""Adversarial parsing tests for snapshot package availability verification."""
import unittest
from verify_snapshot_packages import package_records, require_manifest, signed_hashes

HASH = "a" * 64
RECORD = f"Package: git\nVersion: 1:2.25.1-1ubuntu3.13\nArchitecture: amd64\nSHA256: {HASH}\n"
MANIFEST = f"{HASH}  git_1%3a2.25.1-1ubuntu3.13_amd64.deb\n"


class SnapshotPackageTests(unittest.TestCase):
    def test_epoch_identity_is_not_archive_filename(self):
        records = package_records((RECORD + "Filename: pool/git_2.25.1-1ubuntu3.13_amd64.deb\n").encode())
        self.assertEqual(require_manifest(MANIFEST, records), 1)

    def test_rejects_wrong_hash_version_architecture_or_missing_package(self):
        for text in (RECORD.replace(HASH, "b" * 64), RECORD.replace("1:2.25", "2:2.25"),
                     RECORD.replace("amd64", "arm64"), ""):
            with self.subTest(text=text), self.assertRaises(ValueError):
                require_manifest(MANIFEST, package_records(text.encode()))

    def test_rejects_duplicate_and_missing_fields(self):
        for text in (RECORD + "SHA256: " + HASH, RECORD.replace("Architecture: amd64\n", "")):
            with self.assertRaises(ValueError):
                package_records(text.encode())

    def test_rejects_empty_duplicate_or_bad_manifest(self):
        for manifest in ("", MANIFEST * 2, "bad  git.deb"):
            with self.assertRaises(ValueError):
                require_manifest(manifest, package_records(RECORD.encode()))

    def test_signed_index_hash_and_size(self):
        release = f"\nSHA256:\n {HASH} 123 main/binary-amd64/Packages\nSHA512:\n"
        self.assertEqual(signed_hashes(release), {"main/binary-amd64/Packages": (HASH, 123)})
        for bad in ("", release + release, release.replace("SHA512:", f" {HASH} 999 main/binary-amd64/Packages")):
            with self.assertRaises(ValueError):
                signed_hashes(bad)


if __name__ == "__main__":
    unittest.main()
