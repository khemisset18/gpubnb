"""Test synthetic transaction fixture and independent secp256k1 verifier."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("doge_ledger_tx_probe", HERE / "ledger_tx_sign_probe.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def der_int(number):
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    if raw[0] & 0x80:
        raw = b"\x00" + raw
    return b"\x02" + bytes([len(raw)]) + raw


class FixtureTests(unittest.TestCase):
    def test_fake_amount_and_output_are_fixed(self):
        self.assertEqual(p.FUNDING_KOINU, 500_000_000)
        self.assertEqual(p.PAYMENT_KOINU, 499_000_000)
        self.assertEqual(p.FEE_KOINU, 1_000_000)
        with self.assertRaises(ValueError):
            p.output(-1, p.p2pkh_script(p.DUMMY_DESTINATION_HASH))
        with self.assertRaises(ValueError):
            p.output(9_999_999_999, p.p2pkh_script(p.DUMMY_DESTINATION_HASH))

    def test_real_ecdsa_verifier_accepts_fixture_signature_and_rejects_mutation(self):
        # Nonsecret public scalar-1 test vector, not used by Speculos wallet.
        digest = p.sha256d(b"GPUbnb public-only ECDSA test vector")
        z = int.from_bytes(digest, "big")
        r = p.G[0] % p.N
        s = (z + r) % p.N  # dummy nonce=1; only for mathematical unit tests
        ints = der_int(r) + der_int(s)
        der = b"\x30" + bytes([len(ints)]) + ints
        pub = b"\x04" + p.G[0].to_bytes(32,"big") + p.G[1].to_bytes(32,"big")
        self.assertTrue(p.check_signature(der, digest, pub))
        self.assertFalse(p.check_signature(der, p.sha256d(b"changed"), pub))

    def test_fixed_synthetic_preimage_mutation_changes_digest(self):
        script = p.p2pkh_script(bytes([2] * 20))
        funding = p.synth_funding(script)
        outputs = b"\x01" + p.output(p.PAYMENT_KOINU, p.p2pkh_script(p.DUMMY_DESTINATION_HASH))
        changed = b"\x01" + p.output(p.PAYMENT_KOINU-1, p.p2pkh_script(p.DUMMY_DESTINATION_HASH))
        self.assertNotEqual(p.make_digest(funding, script, outputs), p.make_digest(funding, script, changed))

    def test_script_sequence_must_share_one_legacy_apdu(self):
        script = p.p2pkh_script(bytes([7] * 20))
        trusted = bytes([0x32] * 56)
        chunk = p.build_input_hash_chunk(trusted, script)
        self.assertEqual(chunk, b"\x01" + b"\x38" + trusted + b"\x19" + script + p.SEQUENCE)
        self.assertEqual(chunk[-4:], bytes.fromhex("ffffffff"))
        self.assertEqual(len(chunk), 88)
        self.assertEqual(bytes.fromhex(p.make_apdu(0x44, 0x80, 0, chunk))[5:], chunk)
        with self.assertRaises(ValueError):
            p.build_input_hash_chunk(bytes(47), script)
        with self.assertRaises(ValueError):
            p.build_input_hash_chunk(trusted, bytes([0] * 25))

    def test_apdu_whitelist_and_payload_bound(self):
        for ins in (0x40,0x4e,0xff,0x47):
            with self.assertRaises(ValueError):
                p.make_apdu(ins,0,0,b"")
        with self.assertRaises(ValueError):
            p.make_apdu(0x48,0,0,bytes(256))
        self.assertEqual(p.make_apdu(0x48,0,0,b"\x01"),"e04800000101")


if __name__ == "__main__":
    unittest.main()
