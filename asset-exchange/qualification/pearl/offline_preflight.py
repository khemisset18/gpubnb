"""Pure JSON review of a *fictional*, never-posted PRL marketplace offer.

No API, exchange publication, wallet, key, signature, chain, RPC, node,
transactions, funds, or network. Not an executable offer or settlement path.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

DOMAIN = "GPUbnb:PRL:OFFLINE_MARKETPLACE_REVIEW:v1"
MAX_INPUT = 8192
ROOT = frozenset({"schemaVersion", "kind", "domain", "chainId", "network",
                  "assetSymbol", "protocolVersion", "offer", "permissions"})
OFFER = frozenset({"side", "offeredGrains", "requestedAsset", "requestedAtoms",
                   "listingMode", "syntheticOnly"})
PERMS = frozenset({"canPostOffer", "canTakeOffer", "canFund", "canSign",
                   "canBroadcast", "canSettle", "automaticSettlementSupported",
                   "realFundsUsed"})


class Refused(ValueError):
    """Fail closed on any unknown or ambiguous synthetic proposal data."""


def _pairs(pairs):
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise Refused("duplicate JSON field")
        obj[k] = v
    return obj


def _no_constant(_):
    raise Refused("non-finite JSON number")


def _fields(value: Any, expected: frozenset[str], name: str) -> dict:
    if type(value) is not dict or set(value) != expected:
        raise Refused(name + " schema mismatch")
    return value


def _fixed(value: Any, expected: Any, name: str) -> None:
    if type(value) is not type(expected) or value != expected:
        raise Refused(name + " not allowed")


def _atoms(value: Any, name: str) -> int:
    if (type(value) is not str or not value.isascii() or not value.isdecimal()
            or not 1 <= len(value) <= 16 or value.startswith("0")):
        raise Refused(name + " not canonical decimal atoms")
    num = int(value)
    # PRL supply and quote-asset constraints NOT consensus-qualified.
    # A small synthetic cap solely bounds parser inputs, not asset supply.
    if not 1 <= num <= 10**15:
        raise Refused(name + " exceeds synthetic limit")
    return num


def parse_public_request(raw: bytes) -> dict:
    if type(raw) is not bytes or not 0 < len(raw) <= MAX_INPUT:
        raise Refused("invalid JSON size or type")
    try:
        obj = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=_pairs,
                         parse_constant=_no_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise Refused("invalid JSON") from exc
    inspect_public_request(obj)
    return obj


def inspect_public_request(value: Any) -> dict:
    root = _fields(value, ROOT, "root")
    for field, expected in (("schemaVersion", 1),
                            ("kind", "SYNTHETIC_NONEXECUTABLE_PUBLIC_OFFER"),
                            ("domain", DOMAIN), ("chainId", "pearl"),
                            ("network", "regtest"), ("assetSymbol", "PRL"),
                            ("protocolVersion", "PRL_MARKETPLACE_RESEARCH_V1")):
        _fixed(root[field], expected, field)
    offer = _fields(root["offer"], OFFER, "offer")
    for field, expected in (("side", "OFFER_PRL"),
                            ("requestedAsset", "DOGE"),
                            ("listingMode", "PUBLIC_DISCOVERY_FIXTURE_ONLY"),
                            ("syntheticOnly", True)):
        _fixed(offer[field], expected, field)
    _atoms(offer["offeredGrains"], "offeredGrains")
    _atoms(offer["requestedAtoms"], "requestedAtoms")
    perms = _fields(root["permissions"], PERMS, "permissions")
    for field in PERMS:
        _fixed(perms[field], False, field)
    canonical = json.dumps(root, sort_keys=True, separators=(",", ":"),
                           allow_nan=False, ensure_ascii=True).encode("ascii")
    return {
        "classification": "PUBLIC_PRL_SYNTHETIC_OFFER_SHAPE_PASS_ONLY",
        "requestSha256": hashlib.sha256(canonical).hexdigest(),
        "networkIdentityVerified": False,
        "upstreamProtocolQualified": False,
        "nativeConsensusVerified": False,
        "realMarketplaceOfferPosted": False,
        "qualified": False,
        "canPostOffer": False,
        "canTakeOffer": False,
        "canFund": False,
        "canSign": False,
        "canBroadcast": False,
        "automaticSettlementSupported": False,
    }
