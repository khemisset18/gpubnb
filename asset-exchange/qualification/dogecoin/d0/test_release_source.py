"""Real offline Git fetch tests; no Docker, network or Dogecoin executable."""
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).with_name("prepare-release-source.sh")


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git(self.source, "init", "-q")
        self.git(self.source, "config", "user.name", "D0 fixture")
        self.git(self.source, "config", "user.email", "d0@example.invalid")
        (self.source / "source.txt").write_text("release source\n")
        self.git(self.source, "add", "source.txt")
        self.git(self.source, "commit", "-qm", "release")
        self.commit = self.git(self.source, "rev-parse", "HEAD").stdout.strip()
        self.git(self.source, "tag", "-a", "v1.14.9", "-m", "release")
        self.target = self.root / "input"

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), *args],
                              capture_output=True, text=True, check=True)

    def prepare(self, commit=None):
        return subprocess.run(["bash", str(HELPER), str(self.source),
                               commit or self.commit, str(self.target)],
                              capture_output=True, text=True)

    def test_preserves_release_tag_across_gbuild_sha_only_fetch(self):
        # This is the pinned gbuild's fetch/checkout sequence, not a mock.
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git(self.target, "fetch", "-f", "--no-tags", "--update-head-ok",
                 str(self.source), self.commit)
        self.git(self.target, "checkout", "-q", "FETCH_HEAD")
        self.assertEqual(self.git(self.target, "describe", "--abbrev=0").stdout.strip(), "v1.14.9")
        self.assertEqual(self.git(self.target, "rev-parse", "HEAD").stdout.strip(), self.commit)
        self.assertIn("tag_object=" + self.git(self.source, "rev-parse", "v1.14.9").stdout.strip(), result.stdout)

    def test_sha_only_fetch_loses_release_metadata_without_preparation(self):
        self.git(self.root, "init", "-q", str(self.target))
        self.git(self.target, "fetch", "--no-tags", str(self.source), self.commit)
        self.git(self.target, "checkout", "-q", "FETCH_HEAD")
        result = subprocess.run(["git", "-C", str(self.target), "describe", "--abbrev=0"],
                                capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_tag_on_different_commit(self):
        (self.source / "source.txt").write_text("different source\n")
        self.git(self.source, "commit", "-qam", "different source")
        self.git(self.source, "tag", "-fa", "v1.14.9", "-m", "moved")
        self.assertNotEqual(self.prepare().returncode, 0)

    def test_rejects_missing_tag(self):
        self.git(self.source, "tag", "-d", "v1.14.9")
        self.assertNotEqual(self.prepare().returncode, 0)

    def test_rejects_lightweight_substitution(self):
        self.git(self.source, "tag", "-d", "v1.14.9")
        self.git(self.source, "tag", "v1.14.9")
        self.assertNotEqual(self.prepare().returncode, 0)

    def test_does_not_import_other_tags(self):
        self.git(self.source, "tag", "-a", "v9.99.9", "-m", "unrelated")
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.target, "tag", "-l").stdout.splitlines(), ["v1.14.9"])

    def test_refuses_to_overwrite_existing_input(self):
        self.target.mkdir()
        sentinel = self.target / "keep"
        sentinel.write_text("unchanged")
        self.assertNotEqual(self.prepare().returncode, 0)
        self.assertEqual(sentinel.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
