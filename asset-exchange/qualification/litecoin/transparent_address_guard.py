"""Litecoin regtest transparent-address classifier, pure data processing only.

BIP173 SegWit v0 Bech32; restrict deliberately to canonical lowercase rltc
and v0 P2WPKH (20-byte) / P2WSH (32-byte) shapes. No key, signing,
node, wallet, network or real-funds capability. MWEB and other network
addresses fail closed. Passing this check DOES NOT prove spendability,
ownership, script consensus, or absence of MWEB in any upstream transaction.
"""

from __future__ import annotations

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
CHARSET_INDEX = {c: i for i, c in enumerate(CHARSET)}
GENERATOR = (0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)


class AddressRefused(ValueError):
    """Invalid or unsupported address; no permissive fallback."""


def _polymod(values: list[int]) -> int:
    chk = 1
    for value in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= GENERATOR[i]
    return chk


def _expand_hrp(hrp: str) -> list[int]:
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _decode_program(values: list[int]) -> bytes:
    accumulator, bits = 0, 0
    result = bytearray()
    for value in values:
        if not 0 <= value <= 31:
            raise AddressRefused('invalid witness encoding')
        accumulator = ((accumulator << 5) | value) & 0xfff
        bits += 5
        while bits >= 8:
            bits -= 8
            result.append((accumulator >> bits) & 0xff)
    # BIP173 ConvertBits with pad=False: leftover bits must be < 5 and all zero.
    if bits >= 5 or ((accumulator << (8 - bits)) & 0xff) != 0:
        raise AddressRefused('noncanonical witness padding')
    return bytes(result)


def classify_regtest_transparent(address: str) -> dict:
    """Reject everything except valid lowercase Litecoin regtest v0 Bech32.

    This function classifies *a single string*. It never inspects wallet
    transactions, guarantees MWEB exclusion on chain, or authorizes spending.
    """
    if type(address) is not str or not 8 <= len(address) <= 90:
        raise AddressRefused('invalid address size or type')
    if any(ord(ch) < 33 or ord(ch) > 126 for ch in address):
        raise AddressRefused('non-ASCII or whitespace address')
    # The lowercase-only rule intentionally excludes mixed case and uppercase.
    if address != address.lower():
        raise AddressRefused('noncanonical address case')
    separator = address.rfind('1')
    if separator <= 0 or separator + 7 > len(address):
        raise AddressRefused('invalid separator or checksum length')
    hrp = address[:separator]
    if hrp != 'rltc':
        raise AddressRefused('not an LTC transparent regtest address')
    try:
        words = [CHARSET_INDEX[ch] for ch in address[separator + 1:]]
    except KeyError as exc:
        raise AddressRefused('invalid Bech32 alphabet') from exc
    if _polymod(_expand_hrp(hrp) + words) != 1:
        raise AddressRefused('invalid Bech32 v0 checksum')
    data = words[:-6]
    if not data or data[0] != 0:
        raise AddressRefused('unsupported witness version')
    program = _decode_program(data[1:])
    if len(program) not in (20, 32):
        raise AddressRefused('unsupported v0 witness program length')
    return {
        'classification': 'TRANSPARENT_REGTEST_V0_ADDRESS_SHAPE_ONLY',
        'network': 'regtest',
        'scriptPubKeyHex': (bytes([0, len(program)]) + program).hex(),
        'qualified': False,
        'mwebExcludedInFullTransaction': False,
        'canSign': False,
        'canBroadcast': False,
        'automaticSettlementSupported': False,
    }
