import hashlib
import unittest

from offline_candidate import (FIELD, build_candidate, checked_pubkey,
                               cltv_condition_model, finality_model, minimal_positive_number)

# Existing public D2 point and public SEC2 generator. These are PUBLIC test
# vectors, not generated keys or a secure key-management example. Never funded.
CLAIM = bytes.fromhex("038479a0fa998cd35259a2ef0a7a5c68662c1474f88ccb6d08a7677bbec7f22041")
REFUND = bytes.fromhex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
COMMITMENT = hashlib.sha256(b"GPUbnb D2 public synthetic input").digest()


class OfflineCandidateTests(unittest.TestCase):
    def test_independent_literal_redeem(self):
        candidate = build_candidate(COMMITMENT, CLAIM, REFUND, 1351)
        expected = bytes.fromhex("6382012088a820" + COMMITMENT.hex() + "8821" + CLAIM.hex()
                                 + "ac67024705b17521" + REFUND.hex() + "ac68")
        self.assertEqual(candidate.redeem, expected)
        self.assertEqual(candidate.output, b"\xa9\x14" + hashlib.new("ripemd160", hashlib.sha256(expected).digest()).digest() + b"\x87")

    def test_old_same_key_diagnostic_is_not_promoted(self):
        with self.assertRaisesRegex(ValueError, "distinct"):
            build_candidate(COMMITMENT, CLAIM, CLAIM, 1351)

    def test_wrong_commitment_lengths_types(self):
        for value in [b"", b"x" * 31, b"x" * 33, "00" * 32, None]:
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                build_candidate(value, CLAIM, REFUND, 1351)

    def test_reject_noncompressed_offcurve_and_out_of_field(self):
        for key in [b"", b"\x04" + CLAIM[1:], CLAIM + b"\x00",
                    b"\x02" + FIELD.to_bytes(32, "big"), b"\x02" + bytes(32)]:
            with self.subTest(key=key.hex()), self.assertRaises(ValueError):
                checked_pubkey(key)

    def test_lock_minimal_encoding_boundaries(self):
        for lock, expected in [(1,"51"),(16,"60"),(17,"0111"),(127,"017f"),
            (128,"028000"),(255,"02ff00"),(256,"020001"),(1351,"024705"),
            (0xFFFFFFFF,"05ffffffff00")]:
            with self.subTest(lock=lock):
                self.assertEqual(minimal_positive_number(lock).hex(), expected)

    def test_invalid_locks_fail_closed(self):
        for lock in [True, False, 0, -1, 2**32, "1351", 1.0]:
            with self.subTest(lock=lock), self.assertRaises(ValueError):
                build_candidate(COMMITMENT, CLAIM, REFUND, lock)

    def test_parameter_mutations_change_commitment(self):
        base = build_candidate(COMMITMENT, CLAIM, REFUND, 1351)
        for other in [build_candidate(bytes(32),CLAIM,REFUND,1351),
                      build_candidate(COMMITMENT,REFUND,CLAIM,1351),
                      build_candidate(COMMITMENT,CLAIM,REFUND,1352)]:
            self.assertNotEqual(base.output, other.output)

    def test_no_qualification_or_executable_operation(self):
        report = build_candidate(COMMITMENT,CLAIM,REFUND,1351).report()
        self.assertFalse(report["qualified"])
        self.assertEqual(report["qualificationStatus"], "BLOCKED")
        self.assertEqual(report["executableOperations"], [])
        self.assertEqual(len(report["missingEvidence"]), 6)
        self.assertLessEqual(report["redeemBytes"],520)
        self.assertLessEqual(report["claimScriptSigBudgetBytes"],1650)
        self.assertEqual(report["staticSigops"],2)

    def test_cltv_equality_is_not_transaction_finality(self):
        self.assertTrue(cltv_condition_model(1351,1351,0xFFFFFFFE))
        self.assertFalse(finality_model(1351,[0xFFFFFFFE],1351,1_700_000_000))
        self.assertTrue(finality_model(1351,[0xFFFFFFFE],1352,1_700_000_000))

    def test_lock_domains_early_and_final_sequence(self):
        self.assertFalse(cltv_condition_model(1351,1350,0xFFFFFFFE))
        self.assertFalse(cltv_condition_model(1351,500_000_000,0xFFFFFFFE))
        self.assertFalse(cltv_condition_model(1351,1351,0xFFFFFFFF))
        self.assertTrue(finality_model(1351,[0xFFFFFFFF],1351,0))
        self.assertFalse(finality_model(1351,[0xFFFFFFFF,0xFFFFFFFE],1351,0))

    def test_time_lock_strict_boundary(self):
        self.assertFalse(finality_model(500_000_000,[0xFFFFFFFE],99,500_000_000))
        self.assertTrue(finality_model(500_000_000,[0xFFFFFFFE],99,500_000_001))
        self.assertEqual(build_candidate(COMMITMENT,CLAIM,REFUND,500_000_000).report()["lockDomain"], "time")

    def test_models_reject_invalid_unbounded_inputs(self):
        for seqs in [[], [False], [2**32], [0]*17, "sequence"]:
            with self.subTest(seqs=seqs), self.assertRaises(ValueError):
                finality_model(1351,seqs,1352,0)


if __name__ == "__main__":
    unittest.main()
