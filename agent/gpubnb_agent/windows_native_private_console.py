"""Fail-closed authorization for private Windows console capture.

Only an authenticated server-issued native desired session, a private local
opt-in, and the Agent's exact compiled source commit may select this backend.
Never select console from a listing, GPU model, or an untrusted web request.
"""
from __future__ import annotations

import os
import re
from typing import Any, Mapping

from ._build_info import BUILD_COMMIT

_SHA40 = re.compile(r"^[0-9a-fA-F]{40}$")
CONSOLE_BACKEND = "console-dedicated"
IDDCX_BACKEND = "iddcx"


def selected_capture_backend(
    desired_session: Mapping[str, Any],
    *,
    local_opt_in: bool | None = None,
    build_commit: str = BUILD_COMMIT,
) -> str:
    backend = desired_session.get("captureBackend")
    if backend is None or backend == IDDCX_BACKEND:
        # Never accept a pin with a missing/legacy backend marker.
        if desired_session.get("consoleAgentCommit") is not None:
            raise RuntimeError("native_console_authority_malformed")
        return IDDCX_BACKEND

    if backend != CONSOLE_BACKEND:
        raise RuntimeError("native_capture_backend_unsupported")

    if local_opt_in is None:
        local_opt_in = os.environ.get("GPUBNB_PRIVATE_CONSOLE_QUALIFICATION") == "true"
    if local_opt_in is not True:
        raise RuntimeError("native_console_local_opt_in_required")
    if desired_session.get("runtimeBackend") != "WINDOWS_NATIVE":
        raise RuntimeError("native_console_runtime_backend_invalid")
    if desired_session.get("workspaceSlug") != "cloud-desktop":
        raise RuntimeError("native_console_workspace_invalid")

    pinned = desired_session.get("consoleAgentCommit")
    if (
        not isinstance(pinned, str)
        or not isinstance(build_commit, str)
        or not _SHA40.fullmatch(build_commit)
        or pinned != build_commit
    ):
        raise RuntimeError("native_console_release_mismatch")
    return CONSOLE_BACKEND
