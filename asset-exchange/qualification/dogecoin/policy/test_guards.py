import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import prepare
import run

class Guards(unittest.TestCase):
    def test_wrong_commit_rejected_before_changes(self):
        with tempfile.TemporaryDirectory() as d,patch('subprocess.check_output',return_value='wrong'):
            with self.assertRaisesRegex(ValueError,'commit'):prepare.prepare(d)
            self.assertEqual(list(Path(d).iterdir()),[])
    def test_dirty_source_rejected(self):
        with tempfile.TemporaryDirectory() as d,patch('subprocess.check_output',side_effect=[prepare.SOURCE,' M src/validation.cpp']):
            with self.assertRaisesRegex(ValueError,'clean'):prepare.prepare(d)
    def test_changed_upstream_file_rejected(self):
        with tempfile.TemporaryDirectory() as d,patch('subprocess.check_output',side_effect=[prepare.SOURCE,'']):
            p=Path(d)/'src';p.mkdir();(p/'Makefile.test.include').write_text('changed')
            with self.assertRaisesRegex(ValueError,'mismatch'):prepare.prepare(d)
    def test_same_namespace_rejected_before_binary_read(self):
        with patch('subprocess.check_output',return_value='[{"ifname":"lo","flags":["UP"]}]'),patch('os.readlink',return_value='net:[1]'):
            with self.assertRaisesRegex(ValueError,'distinct'):run.run('/missing','0'*64,'net:[1]','/missing')
    def test_wrong_binary_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as d,patch('subprocess.check_output',return_value='[{"ifname":"lo","flags":["UP"]}]'),patch('os.readlink',return_value='net:[2]'),patch('subprocess.run',side_effect=AssertionError('execution')):
            p=Path(d)/'binary';p.write_bytes(b'wrong')
            with self.assertRaisesRegex(ValueError,'digest'):run.run(p,'0'*64,'net:[1]',Path(d)/'out')

if __name__=='__main__':unittest.main()
