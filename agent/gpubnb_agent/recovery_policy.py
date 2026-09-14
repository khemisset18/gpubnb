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
    # Exact physical-GPU quiescence failures are intentionally transient. They
    # are not authority failures and already fail closed before Docker starts.
    "rental_gpu_compute_processes_present",
    "rental_gpu_utilization_not_quiescent",
    "rental_gpu_memory_not_quiescent",
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
    "agent_auth_rejected",
    "machine_quarantined",
    "hardware_identity_changed",
    "release_protocol_incompatible",
})

STOP_FAILURES = frozenset({
    "invalid_server_signature",
    "local_identity_corrupt",
    "unsafe_runtime_state",
})

_ALL_KNOWN_FAILURES = (
    RECOVERABLE_FAILURES
    | OWNER_ACTION_FAILURES
    | PLATFORM_ACTION_FAILURES
    | STOP_FAILURES
)


def bounded_backoff_seconds(attempt: int) -> int:
    """5s, 10s, 20s, 40s, 80s, 160s, then capped at 300s."""
    attempt = max(0, int(attempt))
    return min(300, 5 * (2 ** min(attempt, 6)))


def classify_supervisor_exception(
    exc: BaseException,
    *,
    subsystem: Literal["heartbeat", "gateway", "tunnel"] = "heartbeat",
) -> str:
    """Translate only unambiguous runtime failures into policy reasons.

    Unknown messages intentionally remain ``unknown_failure`` instead of being
    guessed into a retryable class. That is the fail-closed boundary #211 needs:
    a brand-new runtime failure must never become an automatic hot retry merely
    because it happened inside a supervisor loop.
    """
    text = f"{type(exc).__name__}:{exc}".strip().lower()

    # Prefer explicit stable reason tokens emitted by Agent/API code.
    for reason in sorted(_ALL_KNOWN_FAILURES, key=len, reverse=True):
        if reason in text:
            return reason

    # Generic signed-Agent rejection does not tell the Host whether the cause is
    # quarantine, revocation or another server-side identity state. Treat it as
    # platform action and never clear/rotate anything locally.
    if "invalid_agent_request" in text or "agent authentication rejected" in text:
        return "agent_auth_rejected"

    # Invalid/scope-mismatched Host tunnel authority is an unsafe ambiguity, not
    # a transport outage. The legacy gateway can remain isolated, but this
    # supervisor must not automatically retry the ambiguous authority forever.
    if "host_tunnel_bootstrap_" in text and any(
        marker in text
        for marker in (
            "_signature_invalid",
            "_scope_mismatch",
            "_protocol_invalid",
            "_private_key_leak",
            "_binding_invalid",
        )
    ):
        return "unsafe_runtime_state"

    # Missing docker.exe is only inferred in the gateway/tunnel context. A
    # FileNotFoundError in heartbeat inventory could refer to unrelated tooling.
    if subsystem in {"gateway", "tunnel"} and isinstance(exc, FileNotFoundError):
        return "docker_not_installed"

    if any(
        marker in text
        for marker in (
            "docker desktop is starting",
            "docker engine is starting",
            "docker is starting",
        )
    ):
        return "docker_starting"

    if "docker" in text and any(
        marker in text
        for marker in (
            "error during connect",
            "cannot connect to the docker daemon",
            "docker daemon is not running",
            "docker daemon is unavailable",
            "dockerdesktoplinuxengine",
            "docker_engine",
            "open //./pipe/docker",
        )
    ):
        return "docker_daemon_unreachable"

    if isinstance(exc, TimeoutError) or any(
        marker in text for marker in ("timed out", "timeout", "time-out")
    ):
        return "api_timeout"

    if any(
        marker in text
        for marker in (
            "api http 429",
            "api http 500",
            "api http 502",
            "api http 503",
            "api http 504",
        )
    ):
        return "api_unavailable"

    if any(
        marker in text
        for marker in (
            "temporary failure in name resolution",
            "name or service not known",
            "getaddrinfo failed",
            "network is unreachable",
            "connection refused",
            "connection reset",
            "connection aborted",
            "remote end closed connection",
        )
    ):
        return "network_unreachable"

    if subsystem == "tunnel" and any(
        marker in text for marker in ("quic", "tunnel", "edge connection")
    ):
        return "tunnel_disconnected"

    return "unknown_failure"


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
