import tempfile
from pathlib import Path
import unittest

import oracle


class IndependentOracleBoundaryTests(unittest.TestCase):
    def test_public_generator_order_and_published_double(self):
        expected = (
            0xC6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5,
            0x1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A,
        )
        self.assertEqual(oracle.multiply(2, oracle.G), expected)
        self.assertEqual(oracle.multiply(oracle.N, oracle.G), None)

    def test_noncanonical_der_is_not_reinterpreted_as_compact_input(self):
        self.assertEqual(oracle.parse_der(bytes.fromhex('3006020101020101')), bytes(31)+b'\x01'+bytes(31)+b'\x01')
        for raw in ['300702020001020101', '3006020180020101', '300602010102010100', '308106020101020101']:
            self.assertIsNone(oracle.parse_der(bytes.fromhex(raw)))

    def test_changed_public_vectors_are_refused_before_json_parsing(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)/'changed.json'
            source.write_bytes(b'not trusted public fixtures')
            with self.assertRaisesRegex(AssertionError, 'SHA256'):
                oracle.fixtures(source)

    def test_error_precedence_rejects_hash_before_recovery_id(self):
        self.assertEqual(oracle.recover(b'', 255, b''), {'error': 'InvalidHash'})
        self.assertEqual(oracle.recover(bytes(32), 255, b''), {'error': 'InvalidRecoveryId'})


if __name__ == '__main__':
    unittest.main()
