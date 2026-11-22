"""Real POSIX subprocess tests of bounded external signer transport only."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

import external_transport as transport


def package(code):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('__main__.py', code)
    return data.getvalue()


@unittest.skipUnless(os.name == 'posix', 'POSIX pipe/process-group transport only')
class ExternalTransportTests(unittest.TestCase):
    def rejects(self, code, *, payload=b'', expected, timeout=3):
        with self.assertRaises(transport.TransportError) as caught:
            transport.exchange(package(code), payload, timeout_seconds=timeout)
        self.assertEqual(caught.exception.code, expected, str(caught.exception))
        return caught.exception

    def test_success_returns_original_bytes_and_delivers_complete_payload(self):
        code = 'import sys\np=sys.stdin.buffer.read()\nsys.stdout.buffer.write(b"response:"+p)\n'
        value = transport.exchange(package(code), b'exact public request\x00\xff')
        self.assertEqual(value, b'response:exact public request\x00\xff')

    def test_input_and_both_outputs_are_drained_without_a_pipe_deadlock(self):
        payload = b'P' * transport.MAX_PAYLOAD_BYTES
        code = '''import sys
sys.stdout.buffer.write(b'O'*60000);sys.stdout.buffer.flush()
sys.stderr.buffer.write(b'E'*7000);sys.stderr.buffer.flush()
p=sys.stdin.buffer.read()
sys.stdout.buffer.write(p)
'''
        value = transport.exchange(package(code), payload, timeout_seconds=5)
        self.assertEqual(value, b'O' * 60000 + payload)

    def test_exact_output_and_stderr_bounds_are_accepted(self):
        code = '''import sys
sys.stdin.buffer.read()
sys.stderr.buffer.write(b'E'*8192);sys.stderr.buffer.flush()
sys.stdout.buffer.write(b'O'*131072)
'''
        self.assertEqual(len(transport.exchange(package(code), b'')), transport.MAX_STDOUT_BYTES)

    def test_stdout_flood_is_stopped_at_the_limit(self):
        self.rejects('import os\nwhile True:os.write(1,b"X"*4096)\n', expected='STDOUT_LIMIT')

    def test_stderr_flood_is_stopped_without_reemitting_sensitive_data(self):
        secret = 'DO_NOT_REEMIT_FAKE_KEY_MATERIAL'
        error = self.rejects('import os\nwhile True:os.write(2,'+repr((secret*500).encode())+')\n', expected='STDERR_LIMIT')
        self.assertNotIn(secret, str(error))

    def test_empty_response_and_nonzero_exit_are_explicit_failures(self):
        self.rejects('pass\n', expected='EMPTY_RESPONSE')
        error = self.rejects('import sys\nsys.stderr.write("FAKE_SECRET_PRIVATE_PATH")\nraise SystemExit(7)\n', expected='CHILD_EXIT')
        self.assertNotIn('FAKE_SECRET', str(error))

    def test_real_mid_response_process_exit_is_rejected(self):
        self.rejects('import sys\nsys.stdout.buffer.write(b\'{"response":\');sys.stdout.buffer.flush()\nraise SystemExit(9)\n', expected='CHILD_EXIT')

    def test_response_syntax_is_deliberately_left_to_the_orchestrator(self):
        # Transport cannot infer protocol truncation when a process exits zero.
        # The orchestrator's strict envelope parser must reject these bytes.
        self.assertEqual(transport.exchange(package('import sys\nsys.stdout.buffer.write(b\'{"response":\')\n'), b''), b'{"response":')

    def test_timeout_terminates_and_reaps_the_direct_child(self):
        started = time.monotonic()
        self.rejects('import time\ntime.sleep(30)\n', expected='TIMEOUT', timeout=1)
        self.assertLess(time.monotonic() - started, 6)

    def test_descendant_holding_output_pipe_cannot_extend_timeout(self):
        with tempfile.TemporaryDirectory(prefix='doge-descendant-test-') as tmp:
            marker = Path(tmp) / 'child-pid'
            code = '''import pathlib,subprocess,sys
p=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(30)'],stdin=subprocess.DEVNULL)
pathlib.Path(%r).write_text(str(p.pid))
sys.stdout.buffer.write(b'parent-finished');sys.stdout.buffer.flush()
''' % str(marker)
            started = time.monotonic()
            self.rejects(code, expected='TIMEOUT', timeout=1)
            self.assertLess(time.monotonic() - started, 6)
            child = int(marker.read_text())
            deadline = time.monotonic() + 2
            while self.running(child) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.running(child), 'same-group descendant survived timeout cleanup')

    @staticmethod
    def running(pid):
        try:
            stat = Path('/proc') / str(pid) / 'stat'
            if stat.exists():
                # A killed adopted zombie is no longer executing; only its
                # actual parent/OS can reap it, not this transport.
                return stat.read_text().split(') ', 1)[1].split()[0] not in ('Z', 'X')
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def test_descendant_without_open_pipes_is_killed_after_parent_success(self):
        with tempfile.TemporaryDirectory(prefix='doge-descendant-test-') as tmp:
            marker = Path(tmp) / 'child-pid'
            code = '''import pathlib,subprocess,sys
p=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(30)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
pathlib.Path(%r).write_text(str(p.pid))
sys.stdout.buffer.write(b'ok')
''' % str(marker)
            self.assertEqual(transport.exchange(package(code), b'', timeout_seconds=3), b'ok')
            child = int(marker.read_text())
            deadline = time.monotonic() + 2
            while self.running(child) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.running(child), 'same-group descendant survived successful parent')

    def test_private_cwd_minimal_environment_and_isolated_interpreter(self):
        code = '''import json,os,sys
sys.stdout.write(json.dumps({'isolated':sys.flags.isolated,'noSite':sys.flags.no_site,
    'files':os.listdir('.'),'env':sorted(os.environ)}))
'''
        with patch.dict(os.environ, {'PYTHONPATH':'/untrusted', 'GPUBNB_FAKE_SECRET':'private'}):
            value = json.loads(transport.exchange(package(code), b''))
        self.assertEqual(value['isolated'], 1)
        self.assertEqual(value['noSite'], 1)
        self.assertEqual(value['files'], [])
        self.assertEqual(value['env'], ['LANG', 'PATH'])

    def test_limits_and_types_reject_before_any_process_starts(self):
        valid = package('pass\n')
        cases = [(b'', b'', 1, 'PACKAGE_SIZE'),
            (b'x'*(transport.MAX_PACKAGE_BYTES+1), b'', 1, 'PACKAGE_SIZE'),
            (bytearray(valid), b'', 1, 'PACKAGE_SIZE'),
            (valid, b'x'*(transport.MAX_PAYLOAD_BYTES+1), 1, 'PAYLOAD_SIZE'),
            (valid, 'not bytes', 1, 'PAYLOAD_SIZE')]
        for timeout in (0, 121, True, 1.5, '1', None):
            cases.append((valid, b'', timeout, 'TIMEOUT_RANGE'))
        with patch.object(transport.subprocess, 'Popen', side_effect=AssertionError('process must not start')):
            for blob, payload, timeout, expected in cases:
                with self.subTest(expected=expected, timeout=timeout), self.assertRaises(transport.TransportError) as caught:
                    transport.exchange(blob, payload, timeout_seconds=timeout)
                self.assertEqual(caught.exception.code, expected)

    def test_unsupported_os_rejects_explicitly_before_launch(self):
        with patch.object(transport.os, 'name', 'nt'), patch.object(transport.subprocess, 'Popen', side_effect=AssertionError('process must not start')):
            with self.assertRaises(transport.TransportError) as caught:
                transport.exchange(package('pass\n'), b'')
        self.assertEqual(caught.exception.code, 'UNSUPPORTED_OS')

    def test_launch_error_never_leaks_paths(self):
        with patch.object(transport.subprocess, 'Popen', side_effect=FileNotFoundError('FAKE_SENSITIVE_LOCATION')):
            with self.assertRaises(transport.TransportError) as caught:
                transport.exchange(package('pass\n'), b'')
        self.assertEqual(caught.exception.code, 'IO_FAILURE')
        self.assertNotIn('FAKE_SENSITIVE_LOCATION', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
