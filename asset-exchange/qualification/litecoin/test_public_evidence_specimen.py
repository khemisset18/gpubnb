"""Strictly public fictitious evidence, not a real Litecoin recovery package."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import candidate_htlc as h
import public_evidence_specimen as e

REQUEST = Path(__file__).with_name('fixtures') / 'transparent_request_v1.json'
SCRIPT = h.build_synthetic_htlc_script(
    bytes.fromhex('a1'*32), bytes.fromhex('02'+'11'*32),
    bytes.fromhex('03'+'22'*32), 450)


def specimen():
    return e.build_public_specimen(REQUEST.read_bytes(), SCRIPT)


def encoded(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':')).encode()


def seal(obj):
    obj['bundleSha256'] = hashlib.sha256(encoded({k:v for k,v in obj.items()
                                                    if k != 'bundleSha256'})).hexdigest()
    return obj


class PublicEvidenceSpecimenTests(unittest.TestCase):
    def refused(self, raw):
        with self.assertRaises(e.SpecimenRefused):
            e.verify_public_specimen(raw)

    def test_roundtrip_public_specimen(self):
        self.assertIn('NOT_RECOVERABLE', e.verify_public_specimen(encoded(specimen()))['classification'])

    def test_determinism_of_public_specimen(self):
        self.assertEqual(specimen(), specimen())

    def test_checksum_matches_canonical_content(self):
        obj = specimen()
        self.assertEqual(obj['bundleSha256'],
                         hashlib.sha256(encoded({k:v for k,v in obj.items()
                                                  if k != 'bundleSha256'})).hexdigest())

    def test_request_sha_matches_offline_preflight(self):
        from offline_preflight import parse_request, validate_request
        wanted = validate_request(parse_request(REQUEST.read_bytes()))['requestSha256']
        self.assertEqual(specimen()['requestSha256'], wanted)

    def test_script_sha_matches_public_bytes(self):
        self.assertEqual(specimen()['candidateScriptSha256'], hashlib.sha256(SCRIPT).hexdigest())

    def test_p2wsh_commitment_matches_script_bytes(self):
        self.assertEqual(specimen()['candidateP2WSHScriptPubKeyHex'],
                         '0020'+hashlib.sha256(SCRIPT).hexdigest())

    def test_all_financial_flags_are_false(self):
        output = e.verify_public_specimen(encoded(specimen()))
        for field in ['sourceAuthenticityVerified','nativeConsensusVerified',
                      'independentRecoveryVerified','qualified','canRefund',
                      'canSign','canBroadcast','automaticSettlementSupported']:
            self.assertIs(output[field], False)
        self.assertTrue(all(x is False for x in specimen()['permissions'].values()))

    def test_root_extra_field_refused_even_after_reseal(self):
        obj=specimen();obj['walletSeed']='do-not-accept';self.refused(encoded(seal(obj)))

    def test_missing_field_refused_even_after_reseal(self):
        obj=specimen();del obj['domain'];self.refused(encoded(seal(obj)))

    def test_wrong_network_refused_even_after_reseal(self):
        obj=specimen();obj['network']='mainnet';self.refused(encoded(seal(obj)))

    def test_wrong_genesis_refused_even_after_reseal(self):
        obj=specimen();obj['genesis']='00'*32;self.refused(encoded(seal(obj)))

    def test_wrong_asset_refused_even_after_reseal(self):
        obj=specimen();obj['asset']='BTC';self.refused(encoded(seal(obj)))

    def test_wrong_protocol_refused_even_after_reseal(self):
        obj=specimen();obj['protocolVersion']='test';self.refused(encoded(seal(obj)))

    def test_wrong_kind_refused_even_after_reseal(self):
        obj=specimen();obj['kind']='RECOVERABLE';self.refused(encoded(seal(obj)))

    def test_unpermitted_can_sign_refused_even_after_reseal(self):
        obj=specimen();obj['permissions']['canSign']=True;self.refused(encoded(seal(obj)))

    def test_bool_impostor_permission_refused_even_after_reseal(self):
        obj=specimen();obj['permissions']['canRefund']=0;self.refused(encoded(seal(obj)))

    def test_script_mutation_detected_with_resealed_bundle(self):
        obj=specimen();obj['candidateScriptHex']=obj['candidateScriptHex'][:-2]+'00'
        self.refused(encoded(seal(obj)))

    def test_refund_height_in_request_must_match_script(self):
        obj=specimen();obj['request']['review']['refundLockHeight']=451
        self.refused(encoded(seal(obj)))

    def test_request_tampered_without_reseal_refused(self):
        obj=specimen();obj['request']['review']['feeLitoshi']='200000'
        self.refused(encoded(obj))

    def test_request_arithmetic_inconsistent_even_if_resealed(self):
        obj=specimen();obj['request']['review']['feeLitoshi']='200000'
        self.refused(encoded(seal(obj)))

    def test_script_hash_mismatch_even_if_resealed(self):
        obj=specimen();obj['candidateScriptSha256']='ff'*32
        self.refused(encoded(seal(obj)))

    def test_p2wsh_mismatch_even_if_resealed(self):
        obj=specimen();obj['candidateP2WSHScriptPubKeyHex']='0020'+'aa'*32
        self.refused(encoded(seal(obj)))

    def test_nested_duplicate_field_refused(self):
        raw=encoded(specimen()).replace(b'"network":"regtest",',
               b'"network":"regtest","network":"mainnet",',1)
        self.refused(raw)

    def test_nonfinite_json_refused(self):
        self.refused(encoded(specimen()).replace(b'"schemaVersion":1',b'"schemaVersion":NaN'))

    def test_malformed_utf8_and_non_json_refused(self):
        for raw in [b'\xff\xfe',b'{', b'']:
            with self.subTest(raw=raw):self.refused(raw)

    def test_wrong_input_types_and_oversized_refused(self):
        for raw in [None,{},'hello',b'x'*16385]:
            with self.subTest(type=str(type(raw))):self.refused(raw)

    def test_cannot_build_specimen_from_corrupt_request(self):
        with self.assertRaises(e.SpecimenRefused):
            e.build_public_specimen(b'{}', SCRIPT)

    def test_cannot_build_specimen_from_bad_script(self):
        with self.assertRaises(e.SpecimenRefused):
            e.build_public_specimen(REQUEST.read_bytes(), SCRIPT[:-1])

    def test_cannot_build_specimen_when_refund_heights_differ(self):
        other = h.build_synthetic_htlc_script(bytes.fromhex('a1'*32),
                bytes.fromhex('02'+'11'*32), bytes.fromhex('03'+'22'*32), 451)
        with self.assertRaises(e.SpecimenRefused):
            e.build_public_specimen(REQUEST.read_bytes(), other)

    def test_verification_is_pure_without_file_access(self):
        raw=encoded(specimen())
        with patch('builtins.open',side_effect=AssertionError('no file IO')):
            self.assertIn('CONSISTENT', e.verify_public_specimen(raw)['classification'])


if __name__=='__main__':unittest.main()
