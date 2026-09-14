"""Side-effect-free rollback policy for Agent self-update recovery.

The updater owns service/file operations. This module owns the decision contract:
a candidate is accepted only after the service is running, its installed identity
matches the promoted release, and the post-update runtime probe succeeds. Any
other post-swap outcome requires rollback to the known-good backup.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PostUpdateChecks:
    service_running: bool
    identity_matches_release: bool
    version_matches_candidate: bool
    runtime_healthy: bool

    @property
    def healthy(self) -> bool:
        return (
            self.service_running
            and self.identity_matches_release
            and self.version_matches_candidate
            and self.runtime_healthy
        )


def rollback_reason(checks: PostUpdateChecks) -> str | None:
    if not checks.service_running:
        return "service_not_running"
    if not checks.identity_matches_release:
        return "installed_commit_mismatch"
    if not checks.version_matches_candidate:
        return "installed_version_mismatch"
    if not checks.runtime_healthy:
        return "runtime_health_failed"
    return None


def must_rollback(checks: PostUpdateChecks) -> bool:
    return rollback_reason(checks) is not None
