import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import prepare


class PreparationBoundaryTests(unittest.TestCase):
    def test_registry_glib_is_refused_before_regression_execution(self):
        pins=json.loads((prepare.HERE/'source-pins.json').read_text())
        metadata={'packages':[{'name':'glib','version':'0.18.5','source':'registry+https://github.com/rust-lang/crates.io-index'}]}
        with self.assertRaisesRegex(AssertionError,'not selected'):
            prepare.check_selected_sources(metadata,Path('unused'),pins)

    def test_removed_rand_chain_is_refused_before_regression_execution(self):
        for name,version in [('rand','0.7.3'),('libsecp256k1','0.6.0')]:
            with self.subTest(package=name):
                with self.assertRaisesRegex(AssertionError,'reintroduced'):
                    prepare.check_selected_sources({'packages':[{'name':name,'version':version}]},Path('unused'),{'patches':[]})

    def test_existing_work_directory_fails_before_network_or_process(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(sys,'argv',['prepare.py',temp]), patch('urllib.request.urlopen',side_effect=AssertionError('network')), patch('subprocess.run',side_effect=AssertionError('process')):
                with self.assertRaises(FileExistsError):prepare.main()

    def test_nonregistry_download_is_refused_before_network(self):
        with patch('urllib.request.urlopen',side_effect=AssertionError('network')):
            with self.assertRaises(AssertionError):prepare.download('https://example.com/source.crate',Path('unused'),'0'*64)

    def test_modified_preimage_refuses_patch_process(self):
        pins=json.loads((prepare.HERE/'source-pins.json').read_text())
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'src').mkdir();(root/'src/variant_iter.rs').write_text('attacker replacement')
            with patch('subprocess.run',side_effect=AssertionError('patch process')):
                with self.assertRaisesRegex(AssertionError,'preimage'):prepare.patch_source(root,pins['patches'][0])

    def test_archive_traversal_is_refused_without_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'input.tar';out=root/'out';out.mkdir()
            with tarfile.open(archive,'w') as tar:
                item=tarfile.TarInfo('crate/../../outside');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
            with self.assertRaises(AssertionError):prepare.extract(archive,out,'crate')
            self.assertEqual(list(out.iterdir()),[])
            self.assertFalse((root/'outside').exists())

    def test_archive_symlink_is_refused_without_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'input.tar';out=root/'out';out.mkdir()
            with tarfile.open(archive,'w') as tar:
                item=tarfile.TarInfo('crate/source');item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd';tar.addfile(item)
            with self.assertRaisesRegex(AssertionError,'links'):prepare.extract(archive,out,'crate')
            self.assertEqual(list(out.iterdir()),[])

    def test_exact_prefix_regular_archive_is_extracted(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'input.tar';out=root/'out';out.mkdir()
            with tarfile.open(archive,'w') as tar:
                item=tarfile.TarInfo('crate/source.rs');item.size=4;tar.addfile(item,io.BytesIO(b'test'))
            prepare.extract(archive,out,'crate')
            self.assertEqual((out/'crate/source.rs').read_bytes(),b'test')


if __name__=='__main__':unittest.main()
