"""Reject profile substitutions before importing a financial verifier."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('gtk_qualification', Path(__file__).with_name('prepare.py'))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class FinancialProfileBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        (self.root / 'Cargo.lock').write_text('version = 4\n')
        self.folder = self.root / 'prototypes/anchor-sdk-migration'
        self.folder.mkdir(parents=True)
        self.verifier = self.folder / 'integrity.py'
        self.verifier.write_text("from pathlib import Path\nPath(__file__).with_name('IMPORT_EXECUTED').touch()\n")
        self.pins_file = self.folder / 'source-pins.json'
        self.pins_file.write_text('{}\n')
        self.profile = {
            'kind': 'qualified-anchor-sdk-1.2.2',
            'integrityModule': 'prototypes/anchor-sdk-migration/integrity.py',
            'integrityModuleSha256': qualification.digest(self.verifier),
            'sourcePins': 'prototypes/anchor-sdk-migration/source-pins.json',
            'sourcePinsSha256': qualification.digest(self.pins_file),
            'financialGraphSha256': '1' * 64,
            'financialSourceSha256': qualification.FINANCIAL_PROGRAM_SHA256,
            'financialPackageCount': 182,
        }

    def refuses(self, message):
        with self.assertRaisesRegex(AssertionError, message):
            qualification.financial_profile(self.root, {'financialProfile': self.profile})
        self.assertFalse((self.folder / 'IMPORT_EXECUTED').exists())

    def test_unapproved_profile_is_rejected(self):
        self.profile['kind'] = 'unreviewed'
        self.refuses('unreviewed financial profile')

    def test_changed_financial_protocol_source_is_rejected(self):
        self.profile['financialSourceSha256'] = '0' * 64
        self.refuses('financial protocol source')

    def test_alternate_verifier_path_is_rejected(self):
        self.profile['integrityModule'] = '../integrity.py'
        self.refuses('unreviewed financial verifier path')

    def test_modified_verifier_is_not_imported(self):
        self.verifier.write_text(self.verifier.read_text() + '# altered source\n')
        self.refuses('financial verifier/pins changed')

    def test_modified_pins_are_rejected_before_importing_valid_verifier(self):
        self.pins_file.write_text('{"altered":true}\n')
        self.refuses('financial verifier/pins changed')

    def test_resolved_graph_different_from_reviewed_profile_is_rejected(self):
        result = {'financialGraphSha256': '2' * 64, 'packages': 182,
                  'financialSourceSha256': qualification.FINANCIAL_PROGRAM_SHA256}
        self.verifier.write_text('def validate_candidate(repo, pins):\n    return ' + repr(result) + '\n')
        self.profile['integrityModuleSha256'] = qualification.digest(self.verifier)
        self.refuses('financial graph not the qualified profile')


if __name__ == '__main__':
    unittest.main()
