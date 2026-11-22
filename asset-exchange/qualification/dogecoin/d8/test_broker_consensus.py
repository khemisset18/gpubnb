"""Offline D8 boundaries: native loading and private-key generation are mocked.

These tests never execute Dogecoin, its C ABI, or an old qualification suite.
Synthetic report fixtures exercise the evidence contract only.
"""
from argparse import Namespace
import ast
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
with patch('ctypes.CDLL', side_effect=AssertionError('no native library in preflight')), \
     patch('subprocess.Popen', side_effect=AssertionError('no native/key process at import')):
    import broker_consensus as harness

LO = [{'ifname': 'lo', 'flags': ['UP']}]


def args(root):
    return Namespace(authorization=harness.AUTHORIZATION, parent_net_ns='net:[1]',
        execution_commit='a' * 40, harness_commit='b' * 40,
        evidence=root / 'd0', verification=root / 'verification', work=root / 'lab')


def model_report():
    cases, refunds = [], []
    for fee in harness.FEES:
        for name, expected in [('broker-refund', 1), ('post-sign-output-mutation', 0)]:
            raw = harness.transaction('01' * 32, 0, b'\0',
                [(10_000_000_000 - int(fee) + int(expected == 0), b'\x51')], 1355)
            cases.append({'id': name + '-' + fee, 'expectedResult': expected, 'inputIndex': 0,
                'transactionHex': raw.hex(), 'transactionSha256': hashlib.sha256(raw).hexdigest(),
                'result': expected, 'error': 0, 'flags': 517})
            if expected == 1:
                refunds.append({'feeKoinu': fee, 'transactionHex': raw.hex()})
    return {'experimentStatus': 'PASS', 'qualificationStatus': 'BLOCKED', 'scope': harness.SCOPE,
        'manifest': harness.manifest(), 'rpcCalls': 0, 'generatedBlocks': 0, 'broadcasts': 0,
        'nodesStarted': 0, 'fixtureKeysCreated': 2, 'newSignatures': 3, 'signerChildren': 1,
        'keysRemoved': True, 'hardwareQualified': False, 'physicalDisplayTested': False,
        'fundingObservedOnChain': False, 'mempoolChecked': False, 'transactionFinalityVerified': False,
        'automaticSettlement': False, 'refunds': refunds, 'cases': cases}


class BrokerConsensusBoundaries(unittest.TestCase):
    def test_manifest_is_new_script_only_scope_with_zero_chain_effects(self):
        m = harness.manifest()
        for field in ('nodes', 'maxRpc', 'maxGeneratedBlocks', 'maxBroadcastFixtures'):
            self.assertEqual(m[field], 0)
        self.assertEqual(m['rpcAllowlist'], [])
        self.assertEqual((m['flags'], m['inputIndex'], m['cAbiVersion']), (517, 0, 1))
        self.assertEqual((m['maxFixtureKeys'], m['maxNewSignatures'], m['maxSignerChildren']), (2, 3, 1))
        self.assertEqual(m['maxCabiVerifications'], 6)
        self.assertFalse(m['hardwareQualified']); self.assertFalse(m['automaticSettlement'])
        self.assertEqual(m['qualificationStatus'], 'BLOCKED')

    def test_authorization_and_frozen_commits_precede_every_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            for field, value in [('authorization', True), ('authorization', 'old-D6'),
                                 ('execution_commit', ''), ('harness_commit', 'unfrozen')]:
                value_args = args(Path(tmp)); setattr(value_args, field, value)
                with self.subTest(field=field, value=value), \
                     patch.object(harness.subprocess, 'check_output', side_effect=AssertionError('no command')), \
                     patch.object(harness, 'native_verifier', side_effect=AssertionError('no native')), \
                     patch.object(harness, 'EphemeralSigner', side_effect=AssertionError('no keys')):
                    with self.assertRaises(ValueError): harness.run(value_args)

    def test_same_namespace_external_interface_or_down_loopback_precede_handoff(self):
        for namespace, links in [('net:[1]', LO), ('net:[2]', [{'ifname': 'eth0', 'flags': ['UP']}]),
                                 ('net:[2]', [{'ifname': 'lo', 'flags': []}])]:
            with tempfile.TemporaryDirectory() as tmp, self.subTest(namespace=namespace, links=links), \
                 patch.object(harness.os, 'readlink', return_value=namespace), \
                 patch.object(harness.subprocess, 'check_output', return_value=json.dumps(links)), \
                 patch.object(harness, 'read_json', side_effect=AssertionError('no D0 access')), \
                 patch.object(harness, 'native_verifier', side_effect=AssertionError('no native')), \
                 patch.object(harness, 'EphemeralSigner', side_effect=AssertionError('no keys')):
                with self.assertRaises(ValueError): harness.run(args(Path(tmp)))

    def test_bad_handoff_stops_before_archive_library_or_fixture_keys(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(harness.os, 'readlink', return_value='net:[2]'), \
             patch.object(harness.subprocess, 'check_output', return_value=json.dumps(LO)), \
             patch.object(harness, 'read_json', return_value={}), \
             patch.object(harness, 'verified_library', side_effect=AssertionError('no archive extraction')), \
             patch.object(harness, 'native_verifier', side_effect=AssertionError('no native')), \
             patch.object(harness, 'EphemeralSigner', side_effect=AssertionError('no keys')):
            with self.assertRaisesRegex(ValueError, 'one verified attestation'):
                harness.run(args(Path(tmp)))

    def test_wrong_archive_stops_before_library_load_or_key_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); value_args = args(root); value_args.evidence.mkdir()
            (value_args.evidence / harness.ARCHIVE).write_bytes(b'not the qualified D0 archive')
            with patch.object(harness.os, 'readlink', return_value='net:[2]'), \
                 patch.object(harness.subprocess, 'check_output', return_value=json.dumps(LO)), \
                 patch.object(harness, 'read_json', return_value={}), \
                 patch.object(harness, 'validate_handoff'), \
                 patch.object(harness, 'native_verifier', side_effect=AssertionError('no native')), \
                 patch.object(harness, 'EphemeralSigner', side_effect=AssertionError('no keys')):
                with self.assertRaisesRegex(ValueError, 'D0 archive hash mismatch'):
                    harness.run(value_args)
            report = json.loads((root / 'lab/evidence/broker-consensus-report.json').read_bytes())
            self.assertEqual(report['experimentStatus'], 'FAIL'); self.assertTrue(report['keysRemoved'])

    def run_patches(self, stack):
        stack.enter_context(patch.object(harness.os, 'readlink', return_value='net:[2]'))
        stack.enter_context(patch.object(harness.subprocess, 'check_output', return_value=json.dumps(LO)))
        stack.enter_context(patch.object(harness, 'read_json', return_value={}))
        stack.enter_context(patch.object(harness, 'validate_handoff'))
        stack.enter_context(patch.object(harness, 'verified_library', return_value=Path('/unused/pinned-lib')))
        stack.enter_context(patch.object(harness, 'limits', return_value=None))

    def test_bad_native_abi_precedes_every_fixture_key(self):
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            self.run_patches(stack)
            stack.enter_context(patch.object(harness, 'native_verifier', side_effect=ValueError('wrong C ABI')))
            signer = stack.enter_context(patch.object(harness, 'EphemeralSigner', side_effect=AssertionError('no keys')))
            with self.assertRaisesRegex(ValueError, 'wrong C ABI'): harness.run(args(Path(tmp)))
            signer.assert_not_called()

    def test_failed_fixture_generation_removes_both_possible_fixture_paths(self):
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            self.run_patches(stack)
            stack.enter_context(patch.object(harness, 'native_verifier', return_value=Mock()))
            def failure(work, _verify, _report):
                for role in ('claim', 'refund'):
                    (work / 'keys' / (role + '.pem')).write_bytes(b'NOT A PRIVATE KEY - PREFLIGHT PLACEHOLDER')
                raise ValueError('fixture preparation failed')
            stack.enter_context(patch.object(harness, 'execute_fixture', side_effect=failure))
            with self.assertRaisesRegex(ValueError, 'fixture preparation failed'): harness.run(args(Path(tmp)))
            self.assertEqual(list((Path(tmp) / 'lab/keys').iterdir()), [])
            report = json.loads((Path(tmp) / 'lab/evidence/broker-consensus-report.json').read_bytes())
            self.assertEqual(report['experimentStatus'], 'FAIL'); self.assertTrue(report['keysRemoved'])

    def test_model_report_contract_accepts_only_declared_scope_and_six_bound_observations(self):
        self.assertEqual(harness.validate_report(model_report())['scope'], harness.SCOPE)

    def test_evidence_promotions_missing_checks_and_substituted_bytes_refuse(self):
        def unrelated_negative_with_its_own_correct_checksum(report):
            raw = harness.transaction('02' * 32, 0, b'\0', [(1, b'\x51')], 1355)
            report['cases'][1].update(transactionHex=raw.hex(),
                transactionSha256=hashlib.sha256(raw).hexdigest())
        mutations = [lambda r: r.update(hardwareQualified=True),
            lambda r: r.update(physicalDisplayTested=True), lambda r: r.update(fundingObservedOnChain=True),
            lambda r: r.update(mempoolChecked=True), lambda r: r.update(transactionFinalityVerified=True),
            lambda r: r.update(automaticSettlement=True), lambda r: r.update(keysRemoved=False),
            lambda r: r.update(rpcCalls=1), lambda r: r.update(nodesStarted=1),
            lambda r: r.update(generatedBlocks=1), lambda r: r.update(broadcasts=1),
            lambda r: r.update(signerChildren=True), lambda r: r['cases'].pop(),
            lambda r: r['cases'][0].update(flags=5), lambda r: r['cases'][0].update(error=3),
            lambda r: r['cases'][1].update(result=1), lambda r: r['cases'][0].update(expectedResult=True),
            lambda r: r['cases'][0].update(inputIndex=False),
            lambda r: r['cases'][0].update(transactionSha256='00' * 32),
            lambda r: r['refunds'][0].update(transactionHex=r['refunds'][1]['transactionHex']),
            unrelated_negative_with_its_own_correct_checksum]
        for mutation in mutations:
            report = model_report(); mutation(report)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): harness.validate_report(report)

    def test_post_signature_mutation_changes_only_the_signed_output_value(self):
        recovery = HERE.parents[2] / 'recovery/dogecoin/transaction.py'
        spec = importlib.util.spec_from_file_location('d8_public_transaction', recovery)
        codec = importlib.util.module_from_spec(spec); spec.loader.exec_module(codec)
        raw = harness.transaction('01' * 32, 0, b'\0', [(99_000_000, b'\x51')], 1355)
        policy = Namespace(parse_transaction=codec.parse_transaction)
        mutated = harness.mutated_output({'transactionHex': raw.hex()}, policy)
        before, after = codec.parse_transaction(raw), codec.parse_transaction(mutated)
        self.assertEqual(before['inputs'], after['inputs'])
        self.assertEqual(before['lockTime'], after['lockTime'])
        self.assertEqual(before['outputs'][0]['scriptPubKey'], after['outputs'][0]['scriptPubKey'])
        self.assertEqual(after['outputs'][0]['valueKoinu'], before['outputs'][0]['valueKoinu'] + 1)

    def test_fixture_package_is_reproducible_and_excludes_key_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / 'public-broker.py'
            source.write_text('# public source placeholder; never executed\n')
            key = root / 'refund.pem'; key.write_bytes(b'PRIVATE PLACEHOLDER NEVER INCLUDED IN PACKAGE')
            request = {'termsDigest': '11' * 32, 'requestDigest': '22' * 32}
            broker = Namespace(__file__=str(source), encode=lambda value: json.dumps(value).encode())
            first, hashes = harness.fixture_package(broker, request,
                                                   key, root / 'marker.json')
            second, repeated = harness.fixture_package(broker, request,
                                                       key, root / 'marker.json')
            self.assertEqual(first, second); self.assertEqual(hashes, repeated)
            self.assertNotIn(key.read_bytes(), first)
            with zipfile.ZipFile(io.BytesIO(first)) as archive:
                self.assertEqual(set(archive.namelist()), set(hashes))
                for name, digest in hashes.items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest)
                config = json.loads(archive.read('fixture.json'))
                self.assertEqual(config['keyFile'], str(key))
                self.assertEqual(config['requestDigest'], request['requestDigest'])
                compile(archive.read('__main__.py'), 'd8-fixture-only', 'exec')

    def test_wrapper_is_parseable_and_bad_scope_cannot_start_any_command(self):
        script = HERE / 'run-consensus.sh'
        self.assertEqual(subprocess.run(['bash', '-n', str(script)], capture_output=True).returncode, 0)
        for argv in [[], ['unused', 'unused', 'old-D6', 'a' * 40, 'b' * 40]]:
            result = subprocess.run(['/bin/bash', str(script), *argv],
                env={'PATH': '/unavailable'}, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 2)

    def test_fixture_source_never_reads_private_material_from_protocol_or_claims_hardware(self):
        source = (HERE / 'fixture_signer.py').read_text()
        tree = ast.parse(source)
        self.assertIn("'physicalUserApproval': False", source)
        self.assertIn("'softwareFixtureApproval': True", source)
        self.assertIn("b'PRIVATE KEY' not in raw", source)
        self.assertIn('trusted_terms_digest=config', source)
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr == 'genpkey' for n in ast.walk(tree)))
        # The fixture child can only reuse a supplied fixture key. No EphemeralSigner constructor.
        self.assertFalse(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                             and n.func.id == 'EphemeralSigner' for n in ast.walk(tree)))


if __name__ == '__main__':
    unittest.main()
