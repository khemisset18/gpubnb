import hashlib
from pathlib import Path
import tempfile
import unittest

import qualify


class WireReceiptParsingTests(unittest.TestCase):
    def test_real_baseline_and_candidate_logs_include_prefixed_receipts(self):
        evidence = qualify.HERE.parents[1]/'docs/asset-exchange/research/2026-11-20/anchor-sdk'
        for name in ['wire-baseline.log', 'wire-candidate.log']:
            with self.subTest(log=name):
                records = qualify.wire_records(evidence/name)
                self.assertEqual(len(records), 38)
                self.assertEqual(hashlib.sha256(('\n'.join(records)+'\n').encode()).hexdigest(),
                                 'a071dc6e64629ddf7155001a92acfb593761bacbcc1ab03a28a9b080a88e3700')

    def test_duplicate_or_missing_receipt_is_rejected(self):
        evidence = qualify.HERE.parents[1]/'docs/asset-exchange/research/2026-11-20/anchor-sdk/wire-baseline.log'
        records = qualify.wire_records(evidence)
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp)/'rust.log'
            for altered in [records[:-1], records+[records[0]]]:
                log.write_text('\r\n'.join(altered), encoding='utf-8')
                with self.assertRaisesRegex(AssertionError, 'ABI records'):
                    qualify.wire_records(log)


if __name__ == '__main__':
    unittest.main()
