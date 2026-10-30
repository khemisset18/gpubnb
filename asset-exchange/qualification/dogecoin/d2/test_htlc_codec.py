import hashlib
import json
from pathlib import Path
import unittest

from htlc_codec import bind_htlc, decode_htlc, review_branch, SEQUENCE
from offline_candidate import build_candidate

CLAIM = bytes.fromhex("038479a0fa998cd35259a2ef0a7a5c68662c1474f88ccb6d08a7677bbec7f22041")
REFUND = bytes.fromhex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
PUBLIC_INPUT = b"GPUbnb D2 public synthetic input"
HASH = hashlib.sha256(PUBLIC_INPUT).digest()


class HtlcCodecTests(unittest.TestCase):
    def setUp(self):
        self.candidate = build_candidate(HASH, CLAIM, REFUND, 1351)

    def bind(self, raw=None, **mutations):
        terms = dict(commitment=HASH, claim_public=CLAIM, refund_public=REFUND,
                     lock=1351, output=self.candidate.output)
        terms.update(mutations)
        return bind_htlc(self.candidate.redeem if raw is None else raw, **terms)

    def review(self, branch="CLAIM", **mutations):
        params = dict(branch=branch, public_key=CLAIM if branch == "CLAIM" else REFUND,
                      transaction_lock=0 if branch == "CLAIM" else 1351,
                      sequence=SEQUENCE, preimage=PUBLIC_INPUT if branch == "CLAIM" else None)
        params.update(mutations)
        return review_branch(self.candidate.redeem, **params)

    def test_literal_public_fixtures_roundtrip(self):
        raw_fixtures = (Path(__file__).parent / "fixtures/htlc_codec_v1.json").read_bytes()
        self.assertEqual(hashlib.sha256(raw_fixtures).hexdigest(),
                         "fb07d34447b89b7123654c52225763a42b2f347a8dad6393bb5111025dede9a4")
        records = json.loads(raw_fixtures)
        self.assertEqual(records["qualified"], False)
        for fixture in records["templates"]:
            with self.subTest(lock=fixture["lock"]):
                raw = bytes.fromhex(fixture["redeemHex"])
                parsed = decode_htlc(raw)
                self.assertEqual(parsed.commitment, HASH)
                self.assertEqual(parsed.claim_public, CLAIM)
                self.assertEqual(parsed.refund_public, REFUND)
                self.assertEqual(parsed.lock, fixture["lock"])
                self.assertEqual(parsed.output.hex(), fixture["outputHex"])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), fixture["redeemSha256"])
                self.assertEqual(build_candidate(HASH,CLAIM,REFUND,fixture["lock"]).redeem, raw)

    def test_all_truncations_reject(self):
        for length in range(len(self.candidate.redeem)):
            with self.subTest(length=length), self.assertRaises(ValueError):
                decode_htlc(self.candidate.redeem[:length])

    def test_every_byte_mutation_rejects_expected_terms(self):
        for index in range(len(self.candidate.redeem)):
            raw = bytearray(self.candidate.redeem)
            raw[index] ^= 1
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.bind(bytes(raw))

    def test_extra_bytes_and_non_bytes_reject(self):
        for raw in [self.candidate.redeem+b"\x51", b"\x51"+self.candidate.redeem,
                    b"x"*521, bytearray(self.candidate.redeem), None]:
            with self.subTest(raw_type=type(raw)), self.assertRaises(ValueError):
                decode_htlc(raw)

    def test_nonminimal_negative_zero_and_oversized_numbers_reject(self):
        before, after = self.candidate.redeem.split(bytes.fromhex("024705"))
        for number in [bytes.fromhex(v) for v in ["03470500","4c024705","024785","0100","00","5100","06ffffffff0000","05ffffffff01"]]:
            with self.subTest(number=number.hex()), self.assertRaises(ValueError):
                decode_htlc(before+number+after)

    def test_noncanonical_commitment_and_key_pushes_reject(self):
        for index in [6,40,81]:
            # A valid direct push replaced by PUSHDATA1 must not normalize away.
            raw=self.candidate.redeem[:index]+b"\x4c"+self.candidate.redeem[index:]
            with self.subTest(index=index), self.assertRaises(ValueError):
                decode_htlc(raw)

    def test_key_role_lock_hash_and_output_bindings_are_independent(self):
        for change in [dict(claim_public=REFUND,refund_public=CLAIM), dict(lock=1352),
                       dict(commitment=bytes(32)), dict(output=b"\x51")]:
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                self.bind(**change)
        self.assertEqual(self.bind().output,self.candidate.output)

    def test_claim_and_refund_layouts_remain_unsigned_and_blocked(self):
        for branch in ["CLAIM","REFUND"]:
            result=self.review(branch)
            self.assertEqual(result["qualificationStatus"],"BLOCKED")
            self.assertFalse(result["signatureVerified"])
            self.assertFalse(result["nativeVerified"])
            self.assertEqual(result["executableOperations"],[])
            self.assertIsNone(result["transactionBytes"])
            self.assertNotIn(PUBLIC_INPUT.hex(),json.dumps(result))
        self.assertEqual(self.review("REFUND")["stackLayout"],["SIGNATURE_REQUIRED","OP_0","REDEEM_SCRIPT"])

    def test_wrong_role_key_rejects_each_branch(self):
        for branch,key in [("CLAIM",REFUND),("REFUND",CLAIM)]:
            with self.subTest(branch=branch),self.assertRaises(ValueError):
                self.review(branch,public_key=key)

    def test_wrong_secret_length_digest_and_refund_disclosure_reject(self):
        for preimage in [b"",b"x"*31,b"x"*32,b"x"*33,PUBLIC_INPUT.hex()]:
            with self.subTest(kind=type(preimage)),self.assertRaises(ValueError):
                self.review(preimage=preimage)
        with self.assertRaises(ValueError):self.review("REFUND",preimage=PUBLIC_INPUT)

    def test_profile_lock_and_sequence_mutations_reject(self):
        for branch in ["CLAIM","REFUND"]:
            for sequence in [0,1,0xFFFFFFFF,True,-1,2**32]:
                with self.subTest(branch=branch,sequence=sequence),self.assertRaises(ValueError):
                    self.review(branch,sequence=sequence)
        for lock in [1350,1352,500_000_000,-1,True]:
            with self.subTest(lock=lock),self.assertRaises(ValueError):self.review("REFUND",transaction_lock=lock)
        with self.assertRaises(ValueError):self.review(transaction_lock=1351)

    def test_size_and_sigop_accounting_is_not_policy_acceptance(self):
        budget=decode_htlc(self.candidate.redeem).size_budget()
        self.assertEqual(budget["staticSigops"],2)
        self.assertEqual(budget["claimScriptSigMaxBytes"]-budget["refundScriptSigMaxBytes"],33)
        self.assertEqual(budget["claimScriptSigMaxBytes"],74+33+1+2+len(self.candidate.redeem))
        self.assertEqual(budget["nativeStandardness"],"NOT TESTED")
        self.assertFalse(budget["qualified"])


if __name__ == "__main__":
    unittest.main()
