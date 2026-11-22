"""Adversarial tests for a PUBLIC, non-executable LTC recovery *inventory*.

No secret, private key, signer, wallet, network or real transaction.
"""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import candidate_htlc as h
import public_recovery_inventory as inv

REQUEST = json.loads(
    (Path(__file__).with_name("fixtures") / "transparent_request_v1.json").read_text()
)
SCRIPT = h.build_synthetic_htlc_script(
    bytes.fromhex("a1" * 32),
    bytes.fromhex("02" + "11" * 32),
    bytes.fromhex("03" + "22" * 32),
    450,
)


def fixture():
    return copy.deepcopy(REQUEST)


def manifest():
    return inv.make_synthetic_inventory(fixture(), SCRIPT)


def review(value, *, request=None, script=SCRIPT):
    return inv.inspect_synthetic_inventory(fixture() if request is None else request,
                                           script, value)


class PublicRecoveryInventoryTests(unittest.TestCase):
    def denied(self, altered, request=None, script=SCRIPT):
        with self.assertRaises(inv.InventoryRefused):
            review(altered, request=request, script=script)

    def test_consistent_public_inventory_accepted_as_shape_only(self):
        self.assertEqual(review(manifest())["classification"],
                         "PUBLIC_SYNTHETIC_INVENTORY_CONSISTENT_ONLY")

    def test_reviewer_hash_is_stable(self):
        self.assertEqual(review(manifest())["inventorySha256"],
                         review(manifest())["inventorySha256"])

    def test_json_key_order_does_not_change_inventory_hash(self):
        original = manifest()
        shuffled = dict(reversed(list(original.items())))
        self.assertEqual(review(original)["inventorySha256"],
                         review(shuffled)["inventorySha256"])

    def test_inventory_pins_source_commit_and_genesis(self):
        m = manifest()
        self.assertEqual(m["source"]["sourceCommit"], inv.SOURCE_COMMIT)
        self.assertEqual(m["source"]["genesis"], inv.GENESIS)

    def test_inventory_matches_public_script_hash(self):
        m = manifest()
        self.assertEqual(m["candidateP2wshScriptPubKeyHex"],
                         h.inspect_synthetic_htlc_script(SCRIPT)["p2wshScriptPubKeyHex"])

    def test_inventory_matches_fixture_public_request_digest(self):
        from offline_preflight import validate_request
        self.assertEqual(m := manifest()["requestSha256"],
                         validate_request(fixture())["requestSha256"])

    def test_never_grants_recovery_or_financial_permission(self):
        for flag in ["provenanceAuthenticated", "nativeRecoveryVerified",
                     "independentRecoveryAvailable", "qualified", "canRecover",
                     "canSign", "canBroadcast", "automaticSettlementSupported"]:
            self.assertIs(review(manifest())[flag], False, flag)

    def test_no_transaction_or_secret_material_present(self):
        m = manifest()
        flat = json.dumps(m).lower()
        for key in ["privatekey", "seedphrase", "signaturehex", "signedtransaction",
                    "rawtransaction", "walletpassword", "signercredential"]:
            self.assertNotIn(key, flat)
        self.assertEqual(m["kind"], "PUBLIC_SYNTHETIC_INVENTORY_NOT_A_RECOVERY_BUNDLE")

    def test_mutated_source_commit_denied(self):
        m = manifest()
        m["source"]["sourceCommit"] = "00" * 20
        self.denied(m)

    def test_mutated_genesis_denied(self):
        m = manifest()
        m["source"]["genesis"] = "00" * 32
        self.denied(m)

    def test_wrong_asset_chain_or_network_denied(self):
        for field, bad in [("asset", "DOGE"), ("chainId", "bitcoin"),
                           ("network", "mainnet"), ("protocolVersion", "btc")]:
            with self.subTest(field=field):
                m = manifest()
                m[field] = bad
                self.denied(m)

    def test_mweb_field_injection_denied(self):
        m = manifest()
        m["mwebPegOut"] = False
        self.denied(m)

    def test_private_field_injection_denied(self):
        for key in ["seed", "privateKey", "walletPassword", "signedRefund"]:
            with self.subTest(key=key):
                m = manifest()
                m[key] = "FORBIDDEN_FIELD_NOT_REAL_SECRET"
                self.denied(m)

    def test_missing_field_denied(self):
        for field in ["domain", "candidateScriptHex", "refundDestinationScriptHex",
                      "syntheticOutpoint", "permissions"]:
            with self.subTest(field=field):
                m = manifest()
                del m[field]
                self.denied(m)

    def test_permissions_cannot_be_escalated(self):
        for field in manifest()["permissions"]:
            with self.subTest(field=field):
                m = manifest()
                m["permissions"][field] = True
                self.denied(m)

    def test_boolean_impostors_denied(self):
        m = manifest()
        m["permissions"]["canSign"] = 0
        self.denied(m)

    def test_modified_public_script_denied(self):
        m = manifest()
        m["candidateScriptHex"] = "00" + m["candidateScriptHex"][2:]
        self.denied(m)

    def test_modified_witness_program_denied(self):
        m = manifest()
        m["candidateP2wshScriptPubKeyHex"] = "0020" + "00" * 32
        self.denied(m)

    def test_modified_refund_destination_denied(self):
        m = manifest()
        m["refundDestinationScriptHex"] = "0014" + "22" * 20
        self.denied(m)

    def test_modified_public_amounts_denied(self):
        for field in ["inputLitoshi", "feeLitoshi", "refundLitoshi"]:
            with self.subTest(field=field):
                m = manifest()
                m["syntheticAmounts"][field] = "1"
                self.denied(m)

    def test_modified_outpoint_denied(self):
        for field, replacement in [("fundingTxid", "11"*32), ("fundingVout", 1)]:
            with self.subTest(field=field):
                m = manifest()
                m["syntheticOutpoint"][field] = replacement
                self.denied(m)

    def test_modified_height_denied(self):
        m = manifest()
        m["refundHeight"] = 451
        self.denied(m)

    def test_script_and_request_height_mismatch_denied(self):
        request = fixture()
        request["review"]["refundLockHeight"] = 451
        with self.assertRaises(inv.InventoryRefused):
            inv.make_synthetic_inventory(request, SCRIPT)

    def test_changing_source_request_without_manifest_update_denied(self):
        m = manifest()
        request = fixture()
        request["review"]["fundingVout"] = 1
        self.denied(m, request=request)

    def test_wrong_script_bytes_denied(self):
        with self.assertRaises(inv.InventoryRefused):
            inv.make_synthetic_inventory(fixture(), b"\x00")

    def test_malformed_request_denied(self):
        request = fixture()
        request["privacy"]["mwebInput"] = True
        with self.assertRaises(inv.InventoryRefused):
            inv.make_synthetic_inventory(request, SCRIPT)

    def test_bad_inventory_type_denied(self):
        for bad in [None, [], "", 1, False]:
            with self.subTest(type=type(bad).__name__):
                self.denied(bad)

    def test_unserializable_nan_and_oversize_denied(self):
        for field, value in [("source", float("nan")), ("source", bytes(3)),
                             ("extra", "x"*10000)]:
            with self.subTest(field=field, value=type(value).__name__):
                m = manifest()
                m[field] = value
                self.denied(m)

    def test_no_file_io_in_builder_or_reviewer(self):
        base_request = fixture()
        with patch("builtins.open", side_effect=AssertionError("I/O forbidden")):
            m = inv.make_synthetic_inventory(base_request, SCRIPT)
            self.assertEqual(inv.inspect_synthetic_inventory(base_request, SCRIPT, m)
                             ["canRecover"], False)


if __name__ == "__main__":
    unittest.main()
