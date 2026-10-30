import gzip
import hashlib
import json
from pathlib import Path
import tomllib
import unittest

HERE = Path(__file__).resolve().parent


class ReviewEvidenceTests(unittest.TestCase):
    def test_original_advisories_recover_exactly(self):
        records = json.loads((HERE / 'ADVISORY_DISCREPANCY.json').read_text())['sources']
        for record in records[:2]:
            path = HERE / 'advisory-sources' / record.get('originalSnapshot', record['path'])
            data = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), record['sha256'])
            if 'readableViewSha256' in record:
                view = (HERE / 'advisory-sources' / record['path']).read_bytes()
                self.assertEqual(view, b'\n'.join(line.rstrip(b' \t') for line in data.split(b'\n')))
                self.assertEqual(hashlib.sha256(view).hexdigest(), record['readableViewSha256'])

    def test_conflicting_ranges_remain_visible(self):
        raw = gzip.decompress((HERE / 'advisory-sources/rustsec-borsh.md.gz').read_bytes()).decode()
        rustsec = tomllib.loads(raw.split('```toml\n', 1)[1].split('```', 1)[0])
        self.assertIn('^0.10.4', rustsec['versions']['patched'])
        github = json.loads((HERE / 'advisory-sources/github-borsh.json').read_text())
        self.assertEqual(github['affected'][0]['ranges'][0]['events'], [{'introduced':'0'}, {'fixed':'1.0.0-alpha.1'}])
        self.assertEqual(github['affected'][0]['database_specific']['last_known_affected_version_range'], '<= 0.10.3')
        self.assertIn('BLOCKED', json.loads((HERE / 'ADVISORY_DISCREPANCY.json').read_text())['disposition'])


if __name__ == '__main__':
    unittest.main()
