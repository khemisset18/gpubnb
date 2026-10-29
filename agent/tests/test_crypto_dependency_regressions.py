"""Compatibility and rejection checks for the security-fixed PyNaCl/libsodium.

The key and signature are public RFC 8032 section 7.1 TEST 1 fixtures.
No production key, wallet, network request or financial operation is involved.
https://www.rfc-editor.org/rfc/rfc8032#section-7.1
"""
import unittest

from nacl.bindings import crypto_core_ed25519_is_valid_point
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey


class CryptoDependencyRegressions(unittest.TestCase):
    def test_rfc8032_signature_bytes_and_tamper_rejection(self):
        seed = bytes.fromhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
        public = bytes.fromhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
        signature = bytes.fromhex(
            'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'
            '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b')
        key = SigningKey(seed)
        self.assertEqual(bytes(key.verify_key), public)
        self.assertEqual(key.sign(b'').signature, signature)
        self.assertEqual(VerifyKey(public).verify(b'', signature), b'')
        with self.assertRaises(BadSignatureError):
            VerifyKey(public).verify(b'changed', signature)
        changed = bytearray(signature)
        changed[0] ^= 1
        with self.assertRaises(BadSignatureError):
            VerifyKey(public).verify(b'', bytes(changed))

    def test_point_validation_rejects_identity_small_order_and_noncanonical_points(self):
        public = bytes.fromhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
        self.assertTrue(crypto_core_ed25519_is_valid_point(public))
        for point in [bytes(32), b'\x01' + bytes(31), b'\xff' * 32]:
            with self.subTest(point=point.hex()):
                self.assertFalse(crypto_core_ed25519_is_valid_point(point))
