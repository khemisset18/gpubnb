"""LTC L7 two-source synthetic observer disagreement model, NO chain connection.

A matching pair of public test dictionaries is not evidence of a real block,
node, independent source, consensus, or finality. The model cannot authorize
signing, refund, settlement, broadcasting, or financial advancement.
"""
from __future__ import annotations

import re

GENESIS = "530827f38f93b43ed12af0b3ad25a288dc02ed74d6d7857862df51fc56c416f9"
FIELDS = frozenset({
    "schemaVersion", "kind", "chainId", "network", "genesis", "sourceLabel",
    "txid", "status", "headHeight", "confirmations", "blockHash",
    "ageSeconds", "mweb",
})
STATUSES = frozenset({"MEMPOOL", "CONFIRMED", "CONFLICTED", "REORGED", "UNKNOWN"})
MAX_AGE_SECONDS = 30


class SnapshotRefused(ValueError):
    """Refuse malformed synthetic snapshots without fallback."""


def _exact(value, expected, name):
    if type(value) is not type(expected) or value != expected:
        raise SnapshotRefused(f"{name}: incompatible synthetic domain")


def _number(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        raise SnapshotRefused(f"{name}: invalid integer")


def _hash(value, name):
    if type(value) is not str or re.fullmatch("[0-9a-f]{64}", value) is None or value == "0" * 64:
        raise SnapshotRefused(f"{name}: invalid lowercase hash")


def _validate(s):
    if type(s) is not dict or set(s) != FIELDS:
        raise SnapshotRefused("snapshot: unknown or missing fields")
    for key, expected in (
        ("schemaVersion", 1), ("kind", "SYNTHETIC_PUBLIC_OBSERVATION"),
        ("chainId", "litecoin"), ("network", "regtest"), ("genesis", GENESIS),
        ("mweb", False),
    ):
        _exact(s[key], expected, key)
    if type(s["sourceLabel"]) is not str or not re.fullmatch("[a-z][a-z0-9_]{0,23}", s["sourceLabel"]):
        raise SnapshotRefused("sourceLabel: invalid")
    _hash(s["txid"], "txid")
    if type(s["status"]) is not str or s["status"] not in STATUSES:
        raise SnapshotRefused("status: unknown")
    _number(s["headHeight"], "headHeight", 0, 499999999)
    _number(s["confirmations"], "confirmations", 0, 500000000)
    _number(s["ageSeconds"], "ageSeconds", 0, 86400)
    if s["status"] == "CONFIRMED":
        if s["confirmations"] < 1 or s["confirmations"] > s["headHeight"] + 1:
            raise SnapshotRefused("CONFIRMED: inconsistent height/confirmations")
        _hash(s["blockHash"], "blockHash")
    elif s["confirmations"] != 0 or s["blockHash"] is not None:
        raise SnapshotRefused("unconfirmed status: no block or confirmations allowed")


def evaluate_synthetic_observers(observations: list[dict]) -> dict:
    """Compare exactly two synthetic observations. No evidence ingestion.

    This is a disagreement detector only. Even a matching confirmed pair
    cannot be trusted without authenticated independent chain evidence.
    """
    if type(observations) is not list or len(observations) != 2:
        raise SnapshotRefused("exactly two fictional observations required")
    a, b = observations
    _validate(a)
    _validate(b)
    if a["sourceLabel"] == b["sourceLabel"]:
        raise SnapshotRefused("same source label is not a two-source scenario")
    if a["txid"] != b["txid"]:
        raise SnapshotRefused("different transaction reference")
    if a["ageSeconds"] > MAX_AGE_SECONDS or b["ageSeconds"] > MAX_AGE_SECONDS:
        phase = "SIMULATED_UNCERTAIN_STALE"
    elif "CONFLICTED" in (a["status"], b["status"]):
        phase = "SIMULATED_UNCERTAIN_CONFLICT"
    elif "REORGED" in (a["status"], b["status"]):
        phase = "SIMULATED_UNCERTAIN_REORG"
    elif "UNKNOWN" in (a["status"], b["status"]):
        phase = "SIMULATED_UNCERTAIN_UNKNOWN"
    elif a["status"] != b["status"]:
        phase = "SIMULATED_UNCERTAIN_STATUS_DISAGREEMENT"
    elif a["headHeight"] != b["headHeight"]:
        phase = "SIMULATED_UNCERTAIN_HEAD_HEIGHT_DISAGREEMENT"
    elif a["confirmations"] != b["confirmations"]:
        phase = "SIMULATED_UNCERTAIN_CONFIRMATION_DISAGREEMENT"
    elif a["blockHash"] != b["blockHash"]:
        phase = "SIMULATED_UNCERTAIN_BLOCK_HASH_DISAGREEMENT"
    elif a["status"] == "CONFIRMED":
        phase = "SIMULATED_MATCHING_CONFIRMED_UNAUTHENTICATED"
    else:
        phase = "SIMULATED_MATCHING_MEMPOOL_UNAUTHENTICATED"
    return {
        "classification": phase,
        "txid": a["txid"],
        "sourceLabelsAreNotIndependenceProof": True,
        "realChainEvidenceVerified": False,
        "realSourceIndependenceVerified": False,
        "nativeReorgVerified": False,
        "qualified": False,
        "canAdvance": False,
        "canRefund": False,
        "canSign": False,
        "canBroadcast": False,
        "automaticSettlementSupported": False,
    }
