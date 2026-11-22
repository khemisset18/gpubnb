"""Only public bytes and offline deterministic D2-style HTLC fixtures."""
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("htlc_ledger_probe", HERE / "ledger_htlc_refund_probe.py")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class LedgerHtlcProbeTests(unittest.TestCase):
    def test_d2_redemption_template_and_p2sh_output_are_canonical(self):
        key = b"\x02" + h.tx.G[0].to_bytes(32, "big")
        redeem = h.synthetic_refund_redeem(key)
        self.assertTrue(redeem.startswith(bytes.fromhex("6382012088a820")))
        self.assertIn(bytes.fromhex("ac67024705b17521"), redeem)
        self.assertTrue(redeem.endswith(key + bytes.fromhex("ac68")))
        p2sh = h.contract_script_pubkey(redeem)
        self.assertEqual(len(p2sh), 23)
        self.assertEqual(p2sh[:2], bytes.fromhex("a914"))
        self.assertEqual(p2sh[-1], 0x87)

    def test_htlc_preimage_mutations_lock_fee_script(self):
        key = b"\x02" + h.tx.G[0].to_bytes(32, "big")
        redeem = h.synthetic_refund_redeem(key)
        funding = h.tx.synth_funding(h.contract_script_pubkey(redeem))
        outputs = b"\x01" + h.tx.output(h.tx.PAYMENT_KOINU, h.tx.p2pkh_script(h.tx.DUMMY_DESTINATION_HASH))
        digest = h.spend_digest(funding, redeem, outputs)
        self.assertNotEqual(digest, h.spend_digest(funding, redeem, outputs, lock=h.LOCK_HEIGHT + 1))
        different = b"\x01" + h.tx.output(h.tx.PAYMENT_KOINU - 1, h.tx.p2pkh_script(h.tx.DUMMY_DESTINATION_HASH))
        self.assertNotEqual(digest, h.spend_digest(funding, redeem, different))
        with self.assertRaises(ValueError):
            h.spend_digest(funding, redeem, outputs, sequence=0xffffffff)
        self.assertNotEqual(digest, h.spend_digest(funding, redeem, outputs,
            sequence=h.SEQUENCE-1, negative_only=True))
        self.assertNotEqual(digest, h.spend_digest(funding, redeem, outputs,
            sighash_type=2, negative_only=True))
        with self.assertRaises(ValueError):
            h.spend_digest(funding, redeem, outputs, sighash_type=2)
        changed = funding[:7] + bytes([funding[7] ^ 1]) + funding[8:]
        self.assertNotEqual(digest, h.spend_digest(changed, redeem, outputs))
        destination = h.tx.p2pkh_script(bytes([3] * 20))
        self.assertNotEqual(digest, h.spend_digest(funding, redeem,
            b"\x01" + h.tx.output(h.tx.PAYMENT_KOINU, destination)))

    def test_refund_scriptsig_only_branch_false_with_canonical_redeem(self):
        key = b"\x02" + h.tx.G[0].to_bytes(32, "big")
        redeem = h.synthetic_refund_redeem(key)
        fake_der = bytes.fromhex("3044022001" + "00"*31 + "022001" + "00"*31)
        sig = fake_der + b"\x01"
        script = h.synthetic_scriptsig(sig, redeem)
        self.assertEqual(script[0], len(sig))
        self.assertEqual(script[1:1+len(sig)], sig)
        self.assertEqual(script[1+len(sig)], 0x00)
        self.assertEqual(script[2+len(sig):4+len(sig)], b"\x4c" + bytes([len(redeem)]))
        self.assertTrue(script.endswith(redeem))
        with self.assertRaises(ValueError):
            h.synthetic_refund_redeem(b"\x02" + bytes(31))


if __name__ == "__main__":
    unittest.main()
