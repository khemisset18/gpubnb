"""Manual CLI tests: public receipts, keyless bundle recovery and namespace refusal."""
import json
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import external_signer as broker
import external_cli
import test_external_signer as fixtures


@unittest.skipUnless(os.name == 'posix', 'private external signer CLI is POSIX-only')
class ExternalCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.ExternalSignerTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        fixtures.ExternalSignerTests.tearDownClass()

    def setUp(self):
        self.fixture = fixtures.ExternalSignerTests(
            'test_real_child_signs_exact_refunds_parent_only_verifies_and_never_broadcasts')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.package = self.root / 'test-adapter.pyz'
        self.package.write_bytes(self.fixture.package)
        self.request = self.root / 'request.json'
        self.request.write_bytes(broker.encode(self.fixture.request))
        self.pairing = self.root / 'pairing.json'
        broker.persist_pairing(self.pairing, self.fixture.pairing, self.fixture.receipt)

    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, '-I', str(HERE / 'external_cli.py'), *map(str, arguments)],
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
            capture_output=True, text=True, timeout=20)

    def request_args(self):
        return ['--request', self.request, '--terms-digest', self.fixture.request['termsDigest'],
                '--request-digest', self.fixture.request['requestDigest']]

    def paired_args(self):
        return [*self.request_args(), '--pairing', self.pairing,
                '--pairing-digest', self.fixture.receipt,
                '--journal-directory', self.fixture.journal]

    def test_real_cli_pair_and_review_use_explicit_receipts_without_signing(self):
        output = self.root / 'new-pairing.json'
        done = self.run_cli('pair', '--adapter-package', self.package,
            '--adapter-sha256', self.fixture.pairing['adapterSha256'],
            '--refund-public-hex', self.fixture.refund.public.hex(),
            '--signer-id', 'external_test_signer', '--pairing-out', output,
            '--authorization', broker.PAIR_AUTHORIZATION)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)['pairingDigest'], self.fixture.receipt)
        self.assertFalse(json.loads(done.stdout)['hardwareQualified'])
        reviewed = self.run_cli('review', *self.request_args(), '--current-height', 1353)
        self.assertEqual(reviewed.returncode, 0, reviewed.stderr)
        fields = json.loads(reviewed.stdout)
        self.assertEqual(fields['network'], 'regtest')
        self.assertEqual(fields['destinationScriptHex'], self.fixture.request['destinationHex'])
        self.assertEqual(len(fields['steps']), 3)
        self.assertFalse(self.fixture.marker.exists())

    def test_real_cli_recovers_public_bundle_without_package_private_key_or_rpc(self):
        signed = self.fixture.run_request()
        self.fixture.key.unlink()
        self.package.unlink()
        target = self.root / 'recovery.json'
        done = self.run_cli('recover', *self.paired_args(), '--bundle-out', target)
        self.assertEqual(done.returncode, 0, done.stderr)
        receipt = json.loads(done.stdout)
        self.assertTrue(receipt['cached'])
        self.assertFalse(receipt['hardwareQualified'])
        self.assertEqual(receipt['broadcasts'], 0)
        core = external_cli._recovery()
        bundle = core.load_bundle(target, receipt['bundleSha256'])
        self.assertEqual(bundle['refunds'], signed['refunds'])
        self.assertEqual(len(self.fixture.marker.read_text().splitlines()), 1)

    @unittest.skipUnless(Path('/proc/self/ns/net').exists(), 'native namespace refusal is Linux-specific')
    def test_real_cli_sign_refuses_outside_distinct_private_namespace_before_driver(self):
        done = self.run_cli('sign', *self.paired_args(), '--bundle-out', self.root / 'not-created.json',
            '--adapter-package', self.package, '--authorization', broker.PAIR_AUTHORIZATION,
            '--rpc-cli', self.root / 'not-a-daemon-cli', '--rpc-datadir', self.root / 'not-a-datadir',
            '--rpc-port', 18332, '--parent-net-ns', os.readlink('/proc/self/ns/net'))
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertEqual(json.loads(done.stderr)['status'], 'REFUSED')
        self.assertIn('distinct private network namespace', json.loads(done.stderr)['reason'])
        self.assertFalse(self.fixture.marker.exists())
        self.assertFalse(self.fixture.journal.exists())
        self.assertFalse((self.root / 'not-created.json').exists())

    def test_cli_wrong_review_receipt_or_existing_pairing_never_changes_public_files(self):
        done = self.run_cli('review', '--request', self.request,
            '--terms-digest', '00' * 32, '--request-digest', self.fixture.request['requestDigest'],
            '--current-height', 1353)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(json.loads(done.stderr)['status'], 'REFUSED')
        before = self.pairing.read_bytes()
        done = self.run_cli('pair', '--adapter-package', self.package,
            '--adapter-sha256', self.fixture.pairing['adapterSha256'],
            '--refund-public-hex', self.fixture.refund.public.hex(),
            '--signer-id', 'external_test_signer', '--pairing-out', self.pairing,
            '--authorization', broker.PAIR_AUTHORIZATION)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(self.pairing.read_bytes(), before)
        self.assertFalse(self.fixture.marker.exists())

    def test_rpc_failure_is_sanitized_and_late_failure_leaves_no_retry_authority(self):
        arguments = list(map(str, ['sign', *self.paired_args(),
            '--bundle-out', self.root / 'not-created.json', '--adapter-package', self.package,
            '--authorization', broker.PAIR_AUTHORIZATION, '--rpc-cli', 'private-rpc-cli',
            '--rpc-datadir', 'private-rpc-path', '--rpc-port', 18332,
            '--parent-net-ns', 'net:[separate-test-namespace]']))
        errors = [subprocess.TimeoutExpired(['private-rpc-path', 'secret-value'], 1),
                  subprocess.CalledProcessError(1, ['private-rpc-path', 'secret-value'])]
        for error in errors:
            output, diagnostic = io.StringIO(), io.StringIO()
            with self.subTest(error=type(error).__name__), patch('external_cli._height_provider', side_effect=error):
                with redirect_stdout(output), redirect_stderr(diagnostic):
                    code = external_cli.main(arguments)
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(diagnostic.getvalue())['reason'], 'private Regtest observation unavailable')
            self.assertNotIn('secret-value', diagnostic.getvalue())
            self.assertFalse(self.fixture.marker.exists())
        calls = 0
        def height():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise subprocess.TimeoutExpired(['private-rpc-path', 'secret-value'], 1)
            return 1353
        output, diagnostic = io.StringIO(), io.StringIO()
        with patch('external_cli._height_provider', return_value=height):
            with redirect_stdout(output), redirect_stderr(diagnostic):
                self.assertEqual(external_cli.main(arguments), 2)
        self.assertNotIn('secret-value', diagnostic.getvalue())
        self.assertEqual(len(self.fixture.marker.read_text().splitlines()), 1)
        with patch('external_signer.external_transport.exchange', side_effect=AssertionError('must not resign')):
            with self.assertRaises(broker.policy.SignerUnavailableError):
                self.fixture.run_request()
        self.assertFalse((self.root / 'not-created.json').exists())

    def test_cli_sign_integration_with_explicit_software_height_model_persists_exact_bundle(self):
        # Only the new CLI integration is modeled here. This is not an actual
        # RPC/chain observation; signatures still come from the real child.
        target = self.root / 'signed-bundle.json'
        arguments = list(map(str, ['sign', *self.paired_args(), '--bundle-out', target,
            '--adapter-package', self.package, '--authorization', broker.PAIR_AUTHORIZATION,
            '--rpc-cli', 'unused-test-cli', '--rpc-datadir', 'unused-test-datadir',
            '--rpc-port', 18332, '--parent-net-ns', 'net:[explicit-software-model]']))
        output, diagnostic = io.StringIO(), io.StringIO()
        with patch('external_cli._height_provider', return_value=lambda: 1353):
            with redirect_stdout(output), redirect_stderr(diagnostic):
                self.assertEqual(external_cli.main(arguments), 0, diagnostic.getvalue())
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['broadcasts'], 0)
        self.assertFalse(receipt['hardwareQualified'])
        self.assertFalse(receipt['cached'])
        bundle = external_cli._recovery().load_bundle(target, receipt['bundleSha256'])
        self.assertEqual([r['txid'] for r in bundle['refunds']], receipt['refundTxids'])
        self.assertEqual(len(self.fixture.marker.read_text().splitlines()), 1)


if __name__ == '__main__':
    unittest.main()
