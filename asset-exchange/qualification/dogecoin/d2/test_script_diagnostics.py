"""Offline harness tests: no Dogecoin node, CLI or native library is executed."""
from copy import deepcopy
import json
import hashlib
import zipfile
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import script_diagnostics as d


class ScriptDiagnosticsTests(unittest.TestCase):
    def test_manifest_exactly_matches_committed_reviewed_operations(self):
        committed = json.loads((d.D2_DIR / 'operations-manifest.json').read_text())
        self.assertEqual(d.manifest(), committed)
        self.assertEqual(set(committed['rpcAllowlist']), d.ALLOWED_METHODS)
        self.assertEqual(committed['miningSchedule'], [1350, 1, 1])
        self.assertEqual(sum(committed['miningSchedule']), 1352)
        self.assertEqual(committed['qualificationStatus'], 'BLOCKED')
        self.assertFalse(committed['wallet'])
        self.assertFalse(committed['signing'])
        self.assertFalse(committed['transactionBroadcast'])
        self.assertFalse(committed['externalNetwork'])

    def test_offline_manifest_does_not_load_native_library_or_spawn_node(self):
        with patch('script_diagnostics.ctypes.CDLL', side_effect=AssertionError('native execution forbidden')):
            with patch('script_diagnostics.subprocess.Popen', side_effect=AssertionError('process forbidden')):
                self.assertEqual(d.manifest()['cAbi']['version'], 1)
        result = subprocess.run(['python3', str(d.D2_DIR / 'script_diagnostics.py'), '--manifest'],
                                text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), d.manifest())

    def test_all_public_vector_names_unique_and_expected_values_frozen(self):
        vectors = d.consensus_vectors()
        self.assertEqual(len(vectors), 23)
        self.assertEqual(len({v['name'] for v in vectors}), 23)
        self.assertEqual(sum(v['expectedResult'] for v in vectors), 9)
        for v in vectors:
            self.assertIn(v['flags'], [0, 1, 512, 513, 517])
            self.assertEqual(v['flags'] & ((1 << 10) | (1 << 11)), 0)  # no CSV/witness assumptions
            self.assertIn(v['expectedResult'], [0, 1])
            bytes.fromhex(v['transactionHex']); bytes.fromhex(v['scriptPubKeyHex'])
        fixture = next(v for v in vectors if v['name'] == 'upstream_public_signature_verify_only')
        self.assertEqual(fixture['scriptPubKeyHex'], 'ab21038479a0fa998cd35259a2ef0a7a5c68662c1474f88ccb6d08a7677bbec7f22041ac')
        self.assertEqual(fixture['expectedResult'], 1)

    def test_fixed_synthetic_preimage_is_32_bytes_and_not_a_key(self):
        self.assertEqual(len(d.PREIMAGE), 32)
        self.assertEqual(d.PREIMAGE, b'GPUbnb D2 public synthetic input')
        self.assertEqual(d.BURN_REDEEM, b'\x6a')
        self.assertEqual(d.BURN_ADDRESS, '2MyF5LxGTsXxf7xSpLr6RqXD4N7f1uEBfS7')
        self.assertEqual(d.script_hash_output(b'\x6a').hex(), 'a91441c98a140039816273e50db317422c11c2bfcc8887')

    def test_fixed_rpc_success_parameters(self):
        for method in ['getblockchaininfo', 'getnetworkinfo', 'getpeerinfo', 'stop']:
            self.assertEqual(d.rpc_arguments('cli', [], method)[-1], method)
        self.assertEqual(d.rpc_arguments('cli', [], 'getblockhash', '0')[-2:], ['getblockhash', '0'])
        for f in d.DECODE_FIXTURES:
            self.assertEqual(d.rpc_arguments('cli', [], 'decodescript', f['hex'])[-1], f['hex'])
        for count in ['1', '1350']:
            d.rpc_arguments('cli', [], 'generatetoaddress', count, d.BURN_ADDRESS, '1000000', '0')

    def test_wallet_signature_transaction_and_external_rpc_forbidden(self):
        for method in ['generate', 'getnewaddress', 'sendrawtransaction', 'signrawtransaction', 'sendtoaddress',
                       'importprivkey', 'getwalletinfo', 'addnode', 'setmocktime', 'invalidateblock',
                       'createrawtransaction', 'getblock', 'getblockhash ', 'GETNETWORKINFO']:
            with self.subTest(method=method), self.assertRaises(ValueError): d.rpc_arguments('cli', [], method)

    def test_rpc_parameter_mutations_rejected(self):
        cases = [('getblockhash', '1'), ('getblockhash', '00'), ('getblockhash', 0),
                 ('getnetworkinfo', 'unexpected'), ('decodescript', '51'), ('decodescript', ''),
                 ('generatetoaddress', '1352', d.BURN_ADDRESS, '1000000', '0'),
                 ('generatetoaddress', '1350', d.BURN_ADDRESS, '1000001', '0'),
                 ('generatetoaddress', '1350', d.BURN_ADDRESS, '1000000', '1'),
                 ('generatetoaddress', '1', 'external-address', '1000000', '0'),
                 ('generatetoaddress', '0', d.BURN_ADDRESS, '1000000', '0'),
                 ('generatetoaddress', '-1', d.BURN_ADDRESS, '1000000', '0')]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError): d.rpc_arguments('cli', [], *case)

    def height(self, height, active):
        return {'chain': 'regtest', 'blocks': height, 'headers': height,
                'softforks': [{'id': 'bip65', 'reject': {'status': active}}]}

    def test_cltv_activation_boundaries_not_assumed_at_genesis(self):
        for height, active in [(0, False), (1350, False), (1351, True), (1352, True)]:
            d.validate_height(self.height(height, active), height, active)
            with self.assertRaises(ValueError): d.validate_height(self.height(height, not active), height, active)

    def test_wrong_heights_network_and_ambiguous_activation_fail_closed(self):
        good = self.height(1351, True)
        mutations = []
        for field, value in [('chain', 'main'), ('chain', 'test'), ('blocks', 1350), ('headers', 1350),
                             ('blocks', True), ('headers', '1351')]:
            bad = deepcopy(good); bad[field] = value; mutations.append(bad)
        bad = deepcopy(good); bad['softforks'] *= 2; mutations.append(bad)
        bad = deepcopy(good); bad['softforks'] = []; mutations.append(bad)
        bad = deepcopy(good); bad['softforks'][0]['reject']['status'] = 1; mutations.append(bad)
        for bad in mutations:
            with self.subTest(value=bad), self.assertRaises(ValueError): d.validate_height(bad, 1351, True)
        with self.assertRaises(ValueError): d.validate_height(self.height(1353, True), 1353, True)

    def server_methods(self):
        return ['getblockchaininfo', 'getblockhash', 'getnetworkinfo', 'getpeerinfo'] + ['decodescript'] * 5 + ['generatetoaddress'] * 3 + ['stop']

    def test_server_rpc_transcript_must_match_exact_method_set_and_counts(self):
        def log(items): return '\n'.join('ThreadRPCServer method=' + x for x in items)
        good = self.server_methods()
        self.assertEqual(d.validate_server_methods(log(good)), good)
        bad_cases = [[], good[:-1], good + ['getpeerinfo'], good[:-1] + ['sendrawtransaction', 'stop'],
                     good[:-1] + ['generatetoaddress', 'stop'], good[:-1] + ['decodescript', 'stop'],
                     [x for x in good if x != 'getblockhash']]
        for bad in bad_cases:
            with self.subTest(methods=bad), self.assertRaises(ValueError): d.validate_server_methods(log(bad))

    def test_spdx_member_is_exact_unique_and_signed_digest_bound(self):
        member = {'fileName': './' + d.LIBRARY_MEMBER,
                  'checksums': [{'algorithm': 'SHA256', 'checksumValue': d.LIBRARY_SHA256}]}
        d.validate_spdx_member({'files': [member]}, d.LIBRARY_MEMBER, d.LIBRARY_SHA256)
        for files in [[], [member, member], [{'fileName': member['fileName'], 'checksums': []}],
                      [{'fileName': member['fileName'], 'checksums': [{'algorithm': 'SHA256', 'checksumValue': '0' * 64}]}]]:
            with self.subTest(files=files), self.assertRaises(ValueError): d.validate_spdx_member({'files': files}, d.LIBRARY_MEMBER, d.LIBRARY_SHA256)

    def test_wrong_archive_and_symlink_rejected_before_native_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); archive = root / 'wrong.tar.gz'; archive.write_bytes(b'not trusted')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                d.extract_verified_members(archive, {}, root)
            linked = root / 'linked.tar.gz'; linked.symlink_to(archive)
            with self.assertRaisesRegex(ValueError, 'regular D0'):
                d.extract_verified_members(linked, {}, root)
            with self.assertRaisesRegex(ValueError, 'changed before load'):
                d.execute_consensus_vectors(archive)

    def test_invalid_authorization_rejected_before_environment_inspection(self):
        from argparse import Namespace
        for value in ['AUTHORIZE_D1_ISOLATED_REGTEST', '', 'AUTHORIZE_D3']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'D2'):
                d.run(Namespace(authorization=value))

    def test_serializer_rejects_boolean_or_out_of_range_fields(self):
        for field in ['locktime', 'sequence']:
            for value in [True, -1, 2**32, '1351']:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    d.synthetic_tx(**{field: value})
        with self.assertRaises(ValueError): d.push(b'x' * 76)
        with self.assertRaises(ValueError): d.synthetic_tx(b'x' * 253)

    def test_preserved_execution_proof_cannot_promote_diagnostic_success(self):
        root = d.D2_DIR.parents[3] / 'docs/asset-exchange/audits/evidence/doge-d2-20261029'
        archive = (root / 'original-ci-evidence.zip').read_bytes()
        self.assertEqual(hashlib.sha256(archive).hexdigest(), '8f700c1eaccabf13df6873a4ec1a65931779b0bc231007e3b489615e3d18ebef')
        with zipfile.ZipFile(root / 'original-ci-evidence.zip') as original:
            report = json.loads(original.read('regtest-run/evidence/d2-report.json'))
            effective = json.loads(original.read('regtest-run/evidence/effective-manifest.json'))
        self.assertEqual(effective, d.manifest())
        self.assertEqual(report['diagnosticStatus'], 'PASS')
        self.assertEqual(report['qualificationStatus'], 'BLOCKED')
        self.assertEqual(report['generatedSyntheticBlocks'], 1352)
        self.assertEqual(report['shutdownExitCode'], 0)
        self.assertEqual(len(report['consensusVectors']), 23)
        for vector in report['consensusVectors']:
            self.assertEqual(vector['result'], vector['expectedResult'])
            self.assertEqual(vector['error'], vector['expectedError'])
        self.assertEqual(report['finalPeers'], [])
        self.assertEqual(report['finalNetwork']['connections'], 0)
        self.assertFalse(report['signingPerformed'])
        self.assertFalse(report['broadcastPerformed'])
        for field in ['namespaceInterfacesBefore', 'namespaceInterfacesAfter']:
            self.assertEqual([link['ifname'] for link in report[field]], ['lo'])
        self.assertEqual(report, json.loads((root / 'd2-report.json').read_text()))

    def test_shell_requires_exact_scope_and_clears_inherited_environment(self):
        path = d.D2_DIR / 'run-isolated.sh'
        subprocess.run(['bash', '-n', str(path)], check=True)
        result = subprocess.run(['bash', str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        source = path.read_text()
        self.assertIn('AUTHORIZE_D2_SCRIPT_DIAGNOSTICS', source)
        self.assertIn('/usr/bin/env -i', source)
        self.assertIn('sudo unshare --net', source)
        self.assertNotIn('AUTHORIZE_D1_', source)


if __name__ == '__main__': unittest.main()
