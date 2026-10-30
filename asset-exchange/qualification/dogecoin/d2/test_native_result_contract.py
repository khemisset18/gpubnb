import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from native_result_contract import HERE, compare_report, scenario_catalog, strict_json
from qualification_request import CASES, compile_qualification_request


def example():
    return json.loads((HERE/'fixtures/native_report_model_v1.json').read_text())


class NativeResultContractTests(unittest.TestCase):
    def test_full_model_comparison_never_counts_native_or_grants_qualification(self):
        with patch('ctypes.CDLL',side_effect=AssertionError('native loading forbidden')), \
             patch('subprocess.run',side_effect=AssertionError('process forbidden')), \
             patch('socket.socket',side_effect=AssertionError('network forbidden')):
            result=compare_report(example(),HERE/'fixtures')
        self.assertEqual(result['comparison'],'MATCHED_UNAUTHENTICATED_CLAIMS')
        self.assertEqual(result['reportedMatchedNativeCases'],0)
        self.assertEqual(result['verifiedNativeCases'],0)
        self.assertEqual(result['qualificationStatus'],'BLOCKED')
        self.assertEqual(result['executableOperations'],[])
        self.assertTrue(result['missingSignedFixtures'])

    def test_a_complete_forged_native_claim_still_cannot_qualify(self):
        report=example();report['producer']='NATIVE_DOGECOIN_1_14_9'
        report['signedFixtureSetDigest']='a'*64
        report['nativeExecutorCommit']='b'*40
        result=compare_report(report,HERE/'fixtures')
        self.assertGreater(result['reportedMatchedNativeCases'],0)
        self.assertEqual(result['verifiedNativeCases'],0)
        for field in ['authorizationVerified','producerIdentityVerified','runtimeContextVerified','signatureAndUtxoProofsVerified']:
            self.assertIs(result[field],False)
        self.assertEqual(result['qualificationStatus'],'BLOCKED')

    def test_inventory_keeps_expected_layers_separate_and_request_hashes_new_sources(self):
        matrix,sha=scenario_catalog();rows={r['id']:r for r in matrix['cases']}
        self.assertEqual(set(rows),set(CASES))
        self.assertEqual(rows['early_refund']['expected']['SCRIPT'],'PASS')
        self.assertEqual(rows['early_refund']['expected']['FINALITY'],'REJECT')
        self.assertEqual(rows['final_sequence']['expected'],{'SCRIPT':'REJECT','FINALITY':'PASS'})
        self.assertEqual(rows['wrong_input_value']['measurementKind'],'OFFLINE_PREFLIGHT')
        self.assertEqual(rows['soft_dust_reserve']['measurementKind'],'NATIVE_POLICY_PROBE')
        terms=json.loads((HERE/'fixtures/spend_terms_v1.json').read_text())['terms']
        request=compile_qualification_request(terms)
        self.assertEqual(request['nativeScenarioMatrixSha256'],sha)
        paths={r['path'] for r in request['inputFiles']}
        self.assertTrue({'native_result_contract.py','fixtures/native_scenarios_v1.json'}.issubset(paths))
        self.assertFalse(request['readyForAuthorization'])

    def test_missing_mismatched_unknown_duplicate_or_unlinked_cases_block(self):
        report=example();removed=report['cases'].pop()
        self.assertIn(removed['id'],compare_report(report,HERE/'fixtures')['missingCases'])
        report=example();report['cases'][0]['outcomes']['SCRIPT']='REJECT'
        self.assertIn('valid_claim',compare_report(report,HERE/'fixtures')['mismatchedCases'])
        report=example();report['cases'][0]['artifact']='unlisted.log'
        self.assertIn('valid_claim',compare_report(report,HERE/'fixtures')['casesWithoutArtifacts'])
        report=example();report['cases'][0]['measurementKind']='MODEL'
        self.assertIn('valid_claim',compare_report(report,HERE/'fixtures')['mismatchedCases'])
        for mutate in [lambda r:r['cases'].append(copy.deepcopy(r['cases'][0])),lambda r:r['cases'][0].update(id='unknown_case')]:
            report=example();mutate(report)
            with self.assertRaises(ValueError):compare_report(report,HERE/'fixtures')

    def test_pinned_source_binary_network_and_matrix_mutations_reject(self):
        for field,value in [('sourceCommit','a'*40),('archiveSha256','a'*64),('consensusLibrarySha256','b'*64),('nativeExecutorCommit','unfrozen'),('genesis','a'*64),('network','main'),('scenarioMatrixSha256','b'*64),('schemaVersion',True)]:
            report=example();report[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):compare_report(report,HERE/'fixtures')

    def test_untyped_or_unsafe_network_standardness_wallet_claims_reject(self):
        for field,value in [('interfaces',['lo','eth0']),('peers',True),('peers',1),('externalConnections',False),('walletEnabled',True),
            ('acceptNonstandard',None),('acceptNonstandard',True),('promiscuousMempoolFlags',0),('bip65Enforced',False)]:
            report=example();report['context'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):compare_report(report,HERE/'fixtures')

    def test_artifact_hash_mismatch_missing_file_symlink_hardlink_and_path_traversal_reject(self):
        import os
        with tempfile.TemporaryDirectory() as raw:
            directory=Path(raw);path=directory/'public-model.log';original=(HERE/'fixtures/public-model.log').read_bytes();path.write_bytes(original)
            report=example();report['artifacts'][0]['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'hash mismatch'):compare_report(report,directory)
            for name in ['../public-model.log','/public-model.log','sub/file.log','native.bin',[],{},None]:
                report=example();report['artifacts'][0]['path']=name
                with self.assertRaises(ValueError):compare_report(report,directory)
            path.unlink()
            with self.assertRaises(OSError):compare_report(example(),directory)
            target=directory/'target.log';target.write_bytes(original);path.symlink_to(target)
            with self.assertRaises(OSError):compare_report(example(),directory)
            path.unlink();os.link(target,path)
            with self.assertRaisesRegex(ValueError,'single-link'):compare_report(example(),directory)

    def test_strict_json_rejects_duplicate_keys_nonfinite_values_and_executable_fields(self):
        for raw in [b'{"producer":"MODEL","producer":"NATIVE"}',b'{"x":NaN}',b'{"x":Infinity}',b'\xff',b'['*1500+b'0'+b']'*1500]:
            with self.assertRaises((ValueError,UnicodeError)):strict_json(raw)
        for key in ['signature','privateKey','transactionHex','qualified']:
            report=example();report[key]='forbidden'
            with self.assertRaises(ValueError):compare_report(report,HERE/'fixtures')

    def test_fifo_cannot_block_the_cli_and_oversized_artifacts_fail_before_hashing(self):
        import os
        with tempfile.TemporaryDirectory() as raw:
            directory=Path(raw);os.mkfifo(directory/'fifo.log',0o600)
            result=subprocess.run([sys.executable,str(HERE/'native_result_contract.py'),str(directory),'fifo.log'],capture_output=True,text=True,timeout=3)
            self.assertEqual(result.returncode,1,result.stderr)
            output=json.loads(result.stdout)
            self.assertEqual(output['comparison'],'REJECTED');self.assertIn('regular',output['error'])
            (directory/'public-model.log').write_bytes(b'x'*262145)
            with self.assertRaisesRegex(ValueError,'bounded single-link'):
                compare_report(example(),directory)

    def test_scenario_expectations_cannot_be_silently_replaced(self):
        matrix=json.loads((HERE/'fixtures/native_scenarios_v1.json').read_text())
        matrix['cases'][0]['expected']['SCRIPT']='REJECT'
        with patch('native_result_contract.Path.read_bytes',return_value=json.dumps(matrix).encode()),self.assertRaisesRegex(ValueError,'frozen scenario matrix'):
            scenario_catalog()

    def test_cli_always_exits_blocked_for_matching_model_input(self):
        result=subprocess.run([sys.executable,str(HERE/'native_result_contract.py'),str(HERE/'fixtures'),'native_report_model_v1.json'],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,1,result.stderr)
        output=json.loads(result.stdout)
        self.assertEqual(output['comparison'],'MATCHED_UNAUTHENTICATED_CLAIMS')
        self.assertEqual(output['qualificationStatus'],'BLOCKED')


if __name__=='__main__':
    unittest.main()
