import json
from pathlib import Path
import unittest
from unittest.mock import patch

from qualification_request import compile_qualification_request, CASES


class QualificationRequestTests(unittest.TestCase):
    def test_request_hashes_all_local_runtime_imports(self):
        terms=json.loads((Path(__file__).parent/'fixtures/spend_terms_v1.json').read_text())["terms"]
        files={r['path']:r['sha256'] for r in compile_qualification_request(terms)['inputFiles']}
        self.assertIn('offline_candidate.py',files)
        import hashlib
        self.assertEqual(files['offline_candidate.py'],hashlib.sha256((Path(__file__).parent/'offline_candidate.py').read_bytes()).hexdigest())

    def test_request_is_bounded_and_cannot_execute_or_become_approval(self):
        terms=json.loads((Path(__file__).parent/'fixtures/spend_terms_v1.json').read_text())["terms"]
        with patch('subprocess.run',side_effect=AssertionError('no process allowed')), \
             patch('ctypes.CDLL',side_effect=AssertionError('no native code allowed')):
            result=compile_qualification_request(terms)
        self.assertFalse(result["approved"])
        self.assertFalse(result["readyForAuthorization"])
        self.assertFalse(result["nativeExecutorImplemented"])
        self.assertIsNone(result["publicSignedFixtureSetDigest"])
        self.assertIsNone(result["transactionBytes"])
        self.assertEqual(result["qualificationStatus"],"BLOCKED")
        self.assertEqual(result["executableOperations"],[])
        self.assertEqual(result["proposedResourceBounds"]["maxSubmissions"],len(CASES))
        self.assertEqual(len(CASES),len(set(CASES)))
        self.assertFalse(result["proposedConfiguration"]["acceptNonstandard"])
        self.assertIsNone(result["proposedConfiguration"]["promiscuousMempoolFlags"])
        self.assertNotIn("testmempoolaccept",result["unapprovedFutureRpcMethods"])

    def test_policy_source_map_retains_actual_version_and_unmeasured_native_criteria(self):
        v=json.loads((Path(__file__).parent/'fixtures/source_policy_map_v1.json').read_text())
        self.assertEqual(v["sourceCommit"],"e0a1c157791544e818c901bd9341896965afbf9d")
        ids={x["id"] for x in v["conditions"]}
        self.assertEqual(len(ids),21)
        self.assertTrue({"STANDARDNESS_CONFIGURATION","SCRIPT_FLAG_OVERRIDE","RPC_FREE_LIMITER",
            "RPC_ERROR_AFTER_ADMISSION","FINALITY_MEMPOOL","FINALITY_BLOCK"}.issubset(ids))
        for row in v["conditions"]:
            self.assertIn(v["sourceCommit"],row["sourceUrl"])
            self.assertTrue(row["anchorLines"])
            self.assertEqual(row["nativeEvidenceForNewHtlc"],"NOT TESTED")
            self.assertRegex(v["files"][row["path"]]["sha256"],r'^[0-9a-f]{64}$')
        self.assertFalse(v["rpcTestMempoolAcceptPresent"])
        self.assertEqual(v["qualificationStatus"],"BLOCKED")


if __name__=='__main__':
    unittest.main()
