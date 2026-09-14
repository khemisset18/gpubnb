"""Recovery-policy helpers for Host supervisor loops."""
from __future__ import annotations

from .host_tunnel import (
    BACKOFF_JITTER_MIN,
    BACKOFF_JITTER_SPAN,
    HostTunnelSupervisor,
    RetryState,
)
from .recovery_policy import classify_supervisor_exception, recovery_decision

PLATFORM_REPROBE_SECONDS = 60.0
MAX_RETRY_SECONDS = 300.0


def supervisor_wait(
    exc: BaseException,
    attempt: int,
    *,
    subsystem: str,
) -> tuple[str, str, float | None]:
    reason = classify_supervisor_exception(exc, subsystem=subsystem)  # type: ignore[arg-type]
    decision = recovery_decision(reason, attempt)
    delay = (
        float(decision.retry_after_seconds)
        if decision.retry_after_seconds is not None
        else None
    )
    return decision.mode, decision.reason, delay


class PolicyHostTunnelSupervisor(HostTunnelSupervisor):
    """Keep tunnel retries on the same central bounded schedule as the Host."""

    def _record_failure(self, session_id: str) -> None:
        state = self.retries.setdefault(session_id, RetryState())
        state.failures += 1
        decision = recovery_decision("tunnel_disconnected", state.failures - 1)
        delay = float(decision.retry_after_seconds or MAX_RETRY_SECONDS)
        jitter = BACKOFF_JITTER_MIN + BACKOFF_JITTER_SPAN * self._random()
        state.retry_at = self._clock() + min(MAX_RETRY_SECONDS, delay * jitter)
