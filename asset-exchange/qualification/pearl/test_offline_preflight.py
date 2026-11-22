"""Adversarial pure-dictionary PRL marketplace *fictional* offer tests."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import offline_preflight as p

FIXTURE = Path(__file__).with_name('fixtures') / 'public_prl_offer_v1.json'


def original():
    return json.loads(FIXTURE.read_text())


class PRLOfflinePreflightTests(unittest.TestCase):
    def refuses(self, payload):
        with self.assertRaises(p.Refused):
            p.inspect_public_request(payload)

    def test_fixture_parses_and_passes_review_only(self):
        self.assertEqual(p.inspect_public_request(p.parse_public_request(FIXTURE.read_bytes()))['classification'],
                         'PUBLIC_PRL_SYNTHETIC_OFFER_SHAPE_PASS_ONLY')

    def test_digest_is_independent_of_dict_key_order(self):
        value = original()
        self.assertEqual(p.inspect_public_request(value)['requestSha256'],
                         p.inspect_public_request(dict(reversed(list(value.items()))))['requestSha256'])

    def test_never_posts_or_settles(self):
        result = p.inspect_public_request(original())
        for key in ['networkIdentityVerified', 'upstreamProtocolQualified',
                    'nativeConsensusVerified', 'realMarketplaceOfferPosted',
                    'qualified', 'canPostOffer', 'canTakeOffer', 'canFund',
                    'canSign', 'canBroadcast', 'automaticSettlementSupported']:
            self.assertIs(result[key], False, key)

    def test_expected_public_scopes(self):
        req = original()
        self.assertEqual(req['assetSymbol'], 'PRL')
        self.assertEqual(req['chainId'], 'pearl')
        self.assertEqual(req['offer']['requestedAsset'], 'DOGE')
        self.assertEqual(req['offer']['syntheticOnly'], True)

    def test_wrong_native_symbol_denied(self):
        for symbol in ['MTN', 'PEARL', 'WPRL', 'PRL ', 'prl', '', None, 1]:
            with self.subTest(symbol=repr(symbol)):
                req = original();req['assetSymbol'] = symbol;self.refuses(req)

    def test_wrong_chain_denied(self):
        for chain in ['bitcoin', 'litecoin', 'pearl-evm', '', None, True]:
            with self.subTest(chain=repr(chain)):
                req = original();req['chainId'] = chain;self.refuses(req)

    def test_wrong_network_denied(self):
        for network in ['mainnet', 'testnet', 'simnet', 'regtest ', None, True]:
            with self.subTest(network=repr(network)):
                req = original();req['network'] = network;self.refuses(req)

    def test_wrong_domain_denied(self):
        req = original();req['domain'] = 'GPUbnb:LTC:OFFLINE_LAB_REVIEW:v1';self.refuses(req)

    def test_wrong_protocol_denied(self):
        req = original();req['protocolVersion'] = 'DOGE_LAB';self.refuses(req)

    def test_real_offer_kind_denied(self):
        req = original();req['kind'] = 'ACTUAL_MARKETPLACE_OFFER';self.refuses(req)

    def test_schema_version_wrong_type_and_value_denied(self):
        for value in [True, 1.0, '1', None, 2]:
            with self.subTest(value=value):
                req = original();req['schemaVersion'] = value;self.refuses(req)

    def test_root_unknown_and_missing_field_denied(self):
        for name in ['txHex', 'wallet', 'privateKey', 'signedTerms', 'chainTip']:
            with self.subTest(name=name):
                req = original();req[name] = 'forbidden';self.refuses(req)
        req = original();del req['network'];self.refuses(req)

    def test_missing_or_extra_offer_field_denied(self):
        req = original();req['offer']['address'] = 'not-allowed';self.refuses(req)
        req = original();del req['offer']['offeredGrains'];self.refuses(req)

    def test_offer_wrong_side_denied(self):
        req = original();req['offer']['side'] = 'BUY_PRL';self.refuses(req)

    def test_offer_wrong_quote_asset_denied(self):
        for value in ['PRL', 'MTN', 'LTC', 'WPRL', 'doge', None]:
            with self.subTest(value=repr(value)):
                req = original();req['offer']['requestedAsset'] = value;self.refuses(req)

    def test_synthetic_scope_cannot_be_removed(self):
        for field, value in [('syntheticOnly', False), ('syntheticOnly', 1),
                             ('listingMode', 'PUBLIC_EXCHANGE_LIVE')]:
            req = original();req['offer'][field] = value;self.refuses(req)

    def test_noncanonical_amounts_denied(self):
        for field in ['offeredGrains', 'requestedAtoms']:
            for value in ['0', '01', '-1', '+1', '1.0', ' 5', '', '1_000', '٠١',
                          0, 1, False, None, '9'*100, '1000000000000001']:
                with self.subTest(field=field, value=repr(value)):
                    req = original();req['offer'][field] = value;self.refuses(req)

    def test_some_positive_synthetic_amounts_accepted(self):
        for field in ['offeredGrains', 'requestedAtoms']:
            for amount in ['1', '10', '999999999999999', '1000000000000000']:
                with self.subTest(field=field, value=amount):
                    req = original();req['offer'][field] = amount
                    self.assertFalse(p.inspect_public_request(req)['canSign'])

    def test_unknown_and_missing_financial_permission_denied(self):
        req = original();req['permissions']['canMine'] = False;self.refuses(req)
        req = original();del req['permissions']['canSign'];self.refuses(req)

    def test_each_financial_permission_cannot_be_raised(self):
        for name in original()['permissions']:
            for value in [True, 0, None, 'false']:
                with self.subTest(field=name, value=repr(value)):
                    req = original();req['permissions'][name] = value;self.refuses(req)

    def test_duplicate_root_keys_refused(self):
        b = FIXTURE.read_bytes().replace(b'"chainId": "pearl",', b'"chainId": "pearl", "chainId": "pearl",')
        with self.assertRaises(p.Refused):p.parse_public_request(b)

    def test_duplicate_nested_keys_refused(self):
        b = FIXTURE.read_bytes().replace(b'"canSign": false,', b'"canSign": false, "canSign": false,')
        with self.assertRaises(p.Refused):p.parse_public_request(b)

    def test_invalid_json_and_encoding_refused(self):
        for b in [b'{', b'', b'\xff\xfe', b'[]', b'NaN', b'null', b'\x00']:
            with self.subTest(value=b):
                with self.assertRaises(p.Refused):p.parse_public_request(b)

    def test_input_type_and_size_limits(self):
        for b in [None, [], 'json', {}, b' '*8193]:
            with self.subTest(type=type(b).__name__):
                with self.assertRaises(p.Refused):p.parse_public_request(b)

    def test_nonfinite_json_refused(self):
        b = FIXTURE.read_bytes().replace(b'"schemaVersion": 1', b'"schemaVersion": NaN')
        with self.assertRaises(p.Refused):p.parse_public_request(b)

    def test_no_side_effects_or_file_io_during_validation(self):
        req = original();copy_req = copy.deepcopy(req)
        with patch('builtins.open', side_effect=AssertionError('I/O forbidden')):
            self.assertIn('requestSha256', p.inspect_public_request(req))
        self.assertEqual(copy_req, req)


if __name__ == '__main__':
    unittest.main()
