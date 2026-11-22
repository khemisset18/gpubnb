"""Fail-closed public Pearl (PRL) witness-v1 *address-shape* checker.

No wallet, key derivation, signature, node, transaction, network or file I/O.
Important: rprl is SHARED between Pearl regtest and simnet; neither this
address nor its checksum proves network identity or asset provenance.
"""
from __future__ import annotations

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
VALUES = {c: i for i, c in enumerate(CHARSET)}
GEN = (0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)
BECH32M_CONST = 0x2bc830a3


class AddressRefused(ValueError):
    """An input is malformed or is not the supported PRL research shape."""


def _polymod(values: list[int]) -> int:
    state = 1
    for value in values:
        top = state >> 25
        state = ((state & 0x1ffffff) << 5) ^ value
        for bit, generator in enumerate(GEN):
            if (top >> bit) & 1:
                state ^= generator
    return state


def _expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _unpack_5bit(values: list[int]) -> bytes:
    acc = 0
    bits = 0
    result = bytearray()
    for value in values:
        if not 0 <= value < 32:
            raise AddressRefused("invalid data value")
        acc = ((acc << 5) | value) & 4095
        bits += 5
        while bits >= 8:
            bits -= 8
            result.append((acc >> bits) & 0xff)
    if bits >= 5 or ((acc << (8 - bits)) & 0xff) != 0:
        raise AddressRefused("non-canonical witness padding")
    return bytes(result)


def classify_public_prl_v1_shape(value: str) -> dict:
    """Accept only canonical *lowercase* bech32m rprl witness-v1 32 bytes.

    This recognizes an address encoding only. It cannot identify regtest
    versus simnet, verify a Taproot spend, or grant any settlement permission.
    """
    if type(value) is not str or not 8 <= len(value) <= 90:
        raise AddressRefused("address size or type not allowed")
    if any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise AddressRefused("non-ASCII or whitespace")
    if value != value.lower():
        raise AddressRefused("uppercase or mixed case not canonical here")
    sep = value.rfind("1")
    if sep < 1 or sep + 7 > len(value):
        raise AddressRefused("invalid separator or checksum length")
    hrp = value[:sep]
    if hrp != "rprl":
        raise AddressRefused("not PRL regtest/simnet domain")
    try:
        data = [VALUES[c] for c in value[sep + 1:]]
    except KeyError as exc:
        raise AddressRefused("invalid bech32 alphabet") from exc
    if _polymod(_expand(hrp) + data) != BECH32M_CONST:
        raise AddressRefused("invalid bech32m checksum")
    payload = data[:-6]
    if not payload or payload[0] != 1:
        raise AddressRefused("only witness v1 allowed; no segwit v0 or P2MR v2")
    program = _unpack_5bit(payload[1:])
    if len(program) != 32:
        raise AddressRefused("witness v1 program must be 32 bytes")
    return {
        "classification": "PUBLIC_PRL_WITNESS_V1_32_BYTE_SHAPE_ONLY",
        "addressHrp": "rprl",
        "possibleNetworks": ["regtest", "simnet"],
        "witnessVersion": 1,
        "candidateScriptPubKeyHex": (b"\x51\x20" + program).hex(),
        "networkIdentityVerified": False,
        "nativeConsensusVerified": False,
        "qualified": False,
        "canFund": False,
        "canSign": False,
        "canBroadcast": False,
        "automaticSettlementSupported": False,
    }
