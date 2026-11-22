"""Pure checks of the bounded public-only Speculos APDU verifier."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "doge_speculos_probe", Path(__file__).with_name("ledger_emulator_probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def make_address(payload):
    raw = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    value = int.from_bytes(raw, "big")
    text = ""
    while value:
        value, remainder = divmod(value, 58)
        text = probe.ALPHABET[remainder] + text
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + text


class LedgerEmulatorProbeTests(unittest.TestCase):
    def test_doge_apdu_path_is_fixed_and_has_no_display_or_sign(self):
        data = bytes.fromhex(probe.DOGE_PUBKEY_APDU)
        self.assertEqual(data[:5], bytes([0xe0, 0x40, 0, 0, 21]))
        self.assertEqual(data[5:], bytes.fromhex("058000002c80000003800000000000000000000000"))
        self.assertEqual(probe.COIN_VERSION_APDU, "e016000000")
        self.assertEqual(probe.FIRMWARE_VERSION_APDU, "e0c4000000")

    def test_parse_mainnet_coin_or_reject_wrong_identity(self):
        raw = b"\x00\x1e\x00\x16\x01\x08Dogecoin\x04DOGE"
        self.assertEqual(probe.parse_coin(raw)["coin"], "DOGE")
        with self.assertRaises(ValueError):
            probe.parse_coin(raw.replace(b"DOGE", b"BTC!"))
        with self.assertRaises(ValueError):
            probe.parse_coin(b"\x00\x6f" + raw[2:])

    def test_base58_checksum_and_coin_version(self):
        address = make_address(bytes([30]) + bytes([7] * 20))
        self.assertEqual(probe.base58check(address), bytes([30]) + bytes([7] * 20))
        changed = address[:-1] + ("1" if address[-1] != "1" else "2")
        with self.assertRaises(ValueError):
            probe.base58check(changed)
        for x in ("", "O0Il", "x" * 60):
            with self.assertRaises(ValueError):
                probe.base58check(x)

    def test_apdu_status_word_is_bounded(self):
        self.assertEqual(probe.parse_apdu("001e9000"), (b"\x00\x1e", "9000"))
        self.assertEqual(probe.parse_apdu("6e00"), (b"", "6e00"))
        for text in ("", "abcd0", "ghi6e00", "aa" * 1025):
            with self.assertRaises(ValueError):
                probe.parse_apdu(text)

    def test_wallet_response_requires_bip44_doge_pubkey_match(self):
        pub = b"\x04" + bytes(range(1, 65))
        compressed = bytes([2 + (pub[-1] & 1)]) + pub[1:33]
        h = hashlib.new("ripemd160", hashlib.sha256(compressed).digest()).digest()
        address = make_address(bytes([30]) + h).encode("ascii")
        raw = bytes([65]) + pub + bytes([len(address)]) + address + bytes(32)
        parsed = probe.parse_wallet_public_response(raw)
        self.assertTrue(parsed["pubkey_matches_address"])
        self.assertFalse(parsed["ownership_verified"])
        bad_address = make_address(bytes([30]) + bytes(20)).encode("ascii")
        bad = bytes([65]) + pub + bytes([len(bad_address)]) + bad_address + bytes(32)
        with self.assertRaises(ValueError):
            probe.parse_wallet_public_response(bad)


if __name__ == "__main__":
    unittest.main()
