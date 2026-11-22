"""Only public integer and domain-separation tests; no signing or node."""
import unittest
from unittest.mock import patch
import refund_height_model as m


def example(**kw):
    data = dict(script_height=450, tx_locktime=450, tx_sequence=0xFFFFFFFE,
                hypothetical_inclusion_height=451)
    data.update(kw)
    return m.simulate_refund_height(**data)


class RefundHeightModelTests(unittest.TestCase):
    def test_threshold_450_hypothetical_451(self):
        self.assertEqual(example()['classification'],
                         'SIMULATED_SCALAR_CONDITIONS_MET_NO_CHAIN_PROOF')

    def test_same_height_450_blocked(self):
        self.assertEqual(example(hypothetical_inclusion_height=450)['classification'],
                         'SIMULATED_BLOCKED_TX_FINALITY')

    def test_one_less_height_blocked(self):
        self.assertEqual(example(hypothetical_inclusion_height=449)['classification'],
                         'SIMULATED_BLOCKED_TX_FINALITY')

    def test_cltv_below_script_target_blocked(self):
        self.assertEqual(example(tx_locktime=449)['classification'],
                         'SIMULATED_BLOCKED_CLTV_HEIGHT')

    def test_cltv_higher_target_without_finality_still_blocked(self):
        self.assertEqual(example(tx_locktime=452)['classification'],
                         'SIMULATED_BLOCKED_TX_FINALITY')

    def test_cltv_higher_target_with_hypothetical_height_pass(self):
        self.assertEqual(example(tx_locktime=452, hypothetical_inclusion_height=453)['classification'],
                         'SIMULATED_SCALAR_CONDITIONS_MET_NO_CHAIN_PROOF')

    def test_time_type_does_not_satisfy_height_type(self):
        self.assertEqual(example(tx_locktime=500000000)['classification'],
                         'SIMULATED_BLOCKED_LOCKTIME_TYPE_MISMATCH')

    def test_maximum_time_type_does_not_satisfy_height_type(self):
        self.assertEqual(example(tx_locktime=0xFFFFFFFF)['classification'],
                         'SIMULATED_BLOCKED_LOCKTIME_TYPE_MISMATCH')

    def test_valid_edges_height_1_and_2(self):
        self.assertEqual(example(script_height=1, tx_locktime=1,
                                 hypothetical_inclusion_height=2)['classification'],
                         'SIMULATED_SCALAR_CONDITIONS_MET_NO_CHAIN_PROOF')

    def test_boundary_499999998_and_499999999(self):
        self.assertEqual(example(script_height=499999998, tx_locktime=499999998,
                                 hypothetical_inclusion_height=499999999)['classification'],
                         'SIMULATED_SCALAR_CONDITIONS_MET_NO_CHAIN_PROOF')

    def test_last_height_cannot_be_called_ready_in_model(self):
        self.assertEqual(example(script_height=499999999, tx_locktime=499999999,
                                 hypothetical_inclusion_height=499999999)['classification'],
                         'SIMULATED_BLOCKED_TX_FINALITY')

    def test_invalid_script_height_values_refused(self):
        for val in [0, -1, 500000000, True, 450.0, '450', None, 2**64]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(script_height=val)

    def test_invalid_locktime_values_refused(self):
        for val in [-1, 2**32, True, 450.0, '450', None]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(tx_locktime=val)

    def test_invalid_sequence_values_refused(self):
        for val in [0xFFFFFFFF, 0xFFFFFFFD, 0, -1, 2**32, True, 0.0, '4294967294']:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(tx_sequence=val)

    def test_invalid_inclusion_height_values_refused(self):
        for val in [0, -1, 500000000, True, 451.0, '451', None]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(hypothetical_inclusion_height=val)

    def test_wrong_chain_refused(self):
        for val in ['bitcoin', 'dogecoin', 'LTC', '', None, True]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(chain=val)

    def test_wrong_network_refused(self):
        for val in ['mainnet', 'main', 'testnet', 'regtest ', '', None]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(network=val)

    def test_mweb_or_ambiguous_flag_refused(self):
        for val in [True, 0, 1, 'false', None]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(mweb=val)

    def test_wrong_sighash_refused(self):
        for val in ['NONE', 'SINGLE', 'ANYONECANPAY|ALL', 1, None]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(sighash=val)

    def test_wrong_candidate_version_refused(self):
        for val in [0, 1, 3, True, 2.0, '2', None]:
            with self.subTest(val=val), self.assertRaises(m.ModelRefused):
                example(tx_version=val)

    def test_status_never_authorizes_recovery_or_financial_actions(self):
        for scenario in [dict(), dict(tx_locktime=449), dict(tx_locktime=500000000),
                         dict(hypothetical_inclusion_height=450)]:
            data = example(**scenario)
            for field in ['nativeConsensusVerified', 'chainEvidenceVerified',
                          'qualified', 'canRefund', 'canSign', 'canBroadcast',
                          'automaticSettlementSupported']:
                self.assertIs(data[field], False, field)

    def test_hypothetical_height_is_not_labeled_chain_evidence(self):
        result = example(hypothetical_inclusion_height=451)
        self.assertIn('hypotheticalInclusionHeight', result)
        self.assertNotIn('chainTipHeight', result)
        self.assertIs(result['chainEvidenceVerified'], False)

    def test_function_is_pure_and_file_free(self):
        with patch('builtins.open', side_effect=AssertionError('file access not allowed')):
            self.assertIn('SIMULATED', example()['classification'])


if __name__ == '__main__':
    unittest.main()
