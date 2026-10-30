"""Unqualified legacy DOGE HTLC byte preparation; no node, native code or signer.

This is a bounded construction/requirements model, NOT a script interpreter,
standardness implementation, transaction planner or qualification decision.
"""
from dataclasses import dataclass
import hashlib

FIELD = 2**256 - 2**32 - 977
LOCKTIME_THRESHOLD = 500_000_000
SEQUENCE_FINAL = 0xFFFFFFFF
SOURCE = "e0a1c157791544e818c901bd9341896965afbf9d"


def uint32(value, name):
    if type(value) is not int or not 0 <= value <= 0xFFFFFFFF:
        raise ValueError("invalid " + name)
    return value


def checked_pubkey(value):
    if type(value) is not bytes or len(value) != 33 or value[0] not in (2, 3):
        raise ValueError("compressed public key required")
    x = int.from_bytes(value[1:], "big")
    if x >= FIELD:
        raise ValueError("public x outside secp256k1 field")
    rhs = (pow(x, 3, FIELD) + 7) % FIELD
    if rhs == 0 or pow(rhs, (FIELD - 1) // 2, FIELD) != 1:
        raise ValueError("public key is not a secp256k1 point")
    return value


def push(data):
    if len(data) > 75:
        raise ValueError("only bounded direct fixture pushes supported")
    return bytes([len(data)]) + data


def minimal_positive_number(value):
    uint32(value, "CLTV operand")
    if value == 0:
        raise ValueError("positive lock required")
    if value <= 16:
        return bytes([0x50 + value])
    data = value.to_bytes((value.bit_length() + 7) // 8, "little")
    if data[-1] & 0x80:
        data += b"\x00"
    return push(data)


@dataclass(frozen=True)
class Candidate:
    redeem: bytes
    output: bytes
    lock: int

    def report(self):
        # Maximum-size DER+sighash placeholder budget ONLY. No signature or
        # spend transaction is constructed, verified or claimed here.
        script_sig_budget = 74 + 33 + 1 + (1 if len(self.redeem) <= 75 else 2) + len(self.redeem)
        return {
            "status": "IMPLEMENTED — NOT QUALIFIED", "qualified": False,
            "qualificationStatus": "BLOCKED", "executableOperations": [],
            "sourceCommit": SOURCE, "redeemHex": self.redeem.hex(), "outputHex": self.output.hex(),
            "redeemSha256": hashlib.sha256(self.redeem).hexdigest(),
            "lock": self.lock, "lockDomain": "height" if self.lock < LOCKTIME_THRESHOLD else "time",
            "redeemBytes": len(self.redeem), "staticSigops": 2,
            "claimScriptSigBudgetBytes": script_sig_budget,
            "missingEvidence": ["positive signature-bound claim", "positive signature-bound refund",
                "full IsStandardTx and AreInputsStandard", "actual standardness-enforced mempool admission",
                "independent reviewed network/profile binding", "runtime finality and consensus flags"],
        }


def build_candidate(commitment, claim_public, refund_public, lock):
    if type(commitment) is not bytes or len(commitment) != 32:
        raise ValueError("exact SHA256 commitment required")
    claim_public, refund_public = checked_pubkey(claim_public), checked_pubkey(refund_public)
    # Compressed encodings differing only in parity are different public keys.
    if claim_public == refund_public:
        raise ValueError("distinct participant public keys required")
    redeem = (b"\x63\x82\x01\x20\x88\xa8" + push(commitment) + b"\x88" +
              push(claim_public) + b"\xac\x67" + minimal_positive_number(lock) + b"\xb1\x75" +
              push(refund_public) + b"\xac\x68")
    digest = hashlib.new("ripemd160", hashlib.sha256(redeem).digest()).digest()
    return Candidate(redeem, b"\xa9\x14" + digest + b"\x87", lock)


def cltv_condition_model(operand, transaction_lock, sequence):
    """Requirements only; activation, flags, scripts and signatures NOT checked."""
    uint32(operand, "operand")
    uint32(transaction_lock, "transaction lock")
    uint32(sequence, "sequence")
    return ((operand < LOCKTIME_THRESHOLD) == (transaction_lock < LOCKTIME_THRESHOLD)
            and operand <= transaction_lock and sequence != SEQUENCE_FINAL)


def finality_model(transaction_lock, sequences, next_height, time_cutoff):
    """Pinned IsFinalTx arithmetic, not CheckFinalTx/mempool execution."""
    uint32(transaction_lock, "transaction lock")
    uint32(next_height, "next height")
    if type(time_cutoff) is not int or time_cutoff < 0:
        raise ValueError("invalid time cutoff")
    if type(sequences) not in (tuple, list) or not sequences or len(sequences) > 16:
        raise ValueError("bounded nonempty sequence list required")
    for value in sequences:
        uint32(value, "sequence")
    cutoff = next_height if transaction_lock < LOCKTIME_THRESHOLD else time_cutoff
    return transaction_lock == 0 or transaction_lock < cutoff or all(s == SEQUENCE_FINAL for s in sequences)
