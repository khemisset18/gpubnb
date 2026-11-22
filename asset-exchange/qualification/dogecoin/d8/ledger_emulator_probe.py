"""Non-financial Ledger DOGE Speculos APDU identity probe, standard library only.

Runs INSIDE the isolated Speculos container against 127.0.0.1.
No signature APDU, approval, seed, RPC or blockchain operation is permitted.
"""
import hashlib
import json
import re
import urllib.request

API = "http://127.0.0.1:5000"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
# Every allowed APDU is fixed in source. Do NOT add signing/transaction commands.
COIN_VERSION_APDU = "e016000000"
FIRMWARE_VERSION_APDU = "e0c4000000"
# m/44'/3'/0'/0/0: DOGE BIP44 only, P1_NO_DISPLAY, P2_LEGACY.
DOGE_PUBKEY_APDU = "e040000015058000002c80000003800000000000000000000000"
BAD_CLASS_APDU = "e116000000"
BAD_INSTRUCTION_APDU = "e0ff000000"


def parse_apdu(data):
    if not isinstance(data, str) or len(data) < 4 or len(data) > 2048 or not re.fullmatch("[0-9a-fA-F]+", data):
        raise ValueError("invalid bounded APDU response")
    raw = bytes.fromhex(data)
    return raw[:-2], raw[-2:].hex()


def base58check(address):
    if not isinstance(address, str) or not 25 <= len(address) <= 40 or any(c not in ALPHABET for c in address):
        raise ValueError("invalid base58 address")
    value = 0
    for char in address:
        value = value * 58 + ALPHABET.index(char)
    significant = value.to_bytes((value.bit_length() + 7) // 8, "big") if value else b""
    raw = b"\x00" * (len(address) - len(address.lstrip("1"))) + significant
    if len(raw) != 25:
        raise ValueError("invalid DOGE address length")
    expected = hashlib.sha256(hashlib.sha256(raw[:21]).digest()).digest()[:4]
    if raw[21:] != expected:
        raise ValueError("invalid DOGE checksum")
    return raw[:21]


def parse_coin(payload):
    if len(payload) < 7:
        raise ValueError("short coin response")
    p2pkh = int.from_bytes(payload[:2], "big")
    p2sh = int.from_bytes(payload[2:4], "big")
    family = payload[4]
    at = 5
    count = payload[at]
    at += 1
    name = payload[at:at + count]
    at += count
    if not 1 <= count <= 40 or at >= len(payload):
        raise ValueError("invalid coin name")
    count = payload[at]
    at += 1
    short_name = payload[at:at + count]
    at += count
    if at != len(payload) or name != b"Dogecoin" or short_name != b"DOGE" or (p2pkh, p2sh, family) != (30, 22, 1):
        raise ValueError("unexpected coin family/version (DOGE mainnet only)")
    return {"coin": "DOGE", "network_in_app": "dogecoin-mainnet",
            "p2pkh_prefix": p2pkh, "p2sh_prefix": p2sh}


def parse_wallet_public_response(payload):
    if len(payload) < 100 or payload[0] != 65 or payload[1] != 4:
        raise ValueError("wrong public key encoding")
    address_size = payload[66]
    if not 27 <= address_size <= 40 or len(payload) != 67 + address_size + 32:
        raise ValueError("unexpected public key response size")
    try:
        address = payload[67:67 + address_size].decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("non-ascii address") from error
    if base58check(address)[0] != 30:
        raise ValueError("not a DOGE mainnet P2PKH address")
    pub = payload[1:66]
    compressed = bytes([2 + (pub[-1] & 1)]) + pub[1:33]
    address_hash = hashlib.new("ripemd160", hashlib.sha256(compressed).digest()).digest()
    if base58check(address)[1:] != address_hash:
        raise ValueError("address does not match returned public key")
    return {
        "address_format": "DOGE_P2PKH_BASE58CHECK",
        "pubkey_matches_address": True,
        "public_key_sha256": hashlib.sha256(pub).hexdigest(),
        "public_address_sha256": hashlib.sha256(address.encode("ascii")).hexdigest(),
        "ownership_verified": False, "private_keys_accessed": False,
    }


def send_apdu(value):
    if value not in (COIN_VERSION_APDU, FIRMWARE_VERSION_APDU, DOGE_PUBKEY_APDU,
                     BAD_CLASS_APDU, BAD_INSTRUCTION_APDU):
        raise ValueError("APDU not allowlisted")
    request = urllib.request.Request(
        API + "/apdu", data=json.dumps({"data": value}).encode("ascii"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        body = response.read(4096)
    decoded = json.loads(body)
    if not isinstance(decoded, dict):
        raise ValueError("malformed Speculos APDU JSON")
    return parse_apdu(decoded.get("data"))


def probe():
    coin_raw, coin_sw = send_apdu(COIN_VERSION_APDU)
    if coin_sw != "9000":
        raise ValueError("coin version APDU failed")
    coin = parse_coin(coin_raw)
    fw_raw, fw_sw = send_apdu(FIRMWARE_VERSION_APDU)
    if fw_sw != "9000" or not 4 <= len(fw_raw) <= 128:
        raise ValueError("firmware version APDU failed")
    pub_raw, pub_sw = send_apdu(DOGE_PUBKEY_APDU)
    if pub_sw != "9000":
        raise ValueError("DOGE public key APDU failed or needs unexpected approval")
    public = parse_wallet_public_response(pub_raw)
    _, bad_class_sw = send_apdu(BAD_CLASS_APDU)
    _, bad_ins_sw = send_apdu(BAD_INSTRUCTION_APDU)
    if bad_class_sw != "6e00" or bad_ins_sw != "6d00":
        raise ValueError("unexpected negative APDU response")
    return {
        "scope": "NON_SIGNING_APDU_EMULATOR_IDENTITY_ONLY",
        "coin": coin,
        "firmware_response_sha256": hashlib.sha256(fw_raw).hexdigest(),
        "public_wallet_probe": public,
        "negative_apdu_refusals": {"wrong_class": bad_class_sw, "unsupported_instruction": bad_ins_sw},
        "doge_regtest_htlc_signing_verified": False,
        "real_device_display_verified": False,
        "D8_hardware_status": "BLOCKED",
        "wallet_seed": "SPECULOS_DISPOSABLE_DEFAULT_ONLY",
        "funds_used": 0,
        "broadcast_count": 0,
    }


if __name__ == "__main__":
    print(json.dumps(probe(), sort_keys=True))
