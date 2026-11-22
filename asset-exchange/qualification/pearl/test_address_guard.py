"""Deterministic, fully public Pearl Bech32m shape tests; no wallet or key."""
import unittest
from unittest.mock import patch
import address_guard as g

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]


def reference_encode(hrp, version, program, *, bech32m=True, extra_groups=()):
    """Separate test-only reference encoder; operates on public bytes."""
    data = [version]
    acc, bits = 0, 0
    for byte in program:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            data.append((acc >> bits) & 31)
    if bits:
        data.append((acc << (5 - bits)) & 31)
    data.extend(extra_groups)
    checksum_input = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp] + data + [0] * 6
    state = 1
    for byte in checksum_input:
        high = state >> 25
        state = ((state & 0x1ffffff) << 5) ^ byte
        for bit, generator in enumerate(GEN):
            if (high >> bit) & 1:
                state ^= generator
    state ^= 0x2bc830a3 if bech32m else 1
    return hrp + '1' + ''.join(CHARSET[x] for x in data + [(state >> (5 * (5 - j))) & 31 for j in range(6)])


PROGRAM = bytes(range(1, 33))
VALID = reference_encode('rprl', 1, PROGRAM)


class PRLAddressGuards(unittest.TestCase):
    def refuses(self, value, msg=None):
        with self.assertRaises(g.AddressRefused) as error:
            g.classify_public_prl_v1_shape(value)
        if msg:
            self.assertIn(msg, str(error.exception))

    def test_public_v1_program_accepted_as_shape_only(self):
        obj = g.classify_public_prl_v1_shape(VALID)
        self.assertEqual(obj['candidateScriptPubKeyHex'], '5120' + PROGRAM.hex())
        self.assertEqual(obj['classification'], 'PUBLIC_PRL_WITNESS_V1_32_BYTE_SHAPE_ONLY')

    def test_one_upstream_known_mainnet_vector_refused(self):
        # Literal public test vector from Pearl's node/btcutil/address_test.go
        self.refuses('prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv', 'domain')

    def test_known_testnet_vector_refused(self):
        self.refuses('tprl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqalmzae', 'domain')

    def test_rprl_shared_between_regtest_and_simnet(self):
        obj = g.classify_public_prl_v1_shape(VALID)
        self.assertEqual(obj['possibleNetworks'], ['regtest', 'simnet'])
        self.assertFalse(obj['networkIdentityVerified'])

    def test_no_financial_privileges(self):
        obj = g.classify_public_prl_v1_shape(VALID)
        for key in ['networkIdentityVerified', 'nativeConsensusVerified', 'qualified',
                    'canFund', 'canSign', 'canBroadcast', 'automaticSettlementSupported']:
            self.assertIs(obj[key], False)

    def test_cross_chain_hrps_refused(self):
        for hrp in ['prl', 'tprl', 'bc', 'bcrt', 'tb', 'rltc', 'ltc', 'doge', 'prl2']:
            with self.subTest(hrp=hrp):
                self.refuses(reference_encode(hrp, 1, PROGRAM), 'domain')

    def test_segwit_v0_refused_even_with_valid_checksum(self):
        self.refuses(reference_encode('rprl', 0, bytes(range(1, 21)), bech32m=False), 'checksum')
        self.refuses(reference_encode('rprl', 0, bytes(range(1, 21))), 'witness v1')

    def test_witness_v2_p2mr_refused(self):
        self.refuses(reference_encode('rprl', 2, PROGRAM), 'witness v1')

    def test_future_witness_v16_refused(self):
        self.refuses(reference_encode('rprl', 16, PROGRAM), 'witness v1')

    def test_bech32_checksum_not_bech32m_refused(self):
        self.refuses(reference_encode('rprl', 1, PROGRAM, bech32m=False), 'checksum')

    def test_noncanonical_witness_lengths_refused(self):
        for length in [1, 20, 31, 33, 40]:
            with self.subTest(length=length):
                self.refuses(reference_encode('rprl', 1, bytes([1] * length)), '32 bytes')

    def test_extra_zero_group_refused(self):
        self.refuses(reference_encode('rprl', 1, PROGRAM, extra_groups=(0,)), '32 bytes')

    def test_extra_nonzero_group_refused(self):
        self.refuses(reference_encode('rprl', 1, PROGRAM, extra_groups=(1,)), 'padding')

    def test_full_character_checksum_mutations_refused(self):
        for i in range(len(VALID)):
            mutated = VALID[:i] + ('q' if VALID[i] != 'q' else 'p') + VALID[i + 1:]
            with self.subTest(position=i):
                self.refuses(mutated)

    def test_case_variants_refused(self):
        for candidate in [VALID.upper(), VALID[:4].upper() + VALID[4:], 'RpRl' + VALID[4:]]:
            with self.subTest(value=candidate[:10]):
                self.refuses(candidate, 'case')

    def test_unicode_and_whitespace_refused(self):
        for candidate in [VALID + ' ', ' ' + VALID, VALID + '\n', VALID.replace('r', 'ŕ', 1), '\0' + VALID]:
            with self.subTest(candidate=repr(candidate[:8])):
                self.refuses(candidate)

    def test_invalid_character_refused(self):
        self.refuses(VALID[:-1] + 'b', 'alphabet')

    def test_bad_separator_and_too_short_refused(self):
        for candidate in ['rprl', 'rprl1', 'rprl1abc', VALID.replace('1', 'p', 1)]:
            with self.subTest(candidate=candidate):
                self.refuses(candidate)

    def test_overlong_address_refused(self):
        self.refuses('rprl1' + 'q'*90, 'size')

    def test_invalid_types_refused(self):
        for candidate in [None, [], {}, b'rprl', True, 42, 0.5]:
            with self.subTest(type=type(candidate).__name__):
                self.refuses(candidate, 'type')

    def test_no_file_io(self):
        with patch('builtins.open', side_effect=AssertionError('file read prohibited')):
            self.assertEqual(g.classify_public_prl_v1_shape(VALID)['witnessVersion'], 1)


if __name__ == '__main__':
    unittest.main()
