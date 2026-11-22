"""Inspection-only proposed Litecoin transparent SegWit-v0 HTLC *script bytes*.

No keys are generated, no signature is produced or checked, no wallet, RPC,
transaction, network, or node logic exists. Only synthetic public parameters.
This NOT an approved HTLC and has not been checked against Litecoin consensus.
"""
from __future__ import annotations

import hashlib

# Bitcoin Script opcode encodings also present in Litecoin's script source.
OP_IF = 0x63
OP_ELSE = 0x67
OP_ENDIF = 0x68
OP_DROP = 0x75
OP_SIZE = 0x82
OP_EQUALVERIFY = 0x88
OP_SHA256 = 0xA8
OP_CHECKSIG = 0xAC
OP_CHECKLOCKTIMEVERIFY = 0xB1

MAX_HEIGHT = 500_000_000  # CLTV's height/time threshold, exclusive


class ScriptRefused(ValueError):
    """Refused malformed or unsupported *test-only* script representation."""


def _bytes_exact(value: object, size: int, name: str) -> bytes:
    if type(value) is not bytes or len(value) != size:
        raise ScriptRefused(f"{name}: expected {size} bytes")
    return value


def _public_key(value: object, name: str) -> bytes:
    key = _bytes_exact(value, 33, name)
    if key[0] not in (2, 3) or key[1:] == bytes(32):
        raise ScriptRefused(f"{name}: invalid compressed public-key shape")
    # Not an on-curve or ownership test: no ECC keys are created or verified.
    return key


def _height_push(height: object) -> bytes:
    if type(height) is not int or not 1 <= height < MAX_HEIGHT:
        raise ScriptRefused("lock height: expected positive block height below threshold")
    if height <= 16:
        return bytes([0x50 + height])
    encoded = height.to_bytes((height.bit_length() + 7) // 8, "little")
    if encoded[-1] & 0x80:
        encoded += b"\x00"  # minimal nonnegative signed-magnitude ScriptNum
    return bytes([len(encoded)]) + encoded


def build_synthetic_htlc_script(secret_hash: bytes, redeem_key: bytes,
                                refund_key: bytes, refund_height: int) -> bytes:
    """Serialize *candidate* bytes, not a signable or broadcastable transaction."""
    secret_hash = _bytes_exact(secret_hash, 32, "secret SHA256 digest")
    if secret_hash == bytes(32):
        raise ScriptRefused("secret SHA256 digest: null synthetic value")
    redeem_key = _public_key(redeem_key, "redeem key")
    refund_key = _public_key(refund_key, "refund key")
    if redeem_key == refund_key:
        raise ScriptRefused("redeem and refund roles cannot share public key")
    height_bytes = _height_push(refund_height)
    # IF: 32-byte SHA256 preimage + redeem pubkey signature check.
    # ELSE: absolute CLTV block-height gate + refund pubkey signature check.
    return (
        bytes([OP_IF, OP_SIZE, 1, 32, OP_EQUALVERIFY,
               OP_SHA256, 32]) + secret_hash +
        bytes([OP_EQUALVERIFY, 33]) + redeem_key +
        bytes([OP_CHECKSIG, OP_ELSE]) + height_bytes +
        bytes([OP_CHECKLOCKTIMEVERIFY, OP_DROP, 33]) + refund_key +
        bytes([OP_CHECKSIG, OP_ENDIF])
    )


def inspect_synthetic_htlc_script(script: bytes) -> dict:
    """Parse exactly the synthetic template; reject unknown ops, extra bytes.

    The structure parser does not execute CLTV, CHECKSIG, SHA256, or script.
    """
    if type(script) is not bytes or len(script) > 256:
        raise ScriptRefused("script bytes: wrong type or oversized")
    pos = 0

    def take(size: int) -> bytes:
        nonlocal pos
        if len(script) - pos < size:
            raise ScriptRefused("script bytes: truncated")
        result = script[pos:pos + size]
        pos += size
        return result

    def expect(*values: int) -> None:
        if take(len(values)) != bytes(values):
            raise ScriptRefused("script bytes: unsupported template")

    expect(OP_IF, OP_SIZE, 1, 32, OP_EQUALVERIFY, OP_SHA256, 32)
    digest = take(32)
    expect(OP_EQUALVERIFY, 33)
    redeem_key = take(33)
    expect(OP_CHECKSIG, OP_ELSE)
    height_start = pos
    opcode = take(1)[0]
    if 0x51 <= opcode <= 0x60:
        height = opcode - 0x50
    elif 1 <= opcode <= 5:
        blob = take(opcode)
        if blob[-1] & 0x80:
            raise ScriptRefused("noncanonical negative lock height")
        height = int.from_bytes(blob, "little")
    else:
        raise ScriptRefused("unsupported ScriptNum push")
    if script[height_start:pos] != _height_push(height):
        raise ScriptRefused("nonminimal ScriptNum push")
    expect(OP_CHECKLOCKTIMEVERIFY, OP_DROP, 33)
    refund_key = take(33)
    expect(OP_CHECKSIG, OP_ENDIF)
    if pos != len(script):
        raise ScriptRefused("trailing script bytes")
    # Re-build exact bytes for consistency and all parameter restrictions.
    if build_synthetic_htlc_script(digest, redeem_key, refund_key, height) != script:
        raise ScriptRefused("noncanonical script")
    return {
        "classification": "SYNTHETIC_LTC_V0_HTLC_BYTES_ONLY",
        "scriptHex": script.hex(),
        "p2wshScriptPubKeyHex": (b"\x00\x20" + hashlib.sha256(script).digest()).hex(),
        "refundHeight": height,
        "redeemPubkeyHex": redeem_key.hex(),
        "refundPubkeyHex": refund_key.hex(),
        "secretHashHex": digest.hex(),
        "nativeConsensusVerified": False,
        "qualified": False,
        "canSign": False,
        "canBroadcast": False,
        "automaticSettlementSupported": False,
    }
