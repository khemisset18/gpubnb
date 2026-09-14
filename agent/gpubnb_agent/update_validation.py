"""Pure validation helpers for safe Agent self-update decisions.

This module deliberately has no filesystem, network, subprocess or service-control
side effects. It validates the identity reported by a candidate/installed frozen
Agent against the immutable commit advertised by the promoted release channel.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


class UpdateIdentityError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentBuildIdentity:
    version: str
    build_commit: str
    frozen: bool


def parse_build_identity(version: str, build_info: dict[str, Any]) -> AgentBuildIdentity:
    version = str(version).strip()
    info_version = build_info.get("agentVersion")
    commit = build_info.get("buildCommit")
    frozen = build_info.get("frozen")

    if not version:
        raise UpdateIdentityError("candidate_version_empty")
    if not isinstance(info_version, str) or info_version.strip() != version:
        raise UpdateIdentityError("candidate_version_identity_mismatch")
    if frozen is not True:
        raise UpdateIdentityError("candidate_not_frozen")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{12,40}", commit):
        raise UpdateIdentityError("candidate_build_commit_invalid")

    return AgentBuildIdentity(
        version=version,
        build_commit=commit.lower(),
        frozen=True,
    )


def normalize_release_commit(commit: str) -> str:
    value = str(commit).strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise UpdateIdentityError("release_commit_invalid")
    return value


def identity_matches_release(identity: AgentBuildIdentity, release_commit: str) -> bool:
    release = normalize_release_commit(release_commit)
    return release.startswith(identity.build_commit) or identity.build_commit.startswith(release)


def require_identity_matches_release(
    identity: AgentBuildIdentity,
    release_commit: str,
    *,
    stage: str,
) -> None:
    if stage not in {"candidate", "installed"}:
        raise UpdateIdentityError("identity_stage_invalid")
    release = normalize_release_commit(release_commit)
    if not identity_matches_release(identity, release):
        raise UpdateIdentityError(
            f"{stage}_commit_mismatch:release={release}:build={identity.build_commit}"
        )
