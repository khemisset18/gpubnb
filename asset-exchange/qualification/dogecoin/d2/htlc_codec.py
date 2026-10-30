"""Strict codec/branch preparation for the unqualified legacy HTLC profile.

No interpreter, ECDSA operation, scriptSig, transaction, native library or RPC.
Acceptance means canonical profile bytes only, never consensus or relay validity.
"""
from dataclasses import dataclass
import hashlib

from offline_candidate import (build_candidate, checked_pubkey, minimal_positive_number,
                               uint32, cltv_condition_model)

PREFIX = bytes.fromhex("6382012088a8")
SEQUENCE = 0xFFFFFFFE  # Version1 prepared profile; no CSV/RBF capability claim.


@dataclass(frozen=True)
class DecodedHtlc:
    commitment: bytes
    claim_public: bytes
    refund_public: bytes
    lock: int
    redeem: bytes
    output: bytes

    def size_budget(self):
        # DER72 + one sighash byte; sizes only, no signature is constructed.
        signature_push = 1 + 73
        redeem_push = (1 if len(self.redeem) <= 75 else 2) + len(self.redeem)
        return {"redeemBytes": len(self.redeem), "staticSigops": 2,
                "claimScriptSigMaxBytes": signature_push + 33 + 1 + redeem_push,
                "refundScriptSigMaxBytes": signature_push + 1 + redeem_push,
                "nativeStandardness": "NOT TESTED", "qualified": False}


class Cursor:
    def __init__(self, raw):
        if type(raw) is not bytes or not 1 <= len(raw) <= 520:
            raise ValueError("bounded redeemScript bytes required")
        self.raw, self.pos = raw, 0

    def take(self, size):
        if self.pos + size > len(self.raw):
            raise ValueError("truncated HTLC template")
        value = self.raw[self.pos:self.pos + size]
        self.pos += size
        return value

    def expect(self, expected):
        if self.take(len(expected)) != expected:
            raise ValueError("noncanonical HTLC opcode or push")

    def fixed_push(self, size):
        self.expect(bytes([size]))
        return self.take(size)

    def lock_number(self):
        start = self.pos
        opcode = self.take(1)[0]
        if 0x51 <= opcode <= 0x60:
            value = opcode - 0x50
        elif 1 <= opcode <= 5:
            raw = self.take(opcode)
            if raw[-1] & 0x80:
                raise ValueError("negative CLTV operand")
            value = int.from_bytes(raw, "little")
        else:
            raise ValueError("canonical positive ScriptNum required")
        if self.raw[start:self.pos] != minimal_positive_number(value):
            raise ValueError("nonminimal ScriptNum or push")
        return value


def decode_htlc(redeem):
    cursor = Cursor(redeem)
    cursor.expect(PREFIX)
    commitment = cursor.fixed_push(32)
    cursor.expect(b"\x88")
    claim = checked_pubkey(cursor.fixed_push(33))
    cursor.expect(b"\xac\x67")
    lock = cursor.lock_number()
    cursor.expect(b"\xb1\x75")
    refund = checked_pubkey(cursor.fixed_push(33))
    cursor.expect(b"\xac\x68")
    if cursor.pos != len(redeem):
        raise ValueError("trailing HTLC bytes")
    candidate = build_candidate(commitment, claim, refund, lock)
    if redeem != candidate.redeem:
        raise ValueError("noncanonical HTLC representation")
    return DecodedHtlc(commitment, claim, refund, lock, redeem, candidate.output)


def bind_htlc(redeem, *, commitment, claim_public, refund_public, lock, output):
    """Bind parsed roles/amount-independent script to separately expected terms."""
    parsed = decode_htlc(redeem)
    expected = build_candidate(commitment, claim_public, refund_public, lock)
    if type(output) is not bytes or output != expected.output or parsed.redeem != expected.redeem:
        raise ValueError("HTLC terms, roles or P2SH output mismatch")
    return parsed


def review_branch(redeem, *, branch, public_key, transaction_lock, sequence, preimage=None):
    """Review profile inputs; no signature is accepted or produced by this API.

    This intentionally narrower preparation policy fixes txLock to0/contractLock
    and sequence to0xfffffffe. Native CLTV permits other nonfinal sequences and
    later locks; this codec never claims those would be consensus-invalid.
    """
    parsed = decode_htlc(redeem)
    uint32(transaction_lock, "transaction lock")
    uint32(sequence, "sequence")
    checked_pubkey(public_key)
    if sequence != SEQUENCE:
        raise ValueError("sequence outside prepared version1 profile")
    if branch == "CLAIM":
        if public_key != parsed.claim_public:
            raise ValueError("claim public role mismatch")
        if type(preimage) is not bytes or len(preimage) != 32 or hashlib.sha256(preimage).digest() != parsed.commitment:
            raise ValueError("claim preimage commitment mismatch")
        if transaction_lock != 0:
            raise ValueError("claim transaction lock outside prepared profile")
        layout = ["SIGNATURE_REQUIRED", "PUBLIC_TEST_PREIMAGE_32_BYTES", "OP_1", "REDEEM_SCRIPT"]
    elif branch == "REFUND":
        if public_key != parsed.refund_public:
            raise ValueError("refund public role mismatch")
        if preimage is not None:
            raise ValueError("refund must not contain preimage material")
        if transaction_lock != parsed.lock or not cltv_condition_model(parsed.lock, transaction_lock, sequence):
            raise ValueError("refund lock outside prepared profile")
        layout = ["SIGNATURE_REQUIRED", "OP_0", "REDEEM_SCRIPT"]
    else:
        raise ValueError("unknown HTLC branch")
    # Never return caller preimage material, serialized spend bytes or a success
    # marker for ECDSA, script execution, policy, transaction finality or funding.
    return {"branch": branch, "stackLayout": layout, "signatureVerified": False,
            "nativeVerified": False, "qualificationStatus": "BLOCKED",
            "executableOperations": [], "transactionBytes": None}
