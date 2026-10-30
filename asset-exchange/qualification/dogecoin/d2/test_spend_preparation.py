import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from htlc_codec import decode_htlc
from spend_preparation import (GENESIS, MAX_MONEY, prepare_spend_pair, check_intent,
    validate_terms, require_standard_model, fee_rate_model, assess_prepared_intent, stable_hash)


def fixture():
    return json.loads((Path(__file__).parent / "fixtures/spend_terms_v1.json").read_text())["terms"]


class SpendPreparationTests(unittest.TestCase):
    def test_hash_bounds_dictionary_keys_before_serialization(self):
        with patch('spend_preparation.json.dumps', side_effect=AssertionError('encoder reached')), self.assertRaises(ValueError):
            stable_hash({'x'*129: 0})

    def test_hash_bounds_aggregate_expansion_before_serialization(self):
        shared = 0
        for _ in range(8):
            shared = [shared]*4
        with patch('spend_preparation.json.dumps', side_effect=AssertionError('encoder reached')), self.assertRaises(ValueError):
            stable_hash(shared)

    def test_hash_bounds_total_text_before_serialization(self):
        with patch('spend_preparation.json.dumps', side_effect=AssertionError('encoder reached')), self.assertRaises(ValueError):
            stable_hash(['a'*4096]*9)

    def test_hash_bounds_json_unicode_escape_expansion(self):
        with self.assertRaisesRegex(ValueError, 'encoded intent byte'):
            stable_hash(['\uffff'*4096]*4)

    def test_normal_intent_and_terms_digests_preserve_published_vectors(self):
        root=Path(__file__).resolve().parents[4]
        old=json.loads((root/'docs/asset-exchange/research/2026-10-30/evidence/increment-b/request-only.json').read_text())
        self.assertEqual(stable_hash(self.terms),old['termsDigest'])
        for branch,value in self.pair.items():
            self.assertEqual(stable_hash(value),old['intentDigests'][branch])

    def setUp(self):
        self.terms=fixture()
        self.pair=prepare_spend_pair(self.terms)
        self.context={"kind":"SYNTHETIC_MODEL","network":"regtest","genesis":GENESIS,
            "tipHeight":1351,"nextBlockHeight":1352,"medianTimePast":1_700_000_000,
            "candidateBlockTime":1_700_000_010,"csvActive":False,"bip65Enforced":True}
        self.policy={"acceptNonstandard":False,"promiscuousMempoolFlags":None,
            "hardDustKoinu":"100000","softDustKoinu":"1000000","relayRateKoinuPerKB":"100000",
            "mempoolFeeFloorKoinu":"0","maximumFeeKoinu":"2000000"}
        self.utxo={"kind":"SYNTHETIC_MODEL","outpoint":dict(self.terms["outpoint"]),
            "valueKoinu":self.terms["inputValueKoinu"],"scriptPubKeyHex":decode_htlc(bytes.fromhex(self.terms["redeemHex"])).output.hex(),
            "availability":"AVAILABLE","coinbaseMature":True}

    def assess(self,branch="REFUND"):
        return assess_prepared_intent(self.terms,self.pair[branch],self.context,self.policy,self.utxo)

    def test_pair_uses_same_utxo_and_separate_roles_destinations(self):
        a,b=self.pair["CLAIM"],self.pair["REFUND"]
        self.assertEqual(a["outpoint"],b["outpoint"])
        self.assertNotEqual(a["participantPublicHex"],b["participantPublicHex"])
        self.assertNotEqual(a["output"]["scriptPubKeyHex"],b["output"]["scriptPubKeyHex"])
        self.assertEqual(a["lockTime"],0);self.assertEqual(b["lockTime"],1351)
        for intent in self.pair.values():
            self.assertIsNone(intent["transactionBytes"])
            self.assertFalse(intent["signatureVerified"])
            self.assertEqual(intent["executableOperations"],[])
            self.assertEqual(int(intent["output"]["valueKoinu"])+int(intent["feeKoinu"]),int(intent["inputValueKoinu"]))

    def test_each_intent_mutation_rejects_frozen_terms(self):
        mutations=[("participantPublicHex",self.terms["claimPublicHex"]),("inputValueKoinu","499999999"),
                   ("feeKoinu","1000001"),("lockTime",1350),("sequence",0xFFFFFFFF),
                   ("signatureVerified",True),("version",True),("schemaVersion",True),
                   ("transactionBytes","00"),("redeemHex","51"),("network","main"),("genesis","0"*64)]
        for key,value in mutations:
            intent=copy.deepcopy(self.pair["REFUND"]);intent[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):check_intent(self.terms,intent)
        for field,value in [("outpoint",{"txid":"b"*64,"vout":0}),
            ("output",{"valueKoinu":"499000001","scriptPubKeyHex":self.terms["refundDestinationHex"]})]:
            intent=copy.deepcopy(self.pair["REFUND"]);intent[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):check_intent(self.terms,intent)

    def test_invalid_amounts_units_and_unknown_fields_reject(self):
        for value in ["-1","01","1.0","1e8",str(MAX_MONEY+1),True,1.0]:
            terms=copy.deepcopy(self.terms);terms["inputValueKoinu"]=value
            with self.subTest(value=value),self.assertRaises(ValueError):validate_terms(terms)
        terms=copy.deepcopy(self.terms);terms["signature"]="synthetic"
        with self.assertRaises(ValueError):validate_terms(terms)

    def test_wrong_network_source_or_null_outpoint_reject(self):
        for key,value in [("network","main"),("genesis","a"*64),("sourceCommit","b"*40),
                          ("outpoint",{"txid":"0"*64,"vout":0xFFFFFFFF})]:
            terms=copy.deepcopy(self.terms);terms[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate_terms(terms)

    def test_fee_underflow_zero_and_unspendable_destination_reject(self):
        for value in ["0",self.terms["inputValueKoinu"],str(int(self.terms["inputValueKoinu"])+1)]:
            terms=copy.deepcopy(self.terms);terms["refundFeeKoinu"]=value
            with self.subTest(value=value),self.assertRaises(ValueError):prepare_spend_pair(terms)
        terms=copy.deepcopy(self.terms);terms["refundDestinationHex"]="6a"
        with self.assertRaises(ValueError):prepare_spend_pair(terms)

    def test_require_standard_defaults_and_explicit_override(self):
        self.assertTrue(require_standard_model("main"))
        self.assertFalse(require_standard_model("regtest"))
        self.assertFalse(require_standard_model("test"))
        self.assertTrue(require_standard_model("regtest",False))
        with self.assertRaises(ValueError):require_standard_model("main",True)
        with self.assertRaises(ValueError):require_standard_model("regtest",0)

    def test_promiscuous_flags_can_undermine_even_required_standardness(self):
        self.policy["promiscuousMempoolFlags"]=0
        reasons=[r["reason"] for r in self.assess()["blockers"]]
        self.assertIn("SCRIPT_FLAGS_OVERRIDE",reasons)
        self.policy["acceptNonstandard"]=None
        self.assertIn("STANDARDNESS_NOT_REQUIRED",[r["reason"] for r in self.assess()["blockers"]])

    def test_finality_before_equal_after_and_activation(self):
        self.context.update(tipHeight=1349,nextBlockHeight=1350,bip65Enforced=False)
        self.assertFalse(self.assess()["mempoolFinalityModel"])
        self.context.update(tipHeight=1350,nextBlockHeight=1351,bip65Enforced=True)
        self.assertFalse(self.assess()["mempoolFinalityModel"])
        self.context.update(tipHeight=1351,nextBlockHeight=1352)
        self.assertTrue(self.assess()["mempoolFinalityModel"])

    def test_wrong_block_context_and_activation_reject(self):
        self.context["nextBlockHeight"]=1351
        with self.assertRaises(ValueError):self.assess()
        self.context["nextBlockHeight"]=1352;self.context["bip65Enforced"]=False
        with self.assertRaises(ValueError):self.assess()

    def test_mempool_mtp_and_block_time_are_not_equated_before_csv(self):
        terms=copy.deepcopy(self.terms);terms["lockTime"]=500_000_000
        from offline_candidate import build_candidate
        terms["redeemHex"]=build_candidate(bytes.fromhex(terms["commitmentHex"]),bytes.fromhex(terms["claimPublicHex"]),bytes.fromhex(terms["refundPublicHex"]),terms["lockTime"]).redeem.hex()
        self.terms=terms;self.pair=prepare_spend_pair(terms)
        self.utxo["scriptPubKeyHex"]=validate_terms(terms).output.hex()
        self.context.update(medianTimePast=500_000_000,candidateBlockTime=500_000_001,csvActive=False)
        result=self.assess();self.assertFalse(result["mempoolFinalityModel"]);self.assertTrue(result["blockFinalityModel"])
        self.context["csvActive"]=True
        self.assertFalse(self.assess()["blockFinalityModel"])

    def test_utxo_missing_spent_conflict_and_maturity_block(self):
        for status in ["MISSING","SPENT","MEMPOOL_CONFLICT"]:
            self.utxo["availability"]=status
            self.assertIn(status,[r["reason"] for r in self.assess()["blockers"]])
        self.utxo["availability"]="AVAILABLE";self.utxo["coinbaseMature"]=False
        self.assertIn("IMMATURE_COINBASE_OR_UNKNOWN",[r["reason"] for r in self.assess()["blockers"]])

    def test_utxo_outpoint_amount_and_script_mismatch_reject(self):
        for key,value in [("outpoint",{"txid":"a"*64,"vout":1}),("valueKoinu","500000001"),("scriptPubKeyHex","51")]:
            saved=self.utxo[key];self.utxo[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.assess()
            self.utxo[key]=saved

    def test_native_fee_arithmetic_is_floor_not_ceiling(self):
        self.assertEqual(fee_rate_model("11",101),1)
        self.assertEqual(fee_rate_model("1",1),1)
        self.assertEqual(fee_rate_model("100000",1000),100000)
        self.assertEqual(fee_rate_model("0",1000),0)
        with self.assertRaises(ValueError):fee_rate_model(str(MAX_MONEY),100000)

    def test_dust_fee_floor_and_user_cap_block_independently(self):
        for key,value,reason in [("hardDustKoinu","500000000","HARD_DUST"),
                                ("mempoolFeeFloorKoinu","1000001","DYNAMIC_MEMPOOL_FEE_FLOOR"),
                                ("maximumFeeKoinu","999999","EXCESSIVE_FEE")]:
            old=self.policy[key];self.policy[key]=value
            if key=="hardDustKoinu":self.policy["softDustKoinu"]=value
            with self.subTest(key=key):self.assertIn(reason,[r["reason"] for r in self.assess()["blockers"]])
            self.policy[key]=old;self.policy["softDustKoinu"]="1000000"

    def test_no_positive_assessment_claims_native_or_financial_success(self):
        result=self.assess()
        self.assertEqual(result["status"],"MODEL_REQUIREMENTS_ONLY")
        self.assertEqual(result["qualificationStatus"],"BLOCKED")
        self.assertEqual(result["executableOperations"],[])
        self.assertFalse(result["signatureVerified"])
        self.assertFalse(result["utxoFactsVerified"])
        self.assertFalse(result["rpcFreeLimiterEnforced"])
        for key in ["nativeConsensus","nativeStandardness","nativeMempool"]:self.assertEqual(result[key],"NOT TESTED")


if __name__ == "__main__":
    unittest.main()
