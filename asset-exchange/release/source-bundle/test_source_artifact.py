"""Adversarial source/provenance checks; no node, key, wallet or network use."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parent
ROOT = 'gpu.k.p2p-asset-exchange-source-v1'


class SourceArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory()
        cls.base = Path(cls.scratch.name)
        cls.repo = cls.base / 'source'
        cls.repo.mkdir()
        entries = {
            'asset-exchange/example.py': 'print("public fixture")\n',
            'docs/asset-exchange/review.md': 'Public synthetic review.\n',
            '.github/workflows/asset-exchange-source-artifact.yml': 'name: fixture\n',
            '.github/workflows/workspace-reliability.yml': 'name: caller fixture\n',
            'outside.txt': 'Excluded from the closed scope.\n',
        }
        for name, data in entries.items():
            path = cls.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
        target = cls.repo / 'asset-exchange/release/source-bundle'
        target.mkdir(parents=True)
        for name in ('build-reproducible-source.sh', 'generate-sbom.mjs', 'verify-source-artifact.sh'):
            shutil.copyfile(TOOLS / name, target / name)
        cls.call('git', 'init', '-q')
        cls.call('git', 'add', '.')
        env = dict(os.environ, GIT_AUTHOR_DATE='2026-11-12T00:00:00+00:00',
                   GIT_COMMITTER_DATE='2026-11-12T00:00:00+00:00')
        cls.call('git', '-c', 'user.name=Source Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'public source fixture', env=env)
        cls.sha = cls.call('git', 'rev-parse', 'HEAD').stdout.strip()
        cls.tree = cls.call('git', 'rev-parse', 'HEAD^{tree}').stdout.strip()
        cls.epoch = cls.call('git', 'show', '-s', '--format=%ct', 'HEAD').stdout.strip()
        cls.built = cls.base / 'original'
        cls.call('bash', str(TOOLS / 'build-reproducible-source.sh'), str(cls.built), cls.sha, cls.epoch)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    @classmethod
    def call(cls, *args, **kwargs):
        return subprocess.run(args, cwd=cls.repo, capture_output=True, text=True,
                              timeout=30, check=True, **kwargs)

    def verify(self, dist, tree=None, error=None):
        result = subprocess.run(['bash', str(TOOLS / 'verify-source-artifact.sh'), str(dist),
                                 self.sha, tree or self.tree], cwd=self.repo,
                                capture_output=True, text=True, timeout=30)
        if error is None:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(error, result.stdout + result.stderr)

    def rewritten(self, mutate=None, tar_extra=None):
        """Build self-consistent attacker evidence with independently kept Git unchanged."""
        work = Path(tempfile.mkdtemp(dir=self.base))
        stage = work / ROOT
        shutil.copytree(self.built / 'stage' / ROOT, stage)
        if mutate:
            mutate(stage)
        dist = work / 'dist'
        dist.mkdir()
        archive = dist / (ROOT + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as tf:
            tf.add(stage, arcname=ROOT)
            if tar_extra:
                tar_extra(tf)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        sbom = self.call('node', str(TOOLS / 'generate-sbom.mjs'), str(stage),
                         self.sha, self.tree, self.epoch, digest).stdout
        (dist / (ROOT + '.spdx.json')).write_text(sbom)
        names = (ROOT + '.tar.gz', ROOT + '.spdx.json')
        (dist / 'SHA256SUMS').write_text(''.join(
            hashlib.sha256((dist / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in names))
        return dist

    def test_exact_source_and_caller_pass(self):
        self.verify(self.built / 'dist')

    def test_checksum_file_cannot_select_other_paths(self):
        dist = self.rewritten()
        with (dist / 'SHA256SUMS').open('a') as stream:
            stream.write('0' * 64 + '  ../../outside.txt\n')
        self.verify(dist, error='exact closed checksum file list required')

    def test_self_consistent_substitution_fails(self):
        self.verify(self.rewritten(lambda p: (p / 'asset-exchange/example.py').write_text('changed\n')),
                    error='source Git blob mismatch')

    def test_self_consistent_omission_fails(self):
        self.verify(self.rewritten(lambda p: (p / '.github/workflows/workspace-reliability.yml').unlink()),
                    error='source Git file-set mismatch')

    def test_self_consistent_extra_scoped_file_fails(self):
        self.verify(self.rewritten(lambda p: (p / 'asset-exchange/extra.py').write_text('extra\n')),
                    error='source Git file-set mismatch')

    def test_expected_tree_must_belong_to_expected_commit(self):
        self.verify(self.built / 'dist', tree='0' * 40,
                    error='expected tree does not match')

    def test_other_root_files_are_not_in_scope(self):
        self.verify(self.rewritten(lambda p: (p / 'outside.txt').write_text('extra\n')),
                    error='SPDX contains path outside')

    def test_link_member_rejected(self):
        def add(tf):
            member = tarfile.TarInfo(ROOT + '/asset-exchange/link')
            member.type = tarfile.SYMTYPE
            member.linkname = '../../outside'
            tf.addfile(member)
        self.verify(self.rewritten(tar_extra=add), error='links forbidden')

    def test_traversal_member_rejected(self):
        def add(tf):
            member = tarfile.TarInfo(ROOT + '/../escaped')
            tf.addfile(member)
        self.verify(self.rewritten(tar_extra=add), error='unsafe tar path')

    def test_duplicate_member_rejected(self):
        def add(tf):
            member = tarfile.TarInfo(ROOT + '/asset-exchange/example.py')
            data = b'print("public fixture")\n'
            member.size = len(data)
            tf.addfile(member, io.BytesIO(data))
        self.verify(self.rewritten(tar_extra=add), error='duplicate tar file')

    def test_rewritten_scope_metadata_rejected(self):
        def mutate(stage):
            path = stage / 'SOURCE_BUNDLE_INFO.json'
            info = json.loads(path.read_bytes())
            info['scope'] = ['**']
            path.write_text(json.dumps(info))
        self.verify(self.rewritten(mutate), error='scope/epoch mismatch')


if __name__ == '__main__':
    unittest.main()
