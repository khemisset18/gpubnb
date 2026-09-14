"""Fail-closed recovery policy for non-rental Host failures.

This module classifies what GPUbnb may retry automatically versus what requires
explicit owner/platform action. It never mutates authority, deletes ProgramData,
clears quarantine, rotates keys or force-cleans server state.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

RecoveryMode = Literal["retry", "owner_action", "platform_action", "stop"]


@dataclass(frozen=True)
class RecoveryDecision:
    mode: RecoveryMode
    reason: str
    retry_after_seconds: int | None = None
    max_attempts: int | None = None


RECOVERABLE_FAILURES = frozenset({
    "network_unreachable",
    "api_timeout",
    "api_unavailable",
    "gateway_disconnected",
    "tunnel_disconnected",
    "docker_starting",
    "docker_daemon_unreachable",
    "heartbeat_worker_exited",
})

OWNER_ACTION_FAILURES = frozenset({
    "docker_not_installed",
    "gpu_driver_missing",
    "nvidia_runtime_missing",
    "disk_space_insufficient",
    "machine_not_linked",
})

PLATFORM_ACTION_FAILURES = frozenset({
    "agent_key_revoked",
    "machine_quarantined",
    "hardware_identity_changed",
    "release_protocol_incompatible",
})

STOP_FAILURES = frozenset({
    "invalid_server_signature",
    "local_identity_corrupt",
    "unsafe_runtime_state",
})


def bounded_backoff_seconds(attempt: int) -> int:
    """5s, 10s, 20s, 40s, 80s, 160s, then capped at 300s."""
    attempt = max(0, int(attempt))
    return min(300, 5 * (2 ** min(attempt, 6)))


def recovery_decision(reason: str, attempt: int = 0) -> RecoveryDecision:
    normalized = str(reason).strip().lower()
    if normalized in RECOVERABLE_FAILURES:
        return RecoveryDecision(
            mode="retry",
            reason=normalized,
            retry_after_seconds=bounded_backoff_seconds(attempt),
            max_attempts=None,
        )
    if normalized in OWNER_ACTION_FAILURES:
        return RecoveryDecision(mode="owner_action", reason=normalized)
    if normalized in PLATFORM_ACTION_FAILURES:
        return RecoveryDecision(mode="platform_action", reason=normalized)
    if normalized in STOP_FAILURES:
        return RecoveryDecision(mode="stop", reason=normalized)
    # Unknown failures must never trigger destructive recovery. A bounded retry
    # would risk hiding a new security/authority bug, so surface it to the owner.
    return RecoveryDecision(mode="owner_action", reason=normalized or "unknown_failure")
