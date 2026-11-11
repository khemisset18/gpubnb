import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import prepare
import run

class Guards(unittest.TestCase):
    def test_prepare_registers_both_suites_without_touching_implementations(self):
        original='  test/mempool_tests.cpp \\\n'
        with tempfile.TemporaryDirectory() as d,patch('subprocess.check_output',side_effect=[prepare.SOURCE,'']):
            root=Path(d);(root/'src/test').mkdir(parents=True)
            make=root/'src/Makefile.test.include';make.write_text(original)
            with patch.object(prepare,'PINNED',{'src/Makefile.test.include':hashlib.sha256(make.read_bytes()).hexdigest()}):
                prepare.prepare(root)
            self.assertIn('test/gpubnb_policy_tests.cpp',make.read_text())
            self.assertIn('test/gpubnb_d3_tests.cpp',make.read_text())
            self.assertEqual((root/'src/test/gpubnb_d3_tests.cpp').read_bytes(),Path(prepare.__file__).with_name('gpubnb_d3_tests.cpp').read_bytes())

    def test_existing_second_suite_rejected_before_first_target_is_written(self):
        original='  test/mempool_tests.cpp \\\n'
        with tempfile.TemporaryDirectory() as d,patch('subprocess.check_output',side_effect=[prepare.SOURCE,'']):
            root=Path(d);(root/'src/test').mkdir(parents=True)
            make=root/'src/Makefile.test.include';make.write_text(original)
            (root/'src/test/gpubnb_d3_tests.cpp').write_text('existing')
            with patch.object(prepare,'PINNED',{'src/Makefile.test.include':hashlib.sha256(make.read_bytes()).hexdigest()}):
                with self.assertRaisesRegex(ValueError,'already exists'):prepare.prepare(root)
            self.assertFalse((root/'src/test/gpubnb_policy_tests.cpp').exists())
            self.assertEqual(make.read_text(),original)

    def test_unknown_suite_rejected_before_namespace_or_native_operation(self):
        with patch('subprocess.check_output',side_effect=AssertionError('no process')):
            with self.assertRaisesRegex(ValueError,'suite'):run.run('/missing','0'*64,'net:[1]','/missing','all')

    def test_d3_selection_requires_every_native_metric_and_never_qualifies(self):
        full='4 test cases out of 4 passed\n'+'\n'.join(run.SUITES['d3']['markers'])
        for text,should_pass in [(full,True),(full.replace('d3-finality lock=','omitted'),False),
                                  (full.replace('4 test cases out of 4 passed','3 test cases out of 4 passed'),False)]:
            with self.subTest(should_pass=should_pass),tempfile.TemporaryDirectory() as d:
                binary=Path(d)/'binary';binary.write_bytes(b'not an executable')
                output=Path(d)/'out';calls=[]
                def fake_process(args,**kwargs):
                    calls.append(args);kwargs['stdout'].write(text)
                    return SimpleNamespace(returncode=0,check_returncode=lambda:None)
                with patch('subprocess.check_output',return_value='[{"ifname":"lo","flags":["UP"]}]'), \
                     patch('os.readlink',return_value='net:[2]'),patch('resource.setrlimit'), \
                     patch('subprocess.run',side_effect=fake_process):
                    if should_pass:run.run(binary,hashlib.sha256(binary.read_bytes()).hexdigest(),'net:[1]',output,'d3')
                    else:
                        with self.assertRaisesRegex(ValueError,'every selected'):run.run(binary,hashlib.sha256(binary.read_bytes()).hexdigest(),'net:[1]',output,'d3')
                import json
                report=json.loads((output/'report.json').read_text())
                self.assertEqual(report['qualificationStatus'],'BLOCKED')
                self.assertEqual(report['selectedSuite'],'gpubnb_d3')
                self.assertEqual(report['probeStatus'],'PASS' if should_pass else 'FAIL')
                self.assertIn('--run_test=gpubnb_d3',calls[0])

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
