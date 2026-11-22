"""Offline unit checks of the exact public fake-Ledger refund before native D0 load.

These tests do NOT load Dogecoin library, sign or call any RPC.
"""
import importlib.util
import hashlib
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("native_ledger_refund", HERE / "ledger_native_consensus.py")
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)

from offline_candidate import build_candidate
from test_signer import encode_der, transaction, sighash, push, ORDER


def public_fake_report():
    # No private key: mathematically valid public encoding is G as compressed.
    refund = bytes([2 + (n.CLAIM_PUB[-1] & 1)]) + n.CLAIM_PUB[1:]
    if refund == n.CLAIM_PUB:
        # Use publicly documented secp256k1 generator instead.
        refund = bytes.fromhex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
    from offline_candidate import checked_pubkey
    checked_pubkey(refund)
    claim = n.CLAIM_PUB
    contract = build_candidate(hashlib.sha256(b"synthetic public test").digest(), claim, refund, n.LOCK)
    funding = transaction(n.FAKE_INPUT_TXID, 0, b"", [(n.FUNDED, contract.output)], 0, 0xffffffff)
    funding_id = n.sha256d(funding)[::-1].hex()
    signature = encode_der(1, 1) + b"\x01"  # syntactically valid only, NOT a real signature
    signedscript = push(signature) + b"\x00" + push(contract.redeem)
    signed = transaction(funding_id, 0, signedscript, [(n.PAID, n.DEST)], n.LOCK, n.SEQ)
    r = {
        "scope": "SYNTHETIC_HTLC_REFUND_DIGEST_SIGNED_IN_MAINNET_DOGE_APP_ONLY",
        "D8_status": "BLOCKED", "ledger_app_network": "DOGE_MAINNET_PARAMETERS",
        "dogecoin_regtest_network_authenticated": False,
        "native_consensus_cltv_verified_for_this_signature": False,
        "independent_on_device_htlc_terms_displayed": False,
        "hardware_device_present": False, "real_doge_used": 0, "broadcasts": 0,
        "signature_on_synthetic_htlc_refund_digest_verified": True,
        "synthetic_refund_scriptSig_sha256": hashlib.sha256(signedscript).hexdigest(),
        "contract_redeem_sha256": hashlib.sha256(contract.redeem).hexdigest(),
        "contract_p2sh_sha256": hashlib.sha256(contract.output).hexdigest(),
        "contract_lock_height": n.LOCK, "contract_sequence": n.SEQ,
        "native_consensus_candidate": {
            "signed_transaction_hex": signed.hex(),
            "signed_transaction_sha256": hashlib.sha256(signed).hexdigest(),
            "synthetic_funding_hex": funding.hex(),
            "script_pubkey_hex": contract.output.hex(),
            "redeem_script_hex": contract.redeem.hex(),
            "signature_hex": signature.hex(),
            "signature_low_s": True,
            "expected_native_flags": 517, "input_index": 0,
            "fake_prevout": n.FAKE_INPUT_TXID,
            "reviewed_network_in_firmware": "dogecoin-mainnet",
            "hardware_qualified": False, "broadcasts": 0,
        },
    }
    return r


class NativeLedgerVerifierTests(unittest.TestCase):
    def test_public_fixture_bytes_bind_exact_script_and_offsets(self):
        report = public_fake_report()
        model = n.require_report(report)
        self.assertEqual(len(n.native_cases(model)), 12)
        self.assertEqual([x[2] for x in n.native_cases(model)], [1] + [0] * 11)
        self.assertEqual(model["funding_txid"], n.sha256d(model["funding"])[::-1].hex())
        self.assertEqual(model["signed"], bytes.fromhex(report["native_consensus_candidate"]["signed_transaction_hex"]))

    def test_change_outpoint_and_destination_is_not_the_same_fixture(self):
        model = n.require_report(public_fake_report())
        cases = n.native_cases(model)
        for name, raw, _ in cases[1:]:
            with self.subTest(name=name):
                self.assertNotEqual(raw, model["signed"])
        self.assertEqual([name for name, _, _ in cases][0], "ledger_exact_htlc_refund")

    def test_bad_hash_bad_script_bad_profile_bad_low_s_claim_refuses(self):
        for key, value in [
            ("signed_transaction_sha256", "0"*64),
            ("script_pubkey_hex", "a914" + "00"*20 + "87"),
            ("expected_native_flags", 0),
            ("reviewed_network_in_firmware", "dogecoin-regtest"),
            ("signature_low_s", False),
            ("hardware_qualified", True),
        ]:
            with self.subTest(key=key):
                report = public_fake_report()
                report["native_consensus_candidate"][key] = value
                with self.assertRaises(ValueError):
                    n.require_report(report)

    def test_forged_hardware_or_funds_rejected(self):
        for key, value in [
            ("hardware_device_present", True),
            ("D8_status", "PASS"),
            ("real_doge_used", 1),
            ("native_consensus_cltv_verified_for_this_signature", True),
        ]:
            with self.subTest(key=key):
                report = public_fake_report()
                report[key] = value
                with self.assertRaises(ValueError):
                    n.require_report(report)


if __name__ == "__main__":
    unittest.main()
