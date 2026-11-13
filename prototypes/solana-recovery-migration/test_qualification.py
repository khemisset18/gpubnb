import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import qualify


class QualificationBoundaryTests(unittest.TestCase):
    def test_cargo_unicode_metadata_is_decoded_without_the_legacy_locale(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            expected = {'packages': [{'description': 'UTF-8 author: 東京, Zoë'}]}
            def cargo_output(*args, stdout, **kwargs):
                stdout.write(json.dumps(expected, ensure_ascii=False).encode('utf-8'))
            # Reproduce the observed Windows cp1252 failure for text-mode reads.
            legacy_error = UnicodeDecodeError('charmap', b'\x81', 0, 1, 'undefined byte')
            with patch('subprocess.run', side_effect=cargo_output), patch.object(Path, 'read_text', side_effect=legacy_error):
                self.assertEqual(qualify.metadata(root, root/'metadata.json', root/'cargo.log', {}), expected)

    def test_altered_vendor_is_refused_before_git_or_cargo(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vendor = root/'vendor';vendor.mkdir();(vendor/'lib.rs').write_bytes(b'altered source')
            pins = {'vendorPath': 'vendor', 'vendorFiles': {'lib.rs': '0'*64}}
            with patch('subprocess.check_output', side_effect=AssertionError('git or cargo')):
                with self.assertRaisesRegex(AssertionError, 'vendor source mismatch'):
                    qualify.validate_committed(root, pins)

    def test_archive_link_is_refused_without_extraction(self):
        import tarfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp);archive = root/'source.tar';out = root/'out';out.mkdir()
            with tarfile.open(archive, 'w') as tar:
                item = tarfile.TarInfo('solana-secp256k1-recover-2.2.1/link')
                item.type = tarfile.SYMTYPE;item.linkname = '/etc/passwd';tar.addfile(item)
            with self.assertRaisesRegex(AssertionError, 'links'):
                qualify.extract(archive, out)
            self.assertEqual(list(out.iterdir()), [])

    def test_existing_package_source_edits_are_in_the_lock_delta(self):
        before = {'package': [{'name': 'retained', 'version': '1.0.0', 'checksum': 'old'}]}
        after = copy.deepcopy(before)
        after['package'][0]['checksum'] = 'unexpected'
        delta = qualify.lock_delta(before, after)
        self.assertEqual(delta['added'], [])
        self.assertEqual(delta['removed'], [])
        self.assertEqual(delta['changedExisting'][0]['after']['checksum'], 'unexpected')


if __name__ == '__main__':
    unittest.main()
