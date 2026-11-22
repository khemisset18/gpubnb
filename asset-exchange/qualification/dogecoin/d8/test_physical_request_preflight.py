"""Public-fixture proof of D8 request preflight and all mutation refusals.

No private keys, no hardware, no RPC, no signature.
"""
import copy
import hashlib
import importlib.util
from pathlib import Path
import os
import stat
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("d8_request_preflight", HERE / "physical_request_preflight.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def public_only_fixture():
    asset = HERE.parents[2]
    import json
    source = asset / "qualification/dogecoin/d2/fixtures/htlc_codec_v1.json"
    public = json.loads(source.read_text())
    template = public["templates"][1]
    contract = {"redeemHex": template["redeemHex"], "outputHex": template["outputHex"]}
    funding = p.policy.transaction("01" * 32, 0, b"\x51",
                                   [(10_000_000_000, bytes.fromhex(template["outputHex"]))])
    return p.policy.create_refund_signing_request(
        contract=contract,
        funding={"txid": p.policy.txid(funding), "vout": 0,
                 "valueKoinu": "10000000000", "transactionHex": funding.hex()},
        policy={"maxFeeKoinu": "100000000", "minRefundKoinu": "9900000000"},
        destination_hex="76a914" + "11" * 20 + "88ac",
        fees=["1000000", "10000000", "100000000"],
        request_id="d8_public_only_preflight_fixture",
        created_at_height=1352, request_expires_at_height=1360)


def inspect(request, height=1353):
    return p.evaluate(request,
        independently_retained_terms_digest=request["termsDigest"],
        independently_retained_request_digest=request["requestDigest"],
        observed_regtest_height=height)


class D8PreflightTests(unittest.TestCase):
    def test_17_mutations_fail_before_any_signature_and_hardware_claim_is_blocked(self):
        request = public_only_fixture()
        result = inspect(request)
        self.assertEqual(result["refusalChecksCompleted"], 17)
        self.assertEqual(tuple(result["policyRefusalsBeforeSigning"]), p.MUTATION_NAMES)
        self.assertEqual(result["stage"], "DOGE_D8_REQUEST_SOFTWARE_PREFLIGHT_ONLY")
        self.assertFalse(result["canSign"])
        self.assertFalse(result["hardwareQualified"])
        self.assertFalse(result["deviceDisplayVerified"])
        self.assertFalse(result["approvedForDOGEMainnet"])
        self.assertFalse(result["chainHeightSourceAuthenticated"])
        self.assertFalse(result["independentReceiptOriginAuthenticated"])
        self.assertEqual(result["publicReviewFieldsForComparisonOnly"]["lockTime"], 1351)
        self.assertEqual(result["publicReviewFieldsForComparisonOnly"]["network"], "regtest")
        self.assertEqual(len(result["publicReviewFieldsForComparisonOnly"]["steps"]), 3)
        self.assertEqual(result["realFundsUsed"], 0)
        self.assertEqual(result["broadcasts"], 0)

    def test_independently_retained_digest_mutations_refuse(self):
        request = public_only_fixture()
        for key in ("termsDigest", "requestDigest"):
            f = copy.deepcopy(request)
            f[key] = "0" * 64
            with self.subTest(key=key), self.assertRaises(ValueError):
                p.evaluate(f,
                    independently_retained_terms_digest=request["termsDigest"],
                    independently_retained_request_digest=request["requestDigest"],
                    observed_regtest_height=1353)

    def test_stale_request_or_wrong_tip_refuses(self):
        request = public_only_fixture()
        for height in (1351, 1360, 2000, True, -1):
            with self.subTest(height=height), self.assertRaises(ValueError):
                inspect(request, height=height)

    def test_every_negative_mutant_rejected_using_original_receipts(self):
        request = public_only_fixture()
        for kind in p.MUTATION_NAMES:
            altered = p.mutate(request, kind)
            with self.subTest(kind=kind), self.assertRaises((ValueError, TypeError, KeyError)):
                p.evaluate(altered,
                    independently_retained_terms_digest=request["termsDigest"],
                    independently_retained_request_digest=request["requestDigest"],
                    observed_regtest_height=1353)

    def test_untrusted_fields_unknown_schema_refuse(self):
        request = public_only_fixture()
        request["deviceBlessed"] = True
        with self.assertRaises(ValueError):
            inspect(request)

    def test_malformed_duplicate_and_symlink_inputs_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repeated = base / "duplicated.json"
            repeated.write_text('{"requestDigest":"x","requestDigest":"y"}')
            with self.assertRaises(ValueError):
                p.read_json(repeated)
            symlink = base / "alias.json"
            symlink.symlink_to(repeated)
            with self.assertRaises((ValueError, OSError)):
                p.read_json(symlink)

    def test_durable_output_is_new_private_file_without_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            name = Path(directory) / "preflight.json"
            result = inspect(public_only_fixture())
            p.emit_exclusive(name, result)
            self.assertEqual(stat.S_IMODE(name.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                p.emit_exclusive(name, result)
            self.assertIn('"hardwareQualified": false', name.read_text())


if __name__ == "__main__":
    unittest.main()
