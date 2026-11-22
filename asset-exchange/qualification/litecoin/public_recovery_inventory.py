"""LTC L6 public *inventory* checker, NOT an independent recovery bundle.

Only synthetic public data. No unsigned or signed transaction, witness, key
material, wallet, seed, node, RPC, network, storage, or recovery execution.
An internally consistent inventory is NOT authenticated or recoverable.
"""
from __future__ import annotations

import hashlib
import json

from candidate_htlc import ScriptRefused, inspect_synthetic_htlc_script
from offline_preflight import Refused, validate_request

DOMAIN = "GPUbnb:LTC:PUBLIC_RECOVERY_INVENTORY:regtest:v1"
GENESIS = "530827f38f93b43ed12af0b3ad25a288dc02ed74d6d7857862df51fc56c416f9"
SOURCE_COMMIT = "ec1b6489a900d09cf5991e220dce089c77a232a2"
MAX_INVENTORY_BYTES = 8192


class InventoryRefused(ValueError):
    """No fallback for malformed or inconsistent public inventory data."""


def _canonical(value) -> bytes:
    try:
        encoded = json.dumps(value, ensure_ascii=True, allow_nan=False,
                             separators=(",", ":"), sort_keys=True).encode("ascii")
    except (TypeError, ValueError, OverflowError, RecursionError) as err:
        raise InventoryRefused("inventory: invalid JSON value") from err
    if not 0 < len(encoded) <= MAX_INVENTORY_BYTES:
        raise InventoryRefused("inventory: size exceeded")
    return encoded


def make_synthetic_inventory(request: dict, candidate_script: bytes) -> dict:
    """Build a PUBLIC non-executable checklist from synthetic inputs."""
    try:
        review = validate_request(request)
        candidate = inspect_synthetic_htlc_script(candidate_script)
    except (Refused, ScriptRefused, TypeError, ValueError) as err:
        raise InventoryRefused("invalid synthetic public input") from err

    r = request["review"]
    if r["refundLockHeight"] != candidate["refundHeight"]:
        raise InventoryRefused("refund height differs from candidate script")

    inventory = {
        "schemaVersion": 1,
        "kind": "PUBLIC_SYNTHETIC_INVENTORY_NOT_A_RECOVERY_BUNDLE",
        "domain": DOMAIN,
        "asset": "LTC",
        "chainId": "litecoin",
        "network": "regtest",
        "protocolVersion": "LTC_BASECHAIN_TRANSPARENT_V1",
        "source": {
            "coreVersion": "v0.21.5.8",
            "sourceCommit": SOURCE_COMMIT,
            "genesis": GENESIS,
        },
        "requestSha256": review["requestSha256"],
        "candidateScriptHex": candidate["scriptHex"],
        "candidateP2wshScriptPubKeyHex": candidate["p2wshScriptPubKeyHex"],
        "refundHeight": candidate["refundHeight"],
        "refundDestinationScriptHex": r["refundDestinationScriptHex"],
        "syntheticOutpoint": {
            "fundingTxid": r["fundingTxid"],
            "fundingVout": r["fundingVout"],
        },
        "syntheticAmounts": {
            "inputLitoshi": r["inputLitoshi"],
            "feeLitoshi": r["feeLitoshi"],
            "refundLitoshi": r["refundLitoshi"],
        },
        "permissions": {
            "canSign": False,
            "canBroadcast": False,
            "canRecover": False,
            "canFund": False,
            "automaticSettlementSupported": False,
        },
    }
    _canonical(inventory)
    return inventory


def inspect_synthetic_inventory(request: dict, candidate_script: bytes,
                                inventory: dict) -> dict:
    """Exact schema and cross-reference, not origin authentication."""
    if type(inventory) is not dict:
        raise InventoryRefused("inventory: expected JSON object")
    expected = make_synthetic_inventory(request, candidate_script)
    candidate_bytes = _canonical(inventory)
    if candidate_bytes != _canonical(expected):
        raise InventoryRefused("inventory: contents do not match synthetic sources")
    return {
        "classification": "PUBLIC_SYNTHETIC_INVENTORY_CONSISTENT_ONLY",
        "inventorySha256": hashlib.sha256(candidate_bytes).hexdigest(),
        "provenanceAuthenticated": False,
        "nativeRecoveryVerified": False,
        "independentRecoveryAvailable": False,
        "qualified": False,
        "canRecover": False,
        "canSign": False,
        "canBroadcast": False,
        "automaticSettlementSupported": False,
    }
