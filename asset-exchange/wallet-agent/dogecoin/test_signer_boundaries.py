"""Additional D8 software boundary tests; no physical device claim."""
import copy
import subprocess
import unittest
from unittest.mock import patch

import refund_ladder as policy
import test_refund_ladder as fixtures


class SignerBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = fixtures.RefundLadderTests
        fixture.setUpClass()
        try:
            cls.request = copy.deepcopy(fixture.plan)
            cls.response = copy.deepcopy(fixture.response)
        finally:
            fixture.tearDownClass()

    def finalize(self, request=None, response=None):
        return policy.finalize_refund_signing_response(
            self.request if request is None else request,
            self.response if response is None else response,
            trusted_terms_digest=self.request['termsDigest'],
            trusted_request_digest=self.request['requestDigest'], current_height=1353)

    def test_reordered_or_duplicated_valid_signatures_cannot_authorize_another_fee_step(self):
        signatures = self.response['signatures']
        variants = (list(reversed(signatures)), signatures[1:] + signatures[:1],
                    [signatures[0]] * len(signatures))
        for supplied in variants:
            with self.subTest(signatures=supplied):
                changed = copy.deepcopy(self.response); changed['signatures'] = supplied
                with self.assertRaisesRegex(ValueError, 'signature verification failed'):
                    self.finalize(response=changed)

    def test_changed_request_cannot_replace_independently_retained_display_receipts(self):
        common = dict(contract=self.request['contract'], funding=self.request['funding'],
            policy=self.request['policy'], destination_hex=self.request['destinationHex'],
            fees=[row['feeKoinu'] for row in self.request['entries']],
            request_id=self.request['requestId'], created_at_height=1352, request_expires_at_height=1360)
        for change in ({'destination_hex':'76a914' + '22' * 20 + '88ac'},
                       {'fees':['1000000','20000000','100000000']},
                       {'request_id':'replacement_request'}, {'request_expires_at_height':1361}):
            with self.subTest(change=change):
                # This generates a fully self-consistent changed request, including
                # new hashes; those hashes still cannot authorize their own terms.
                changed = policy.create_refund_signing_request(**{**common, **change})
                with patch.object(policy, 'verify_public_signature', side_effect=AssertionError('must refuse before verification')):
                    with self.assertRaisesRegex(ValueError, 'trusted displayed terms'):
                        self.finalize(request=changed)

    def test_public_verifier_failure_or_timeout_has_no_key_or_signing_fallback(self):
        failures = (FileNotFoundError('verifier absent'), PermissionError('verifier unavailable'),
                    subprocess.TimeoutExpired(['/usr/bin/openssl'], 5))
        with patch.object(fixtures.EphemeralSigner, 'sign', side_effect=AssertionError('no fallback signing')):
            for failure in failures:
                with self.subTest(failure=type(failure).__name__), patch.object(policy.subprocess, 'run', side_effect=failure):
                    with self.assertRaisesRegex(policy.SignerUnavailableError, 'verification primitive unavailable'):
                        self.finalize()
            with patch.object(policy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'failed')):
                with self.assertRaisesRegex(ValueError, 'signature verification failed'):
                    self.finalize()

    def test_unqualified_device_profile_and_incomplete_or_wrongly_typed_response_refuse(self):
        for field, value in (('firmware', 'unqualified'), ('deviceProfile', 'generic-doge'),
                             ('signatures', []), ('signatures', None), ('signatures', {}),
                             ('signatures', [None] * len(self.response['signatures'])),
                             ('signatures', [True] * len(self.response['signatures'])),
                             ('schemaVersion', True)):
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(self.response); changed[field] = value
                with patch.object(fixtures.EphemeralSigner, 'sign', side_effect=AssertionError('no fallback signing')):
                    with self.assertRaises(ValueError):
                        self.finalize(response=changed)


if __name__ == '__main__':
    unittest.main()
