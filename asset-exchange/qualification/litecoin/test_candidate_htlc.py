"""Public synthetic script byte tests. Absolutely no keygen/signing/transactions."""
import hashlib
import unittest
from unittest.mock import patch
import candidate_htlc as h

HASH = bytes.fromhex('a1' * 32)
# Synthetically-shaped *public* bytes: no private key, no real wallet identity.
REDEEM = bytes.fromhex('02' + '11' * 32)
REFUND = bytes.fromhex('03' + '22' * 32)
HEIGHT = 450


def make(height=HEIGHT):
    return h.build_synthetic_htlc_script(HASH, REDEEM, REFUND, height)


class CandidateLtcScriptTests(unittest.TestCase):
    def test_script_prefix_checks_size_then_hash(self):
        script = make()
        self.assertTrue(script.startswith(bytes.fromhex('6382012088a820') + HASH))

    def test_redeem_if_path_contains_signature_check(self):
        self.assertIn(bytes([0x88, 33]) + REDEEM + bytes([0xac, 0x67]), make())

    def test_refund_path_contains_cltv_and_drop_then_key(self):
        self.assertIn(bytes.fromhex('02c201b17521') + REFUND + bytes.fromhex('ac68'), make())

    def test_canonical_script_roundtrip(self):
        result = h.inspect_synthetic_htlc_script(make())
        self.assertEqual(bytes.fromhex(result['scriptHex']), make())
        self.assertEqual(result['refundHeight'], HEIGHT)

    def test_p2wsh_is_sha256_of_script(self):
        script = make()
        actual = h.inspect_synthetic_htlc_script(script)['p2wshScriptPubKeyHex']
        self.assertEqual(actual, '0020' + hashlib.sha256(script).hexdigest())

    def test_returned_public_material_only(self):
        actual = h.inspect_synthetic_htlc_script(make())
        self.assertEqual(actual['redeemPubkeyHex'], REDEEM.hex())
        self.assertEqual(actual['refundPubkeyHex'], REFUND.hex())
        self.assertEqual(actual['secretHashHex'], HASH.hex())
        self.assertNotIn('signature', actual)
        self.assertNotIn('transaction', actual)
        self.assertNotIn('witness', actual)

    def test_financial_promotion_flags_remain_false(self):
        result = h.inspect_synthetic_htlc_script(make())
        for field in ['nativeConsensusVerified', 'qualified', 'canSign',
                      'canBroadcast', 'automaticSettlementSupported']:
            self.assertIs(result[field], False)

    def test_small_height_uses_op_n(self):
        for height in range(1, 17):
            with self.subTest(height=height):
                actual = h.inspect_synthetic_htlc_script(make(height))
                self.assertEqual(actual['refundHeight'], height)
                self.assertIn(bytes([0xac, 0x67, 0x50 + height, 0xb1]), make(height))

    def test_height_17_uses_minimal_push(self):
        script = make(17)
        self.assertIn(bytes.fromhex('ac670111b175'), script)
        self.assertEqual(h.inspect_synthetic_htlc_script(script)['refundHeight'], 17)

    def test_height_127_and_128_minimal_scriptnum(self):
        self.assertIn(bytes.fromhex('ac67017fb175'), make(127))
        self.assertIn(bytes.fromhex('ac67028000b175'), make(128))

    def test_height_255_and_256_minimal_scriptnum(self):
        self.assertIn(bytes.fromhex('ac6702ff00b175'), make(255))
        self.assertIn(bytes.fromhex('ac67020001b175'), make(256))

    def test_highest_supported_height_roundtrip(self):
        self.assertEqual(h.inspect_synthetic_htlc_script(make(499999999))['refundHeight'], 499999999)

    def test_invalid_height_rejected(self):
        for value in [0, -1, 500000000, 2**32, True, 450.0, '450', None]:
            with self.subTest(value=value), self.assertRaises(h.ScriptRefused):
                make(value)

    def test_invalid_secret_hash_rejected(self):
        for value in [b'', bytes(32), bytes(31), bytes(33), 'a1' * 32, None]:
            with self.subTest(value=repr(value)[:30]), self.assertRaises(h.ScriptRefused):
                h.build_synthetic_htlc_script(value, REDEEM, REFUND, HEIGHT)

    def test_invalid_redeem_pubkey_shapes_rejected(self):
        for key in [bytes(33), bytes.fromhex('04' + '11'*32), b'\x02'+bytes(32),
                    b'\x02'+bytes(31), '02' + '11'*32, None]:
            with self.subTest(value=repr(key)[:30]), self.assertRaises(h.ScriptRefused):
                h.build_synthetic_htlc_script(HASH, key, REFUND, HEIGHT)

    def test_invalid_refund_pubkey_shapes_rejected(self):
        for key in [bytes(33), bytes.fromhex('04' + '22'*32), b'\x03'+bytes(32),
                    b'\x03'+bytes(31), '03' + '22'*32, None]:
            with self.subTest(value=repr(key)[:30]), self.assertRaises(h.ScriptRefused):
                h.build_synthetic_htlc_script(HASH, REDEEM, key, HEIGHT)

    def test_identical_pubkeys_rejected(self):
        with self.assertRaisesRegex(h.ScriptRefused, 'share public key'):
            h.build_synthetic_htlc_script(HASH, REDEEM, REDEEM, HEIGHT)

    def test_wrong_template_opcode_rejected(self):
        original = make()
        for idx in [0, 1, 2, 3, 4, 5, 6, 39, 40, 74, 75, 76, 79, 80, 81,
                    len(original)-2, len(original)-1]:
            mutated = bytearray(original)
            mutated[idx] ^= 1
            with self.subTest(index=idx), self.assertRaises(h.ScriptRefused):
                h.inspect_synthetic_htlc_script(bytes(mutated))

    def test_wrong_script_truncated_rejected(self):
        for end in [0, 1, 5, 20, 32, 45, len(make())-1]:
            with self.subTest(end=end), self.assertRaises(h.ScriptRefused):
                h.inspect_synthetic_htlc_script(make()[:end])

    def test_trailing_byte_rejected(self):
        with self.assertRaisesRegex(h.ScriptRefused, 'trailing'):
            h.inspect_synthetic_htlc_script(make() + b'\x00')

    def test_nonminimal_height_push_rejected(self):
        script = make(17)
        self.assertIn(b'\x01\x11\xb1', script)
        bad = script.replace(b'\x01\x11\xb1', b'\x02\x11\x00\xb1')
        with self.assertRaisesRegex(h.ScriptRefused, 'nonminimal'):
            h.inspect_synthetic_htlc_script(bad)

    def test_negative_height_push_rejected(self):
        script = make(17).replace(b'\x01\x11\xb1', b'\x01\x91\xb1')
        with self.assertRaises(h.ScriptRefused):
            h.inspect_synthetic_htlc_script(script)

    def test_nonminimal_op_n_encoding_rejected(self):
        script = make(16).replace(bytes([0x60, 0xb1]), bytes([0x01, 0x10, 0xb1]))
        with self.assertRaisesRegex(h.ScriptRefused, 'nonminimal'):
            h.inspect_synthetic_htlc_script(script)

    def test_wrong_data_type_or_oversize_rejected(self):
        for val in [None, '', bytearray(make()), make() + bytes(200), [], {}]:
            with self.subTest(value=str(type(val))), self.assertRaises(h.ScriptRefused):
                h.inspect_synthetic_htlc_script(val)

    def test_no_io_during_build_and_parse(self):
        with patch('builtins.open', side_effect=AssertionError('IO forbidden')):
            script = make()
            self.assertEqual(h.inspect_synthetic_htlc_script(script)['refundHeight'], 450)

    def test_sha256_witness_program_changes_with_script(self):
        p1 = h.inspect_synthetic_htlc_script(make(450))['p2wshScriptPubKeyHex']
        p2 = h.inspect_synthetic_htlc_script(make(451))['p2wshScriptPubKeyHex']
        self.assertNotEqual(p1, p2)


if __name__ == '__main__':
    unittest.main()
