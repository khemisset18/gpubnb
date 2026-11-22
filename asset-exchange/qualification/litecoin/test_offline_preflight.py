"""Non-executable Litecoin lab refusal tests. Standard-library only, no keys."""

import copy
import hashlib
import json
from pathlib import Path
import unittest

import offline_preflight as p

FIXTURE = Path(__file__).with_name("fixtures") / "transparent_request_v1.json"
FIXTURE_SHA256 = "298e2e4ec740a23f7ce0bd3f0d28aa44b6ddad61939ae3966fc7d6c73ead75ec"


class LitecoinOfflinePreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = FIXTURE.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == FIXTURE_SHA256, "fixture changed"
        cls.reference = p.parse_request(raw)

    def bad(self, update, reason=None):
        value = copy.deepcopy(self.reference)
        update(value)
        with self.assertRaises(p.Refused) as result:
            p.validate_request(value)
        if reason is not None:
            self.assertIn(reason, str(result.exception))

    def test_original_public_fixture_accepted(self):
        self.assertIsInstance(p.validate_request(self.reference)["requestSha256"], str)

    def test_pass_never_grants_financial_permission(self):
        result = p.validate_request(self.reference)
        self.assertEqual(result["classification"], "SOFTWARE_REQUEST_PREFLIGHT_PASS_HARDWARE_BLOCKED")
        for name in ["qualified", "networkIdentityVerified", "nativeConsensusVerified",
                     "sourceAuthenticityVerified", "canSign", "canBroadcast",
                     "hardwareQualified", "automaticSettlementSupported", "realFundsUsed"]:
            self.assertIs(result[name], False)

    def test_canonical_digest_deterministic_independent_of_json_key_order(self):
        digest = p.validate_request(self.reference)["requestSha256"]
        reversed_keys = dict(reversed(list(self.reference.items())))
        self.assertEqual(p.validate_request(reversed_keys)["requestSha256"], digest)
        self.assertEqual(len(digest), 64)

    def test_wrong_chain_denied(self):
        for val in ["bitcoin", "dogecoin", "litecoin ", "LTC", None]:
            with self.subTest(val=val): self.bad(lambda d: d.__setitem__("chainId", val))

    def test_non_regtest_network_denied(self):
        for val in ["main", "mainnet", "testnet", "signet", "regtest ", None]:
            with self.subTest(val=val): self.bad(lambda d: d.__setitem__("network", val))

    def test_wrong_asset_denied(self):
        self.bad(lambda d: d.__setitem__("asset", "DOGE"))

    def test_wrong_protocol_denied(self):
        self.bad(lambda d: d.__setitem__("protocolVersion", "DOGE_SCRIPT_SETTLEMENT_V1"))

    def test_domain_separation_denied(self):
        self.bad(lambda d: d.__setitem__("domain", "GPUbnb:BTC:OFFLINE_LAB_REVIEW:v1"))

    def test_real_execution_kind_denied(self):
        self.bad(lambda d: d.__setitem__("kind", "FUND_AND_SIGN"))

    def test_schema_version_type_and_value_denied(self):
        for val in [True, 1.0, "1", 2, 0]:
            with self.subTest(val=val): self.bad(lambda d: d.__setitem__("schemaVersion", val))

    def test_extra_qualified_or_transaction_field_denied(self):
        for key in ["qualified", "signature", "transactionHex", "privateKey", "mweb", "rpcUrl"]:
            with self.subTest(key=key): self.bad(lambda d: d.__setitem__(key, True))

    def test_missing_field_denied(self):
        self.bad(lambda d: d.pop("privacy"))

    def test_missing_nested_field_denied(self):
        self.bad(lambda d: d["review"].pop("feeLitoshi"))

    def test_extra_nested_field_denied(self):
        self.bad(lambda d: d["review"].__setitem__("changeAddress", "mweb"))

    def test_mweb_every_route_denied(self):
        for key in sorted(p.PRIVACY_KEYS):
            with self.subTest(key=key): self.bad(lambda d: d["privacy"].__setitem__(key, True))

    def test_mweb_boolean_impostors_denied(self):
        for val in [0, 1, "false", None, [], {}]:
            with self.subTest(val=val): self.bad(lambda d: d["privacy"].__setitem__("mwebInput", val))

    def test_mweb_missing_and_unknown_modes_denied(self):
        self.bad(lambda d: d["privacy"].pop("mwebPegOut"))
        self.bad(lambda d: d["privacy"].__setitem__("mwebAutoConvert", False))

    def test_each_financial_permission_denied(self):
        for name in sorted(p.PERMISSION_KEYS):
            with self.subTest(name=name): self.bad(lambda d: d["permissions"].__setitem__(name, True))

    def test_permission_boolean_impostors_denied(self):
        for val in [0, "false", None, 0.0]:
            with self.subTest(val=val): self.bad(lambda d: d["permissions"].__setitem__("canBroadcast", val))

    def test_missing_or_extra_permission_denied(self):
        self.bad(lambda d: d["permissions"].pop("canSign"))
        self.bad(lambda d: d["permissions"].__setitem__("allowMainnet", False))

    def test_invalid_amount_types_and_formats_denied(self):
        for val in [0, True, 100, 1.0, "", "0", "01", "1.0", "1e8", "-1", "+1", " 1", "１", "9" * 100]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("inputLitoshi", val))

    def test_input_outside_conservative_range_denied(self):
        self.bad(lambda d: d["review"].__setitem__("inputLitoshi", str(p.MAX_LITOSHI+1)))

    def test_fee_greater_than_or_equal_input_denied(self):
        for fee in ["100000000", "100000001"]:
            with self.subTest(fee=fee): self.bad(lambda d: d["review"].__setitem__("feeLitoshi", fee))

    def test_refund_arithmetic_mutation_denied(self):
        self.bad(lambda d: d["review"].__setitem__("refundLitoshi", "99899999"), "arithmetic")

    def test_maximum_fee_cap_mutation_denied(self):
        self.bad(lambda d: d["review"].__setitem__("maximumFeeLitoshi", "99999"), "budget")

    def test_minimum_refund_mutation_denied(self):
        self.bad(lambda d: d["review"].__setitem__("minimumRefundLitoshi", "99900001"), "budget")

    def test_maximum_fee_cannot_consume_all_input(self):
        self.bad(lambda d: d["review"].__setitem__("maximumFeeLitoshi", "100000000"), "budget")

    def test_height_domain_bools_floats_and_time_denied(self):
        for val in [-1, 0, 500000000, True, 450.0, "450", None]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("refundLockHeight", val))

    def test_sequence_mutations_denied(self):
        for val in [0xffffffff, 0xfffffffd, 0, True, "4294967294"]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("sequence", val))

    def test_alternate_sighash_modes_denied(self):
        for val in ["NONE", "SINGLE", "ALL|ANYONECANPAY", "DEFAULT", 1, None]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("sighash", val))

    def test_wrong_refund_destination_shape_denied(self):
        for val in ["", "0014", "6a", "0014" + "00" * 20, "0020" + "11" * 32,
                    "0014" + "GG" * 20, "0014" + "AA" * 20]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("refundDestinationScriptHex", val))

    def test_funding_txid_malformed_null_or_changed_type_denied(self):
        for val in ["", "0"*64, "AB"*32, "aa"*33, True]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("fundingTxid", val))

    def test_funding_vout_malformed_denied(self):
        for val in [-1, 0xffffffff, True, 0.0, "0", None]:
            with self.subTest(val=val): self.bad(lambda d: d["review"].__setitem__("fundingVout", val))

    def test_duplicate_json_field_refused(self):
        raw = FIXTURE.read_text().replace('"asset": "LTC",', '"asset": "LTC", "asset": "DOGE",')
        with self.assertRaisesRegex(p.Refused, "duplicate"): p.parse_request(raw.encode())

    def test_duplicate_nested_field_refused(self):
        raw = FIXTURE.read_text().replace('"inputLitoshi": "100000000",', '"inputLitoshi": "100000000", "inputLitoshi": "900",')
        with self.assertRaisesRegex(p.Refused, "duplicate"): p.parse_request(raw.encode())

    def test_invalid_json_utf8_and_nonfinite_denied(self):
        for raw in [b"{", b"\xff", b"NaN", b"Infinity", b"[]", b"null"]:
            with self.subTest(raw=raw), self.assertRaises(p.Refused): p.parse_request(raw)

    def test_oversize_or_non_bytes_json_denied(self):
        for raw in [b"", b" " * (p.MAX_JSON_BYTES + 1), "{}", None, bytearray(b"{}")]:
            with self.subTest(kind=str(type(raw))), self.assertRaises(p.Refused): p.parse_request(raw)

    def test_review_does_not_suggest_network_identity_or_consensus(self):
        result = p.validate_request(self.reference)
        self.assertIs(result["networkIdentityVerified"], False)
        self.assertIs(result["nativeConsensusVerified"], False)
        self.assertIs(result["sourceAuthenticityVerified"], False)

    def test_fixture_sha256_is_pinned_public_only(self):
        self.assertEqual(hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), FIXTURE_SHA256)
        self.assertNotIn("PRIVATE KEY", FIXTURE.read_text())


if __name__ == "__main__":
    unittest.main()
