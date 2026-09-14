"""Recovery-policy helpers for Host supervisor loops."""
from __future__ import annotations

from .recovery_policy import classify_supervisor_exception, recovery_decision

PLATFORM_REPROBE_SECONDS = 60.0


def supervisor_wait(exc: BaseException, attempt: int, *, subsystem: str) -> tuple[str, str, float | None]:
    reason = classify_supervisor_exception(exc, subsystem=subsystem)  # type: ignore[arg-type]
    decision = recovery_decision(reason, attempt)
    delay = float(decision.retry_after_seconds) if decision.retry_after_seconds is not None else None
    return decision.mode, decision.reason, delay
