"""D7 process-crash boundaries; no daemon, network or recovery signing key.

SIGKILL is delivered by the parent after an acknowledged file/RPC boundary.
This proves process restart behavior, not physical power-loss durability.
The RPC restart case is explicitly a software model, not native DOGE evidence.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest

import recovery_core as recovery
import test_recovery as fixtures


CHILD = r'''
import json, os, pathlib, signal, sys
sys.path.insert(0, sys.argv[1])
import recovery_core as core
import test_recovery as fixtures
root, operation, checkpoint = pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4]
bundle = json.loads((root/'public-bundle.json').read_bytes())
bundle_digest = sys.argv[5]

def stop(name):
    if checkpoint == name:
        print('CHECKPOINT:' + name, flush=True)
        while True:
            signal.pause()

original_fdopen, original_fsync = os.fdopen, os.fsync
original_replace, original_load = os.replace, core.load_bundle

class PartialWrite:
    def __init__(self, stream): self.stream = stream
    def __enter__(self): return self
    def __exit__(self, *args): return self.stream.__exit__(*args)
    def write(self, raw):
        self.stream.write(raw[:len(raw)//2]); self.stream.flush()
        stop('partial-write')
        raise AssertionError('partial write checkpoint did not stop')
    def __getattr__(self, name): return getattr(self.stream, name)

if operation in ('bundle', 'journal'):
    if checkpoint == 'partial-write':
        def fdopen(fd, *args, **kwargs):
            target = pathlib.Path(os.readlink('/proc/self/fd/' + str(fd)))
            stream = original_fdopen(fd, *args, **kwargs)
            if target.parent == root and (target.name == 'target.json' or target.name.startswith('target.json.')):
                return PartialWrite(stream)
            return stream
        core.os.fdopen = fdopen
    sync_count = 0
    def fsync(fd):
        global sync_count
        sync_count += 1
        label = 'file-fsync' if sync_count == 1 else 'directory-fsync'
        stop('before-' + label)
        original_fsync(fd)
        stop('after-' + label)
    core.os.fsync = fsync
    if operation == 'bundle':
        def load(*args, **kwargs):
            stop('before-readback')
            result = original_load(*args, **kwargs)
            stop('after-readback')
            return result
        core.load_bundle = load
        digest = core.persist_bundle(root/'target.json', bundle)
        print('RECEIPT:' + digest, flush=True)
    else:
        def replace(*args, **kwargs):
            stop('before-replace')
            result = original_replace(*args, **kwargs)
            stop('after-replace')
            return result
        core.os.replace = replace
        core.save_observation(root/'target.json', {'state':'PENDING','transition':'REORGED'}, bundle_digest)
        print('RETURNED', flush=True)
else:
    ledger_path, journal = root/'software-rpc-ledger.json', root/'journal.json'
    history = json.loads(ledger_path.read_bytes()) if ledger_path.exists() else []
    class RestartRpc(fixtures.FakeRpc):
        def __call__(self, method, *params, **kwargs):
            result = super().__call__(method, *params, **kwargs)
            if method == 'sendrawtransaction':
                history.append({'txid':result, 'transactionHex':params[0]})
                with ledger_path.open('w') as stream:
                    json.dump(history, stream); stream.flush(); original_fsync(stream.fileno())
                stop('after-broadcast-before-journal')
            return result
    rpc = RestartRpc(bundle, 'PENDING' if history else 'UTXO_AVAILABLE')
    core.Rpc = lambda *args: rpc
    def replace(source, target):
        if pathlib.Path(target) == journal: stop('before-journal-replace')
        result = original_replace(source, target)
        if pathlib.Path(target) == journal: stop('after-journal-replace')
        return result
    core.os.replace = replace
    core.main(['rebroadcast', '--bundle', str(root/'public-bundle.json'),
        '--bundle-sha256', bundle_digest, '--journal', str(journal),
        '--authorization', core.AUTHORIZATION, '--rpc-cli', 'SOFTWARE_MODEL',
        '--rpc-datadir', 'SOFTWARE_MODEL', '--rpc-port', '18443', '--parent-net-ns', 'SOFTWARE_MODEL'])
'''


class ProcessCrashTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # All disposable signing keys are destroyed before any crash/restart child.
        fixtures.RecoveryTests.setUpClass()
        try:
            cls.bundle = copy.deepcopy(fixtures.RecoveryTests.bundle)
        finally:
            fixtures.RecoveryTests.tearDownClass()
        cls.raw = (json.dumps(cls.bundle, sort_keys=True, separators=(',', ':')) + '\n').encode()
        cls.digest = hashlib.sha256(cls.raw).hexdigest()

    def prepare(self, root):
        (root/'public-bundle.json').write_bytes(self.raw)

    def command(self, root, operation, checkpoint):
        return [sys.executable, '-I', '-c', CHILD, str(Path(__file__).resolve().parent),
                str(root), operation, checkpoint, self.digest]

    def kill_at(self, root, operation, checkpoint):
        process = subprocess.Popen(self.command(root, operation, checkpoint), cwd=root,
            env={'PATH':'/usr/bin:/bin', 'TMPDIR':str(root)},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=15), 'child did not reach crash boundary')
                first = process.stdout.readline()
            self.assertEqual(first, 'CHECKPOINT:' + checkpoint + '\n')
            process.kill()
            out, err = process.communicate(timeout=5)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            self.assertEqual(out, '')
            self.assertEqual(err, '')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)

    def test_no_prelock_receipt_is_returned_when_process_dies_during_bundle_persistence(self):
        checkpoints = ('partial-write', 'before-file-fsync', 'after-file-fsync',
                       'before-directory-fsync', 'after-directory-fsync',
                       'before-readback', 'after-readback')
        for checkpoint in checkpoints:
            with self.subTest(checkpoint=checkpoint), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.prepare(root)
                self.kill_at(root, 'bundle', checkpoint)
                if checkpoint == 'partial-write':
                    with self.assertRaisesRegex(ValueError, 'bundle digest mismatch'):
                        recovery.load_bundle(root/'target.json', self.digest)
                else:
                    self.assertEqual(recovery.load_bundle(root/'target.json', self.digest), self.bundle)
                with self.assertRaises(FileExistsError):
                    recovery.persist_bundle(root/'target.json', self.bundle)

    def test_journal_is_always_complete_old_or_new_after_process_kill_at_atomic_boundaries(self):
        checkpoints = ('partial-write', 'before-file-fsync', 'after-file-fsync',
                       'before-replace', 'after-replace',
                       'before-directory-fsync', 'after-directory-fsync')
        for checkpoint in checkpoints:
            with self.subTest(checkpoint=checkpoint), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.prepare(root)
                target = root/'target.json'
                recovery.save_observation(target, {'state':'CONFIRMED'}, self.digest)
                self.kill_at(root, 'journal', checkpoint)
                value = recovery.decode_json(recovery.read_regular(target))
                expected = {'bundleSha256':self.digest, 'state':'CONFIRMED'}
                if checkpoint in ('after-replace', 'before-directory-fsync', 'after-directory-fsync'):
                    expected.update(state='PENDING', transition='REORGED')
                self.assertEqual(value, expected)
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                recovery.save_observation(target, {'state':'PENDING','transition':'REORGED'}, self.digest)
                self.assertEqual(recovery.decode_json(recovery.read_regular(target))['state'], 'PENDING')

    def test_software_rpc_restart_after_broadcast_reuses_exact_presigned_transaction_without_keys(self):
        for checkpoint in ('after-broadcast-before-journal', 'before-journal-replace', 'after-journal-replace'):
            with self.subTest(checkpoint=checkpoint), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.prepare(root)
                self.kill_at(root, 'software-rpc', checkpoint)
                result = subprocess.run(self.command(root, 'software-rpc', 'no-crash'), cwd=root,
                    env={'PATH':'/usr/bin:/bin', 'TMPDIR':str(root)},
                    capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                observation = json.loads(result.stdout)
                self.assertEqual(observation['state'], 'PENDING')
                self.assertFalse(observation['automaticSettlement'])
                history = json.loads((root/'software-rpc-ledger.json').read_bytes())
                self.assertEqual(len(history), 2)
                self.assertEqual(history[0], history[1])
                self.assertEqual(history[0]['transactionHex'], self.bundle['refunds'][0]['transactionHex'])
                self.assertFalse(list(root.glob('*.pem')))


if __name__ == '__main__':
    unittest.main()
