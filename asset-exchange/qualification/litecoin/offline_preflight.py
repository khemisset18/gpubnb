"""Fail-closed, PUBLIC synthetic Litecoin transparent request review.

No Litecoin Core, node, RPC, networking, wallet, secret material, signatures,
transaction creation, funding, broadcasting, or settlement functionality.

A successful check DOES NOT authenticate the request's origin, prove Litecoin
consensus/standardness, or qualify the protocol, hardware, or real funds.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

DOMAIN = "GPUbnb:LTC:OFFLINE_LAB_REVIEW:v1"
PROTOCOL = "LTC_BASECHAIN_TRANSPARENT_V1"
# Conservative representational guard only; not live chain consensus evidence.
MAX_LITOSHI = 84_000_000 * 100_000_000
MAX_JSON_BYTES = 8_192
SEQUENCE_NONFINAL_CANDIDATE = 0xFFFFFFFE

ROOT_KEYS = frozenset({"schemaVersion", "kind", "domain", "chainId", "network",
                       "asset", "protocolVersion", "review", "privacy", "permissions"})
REVIEW_KEYS = frozenset({"inputLitoshi", "feeLitoshi", "refundLitoshi",
                         "maximumFeeLitoshi", "minimumRefundLitoshi",
                         "refundLockHeight", "sequence", "sighash",
                         "refundDestinationScriptHex", "fundingTxid", "fundingVout"})
PRIVACY_KEYS = frozenset({"mwebInput", "mwebOutput", "mwebChange",
                          "mwebPegIn", "mwebPegOut", "mwebRecovery"})
PERMISSION_KEYS = frozenset({"canSign", "canBroadcast", "canFund", "hardwareQualified",
                             "automaticSettlementSupported", "realFundsUsed"})


class Refused(ValueError):
    """Untrusted request violates a conservative offline-only laboratory rule."""


def _exact_fields(value: Any, fields: frozenset[str], label: str) -> dict:
    if type(value) is not dict or set(value) != fields:
        raise Refused(f"{label}: schema mismatch")
    return value


def _exact(value: Any, expected: Any, name: str) -> None:
    if type(value) is not type(expected) or value != expected:
        raise Refused(f"{name}: not allowed")


def _positive_litoshi(value: Any, name: str) -> int:
    if type(value) is not str or not value.isascii() or not value.isdecimal():
        raise Refused(f"{name}: must be a canonical decimal string")
    if len(value) > 16 or value[0] == "0":
        raise Refused(f"{name}: noncanonical or out of range")
    amount = int(value)
    if not 0 < amount <= MAX_LITOSHI:
        raise Refused(f"{name}: out of range")
    return amount


def _hex_bytes(value: Any, expected_len: int, name: str) -> bytes:
    if type(value) is not str or len(value) != expected_len * 2:
        raise Refused(f"{name}: wrong length or type")
    if any(c not in "0123456789abcdef" for c in value):
        raise Refused(f"{name}: noncanonical hex")
    return bytes.fromhex(value)


def _reject_pairs_duplicate(pairs: list[tuple[str, Any]]) -> dict:
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise Refused("duplicate JSON key")
        obj[key] = value
    return obj


def _reject_constant(_value: str) -> None:
    raise Refused("nonfinite JSON number")


def parse_request(raw: bytes) -> dict:
    """Read only bounded, duplicate-key-free JSON; no I/O or network."""
    if type(raw) is not bytes or not 0 < len(raw) <= MAX_JSON_BYTES:
        raise Refused("JSON size or type")
    try:
        obj = json.loads(raw.decode("utf-8", errors="strict"),
                         object_pairs_hook=_reject_pairs_duplicate,
                         parse_constant=_reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as err:
        raise Refused("invalid JSON") from err
    validate_request(obj)
    return obj


def validate_request(obj: Any) -> dict:
    """Check exact test-only scope; never confers spend/sign/broadcast permission."""
    root = _exact_fields(obj, ROOT_KEYS, "request")
    for key, expected in (
        ("schemaVersion", 1), ("kind", "SYNTHETIC_PUBLIC_NONEXECUTABLE"),
        ("domain", DOMAIN), ("chainId", "litecoin"), ("network", "regtest"),
        ("asset", "LTC"), ("protocolVersion", PROTOCOL)
    ):
        _exact(root[key], expected, key)

    privacy = _exact_fields(root["privacy"], PRIVACY_KEYS, "privacy")
    for name in PRIVACY_KEYS:
        _exact(privacy[name], False, name)
    perms = _exact_fields(root["permissions"], PERMISSION_KEYS, "permissions")
    for name in PERMISSION_KEYS:
        _exact(perms[name], False, name)

    review = _exact_fields(root["review"], REVIEW_KEYS, "review")
    amount = _positive_litoshi(review["inputLitoshi"], "inputLitoshi")
    fee = _positive_litoshi(review["feeLitoshi"], "feeLitoshi")
    refund = _positive_litoshi(review["refundLitoshi"], "refundLitoshi")
    maximum_fee = _positive_litoshi(review["maximumFeeLitoshi"], "maximumFeeLitoshi")
    minimum_refund = _positive_litoshi(review["minimumRefundLitoshi"], "minimumRefundLitoshi")
    if fee >= amount or amount - fee != refund:
        raise Refused("amount arithmetic inconsistent")
    if fee > maximum_fee or refund < minimum_refund or maximum_fee >= amount:
        raise Refused("fee/refund budget exceeded")

    height = review["refundLockHeight"]
    if type(height) is not int or not 1 <= height < 500_000_000:
        raise Refused("refundLockHeight: candidate height domain only")
    _exact(review["sequence"], SEQUENCE_NONFINAL_CANDIDATE, "sequence")
    _exact(review["sighash"], "ALL", "sighash")
    txid = _hex_bytes(review["fundingTxid"], 32, "fundingTxid")
    if txid == bytes(32):
        raise Refused("fundingTxid: null outpoint")
    vout = review["fundingVout"]
    if type(vout) is not int or not 0 <= vout <= 0xFFFFFFFE:
        raise Refused("fundingVout: out of range")
    # A P2WPKH-shaped *public refund destination fixture* only. This does not
    # establish a P2WSH HTLC, address ownership, native policy, or MWEB exclusion.
    script = _hex_bytes(review["refundDestinationScriptHex"], 22, "refundDestinationScriptHex")
    if script[:2] != b"\x00\x14" or script[2:] == bytes(20):
        raise Refused("refundDestinationScriptHex: unsupported synthetic shape")

    canonical = json.dumps(root, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True, allow_nan=False).encode("ascii")
    return {
        "requestSha256": hashlib.sha256(canonical).hexdigest(),
        "classification": "SOFTWARE_REQUEST_PREFLIGHT_PASS_HARDWARE_BLOCKED",
        "qualified": False,
        "networkIdentityVerified": False,
        "nativeConsensusVerified": False,
        "sourceAuthenticityVerified": False,
        "canSign": False,
        "canBroadcast": False,
        "hardwareQualified": False,
        "automaticSettlementSupported": False,
        "realFundsUsed": False,
    }


def main() -> int:
    # Deliberately process only a bundled public synthetic fixture; never
    # accept a wallet path, arbitrary CLI transaction or external network URL.
    path = Path(__file__).with_name("fixtures") / "transparent_request_v1.json"
    try:
        value = validate_request(parse_request(path.read_bytes()))
    except (OSError, Refused) as exc:
        print(json.dumps({"classification": "REFUSED", "error": str(exc),
                          "canSign": False, "canBroadcast": False}))
        return 1
    print(json.dumps(value, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
