"""Tests for D8 software-only evidence classification: never a hardware approval."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "doge_d8_gate", Path(__file__).with_name("d8_prephysical_gate.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


def fixtures():
    src = {
        "pinned_commit": g.PINNED_LEDGER_SOURCE,
        "doge_mainnet_p2pkh_p2sh_source_defined": True,
        "doge_regtest_full_htlc_cltv_approval_and_display_qualified": False,
        "H8_1_to_H8_5_complete": False,
        "D8_status": "BLOCKED",
        "no_real_funds": True,
        "no_mainnet_network_use": True,
    }
    apdu = {
        "scope": "NON_SIGNING_APDU_EMULATOR_IDENTITY_ONLY",
        "D8_hardware_status": "BLOCKED",
        "doge_regtest_htlc_signing_verified": False,
        "real_device_display_verified": False,
        "funds_used": 0, "broadcast_count": 0,
        "coin": {"coin": "DOGE", "network_in_app": "dogecoin-mainnet",
                 "p2pkh_prefix": 30, "p2sh_prefix": 22},
        "public_wallet_probe": {"pubkey_matches_address": True, "ownership_verified": False},
    }
    em = {
        "scope": "EMULATOR_BOOT_AND_NON_SIGNING_APDU_ONLY",
        "firmware_elf_built": True,
        "speculos_doge_app_booted": True,
        "emulated_screen_captured": True,
        "real_physical_screen_tested": False,
        "hardware_D8_qualified": False,
        "non_signing_apdu_identity_passed": True, "apdu_report": apdu,
    }
    screen = {
        "emulator_approval_automated": True,
        "screen_amount_observed": True, "screen_exact_destination_verified": True,
        "screen_fee_observed": True,
    }
    cl = {
        "scope": "SYNTHETIC_LEDGER_DOGE_MAINNET_P2PKH_EMULATOR_ONLY",
        "signature_on_synthetic_transaction_verified": True,
        "D8": "BLOCKED", "real_DOGE_used": 0, "broadcasts": 0,
        "mutated_transaction_signature_rejected": True,
        "simulated_screen_review": copy.deepcopy(screen),
    }
    h = {
        "scope": "SYNTHETIC_HTLC_REFUND_DIGEST_SIGNED_IN_MAINNET_DOGE_APP_ONLY",
        "signature_on_synthetic_htlc_refund_digest_verified": True,
        "D8_status": "BLOCKED", "real_doge_used": 0, "broadcasts": 0,
        "emulator_screen": copy.deepcopy(screen),
        "redeem_matches_gpubnb_d2_shape": True,
        "contract_lock_height": 1351, "contract_sequence": 4294967294,
        "ledger_app_network": "DOGE_MAINNET_PARAMETERS",
        "independent_on_device_htlc_terms_displayed": False,
        "dogecoin_regtest_network_authenticated": False,
        "native_consensus_cltv_verified_for_this_signature": False,
        "hardware_device_present": False,
        "screen_htlc_terms_observed": {field: False for field in g.SCREEN_FIELDS},
        "missing_htlc_fields": list(g.SCREEN_FIELDS),
    }
    for key in g.DIGEST_NEGATIVE_CHECKS:
        h[key] = True
    return [src, em, cl, h]


class PrePhysicalGateTests(unittest.TestCase):
    def test_good_emulated_evidence_only_reports_blocked_hardware(self):
        result = g.evaluate(*fixtures())
        self.assertTrue(result["publicIdentityAndDigestMutationChecksPassed"])
        self.assertFalse(result["physicalQualificationPassed"])
        self.assertFalse(result["deviceApprovedToSignGPUbnbContracts"])
        self.assertFalse(result["automaticMainnetActivationAllowed"])
        self.assertEqual(result["h8TestCasesCompleted"], [])
        self.assertEqual(len(result["incompleteTerms"]), 6)

    def test_rejects_forged_hardware_and_firmware_attestation(self):
        for index, path, value in [
            (0, "D8_status", "PASS"),
            (0, "H8_1_to_H8_5_complete", True),
            (0, "pinned_commit", "0"*40),
            (1, "real_physical_screen_tested", True),
            (1, "hardware_D8_qualified", True),
            (2, "D8", "PASS"),
            (3, "hardware_device_present", True),
            (3, "independent_on_device_htlc_terms_displayed", True),
            (3, "dogecoin_regtest_network_authenticated", True),
            (3, "native_consensus_cltv_verified_for_this_signature", True),
        ]:
            with self.subTest(index=index, path=path):
                f = fixtures()
                f[index][path] = value
                with self.assertRaises(g.EvidenceError):
                    g.evaluate(*f)

    def test_rejects_mismatched_address_and_signature_claims(self):
        for idx, key, value in [
            (1, "speculos_doge_app_booted", False),
            (2, "signature_on_synthetic_transaction_verified", False),
            (3, "signature_on_synthetic_htlc_refund_digest_verified", False),
            (3, "mutated_refund_lock_rejected", False),
            (3, "mutated_funding_outpoint_signature_invalid", False),
            (3, "mutated_sighash_trailer_signature_invalid", False),
            (3, "broadcasts", 1),
            (3, "real_doge_used", 1),
        ]:
            with self.subTest(index=idx, field=key):
                f = fixtures()
                f[idx][key] = value
                with self.assertRaises(g.EvidenceError):
                    g.evaluate(*f)
        for idx, field in [(2, "simulated_screen_review"), (3, "emulator_screen")]:
            f = fixtures()
            f[idx][field]["screen_exact_destination_verified"] = False
            with self.assertRaises(g.EvidenceError):
                g.evaluate(*f)

    def test_rejects_missing_or_forged_term_inventory(self):
        f = fixtures()
        f[3]["missing_htlc_fields"] = []
        with self.assertRaises(g.EvidenceError):
            g.evaluate(*f)
        f = fixtures()
        f[3]["screen_htlc_terms_observed"]["cltv_lock_1351"] = True
        with self.assertRaises(g.EvidenceError):
            g.evaluate(*f)
        f = fixtures()
        f[3]["screen_htlc_terms_observed"] = {key: True for key in g.SCREEN_FIELDS}
        f[3]["missing_htlc_fields"] = []
        with self.assertRaises(g.EvidenceError):
            g.evaluate(*f)

    def test_rejects_incomplete_or_promoted_source(self):
        f = fixtures()
        del f[0]["pinned_commit"]
        with self.assertRaises(g.EvidenceError):
            g.evaluate(*f)
        f = fixtures()
        f[1]["apdu_report"]["coin"]["network_in_app"] = "dogecoin-regtest"
        with self.assertRaises(g.EvidenceError):
            g.evaluate(*f)


if __name__ == "__main__":
    unittest.main()
