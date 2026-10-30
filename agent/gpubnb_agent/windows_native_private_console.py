"""Fail-closed authorization for private Windows console capture.

Only an authenticated server-issued native desired session, a private local
opt-in, and the Agent's exact compiled source commit may select this backend.
Never select console from a listing, GPU model, or an untrusted web request.
"""
from __future__ import annotations

import os
import re
import threading
import weakref
from typing import Any, Mapping

from ._build_info import BUILD_COMMIT

_SHA40 = re.compile(r"^[0-9a-fA-F]{40}$")
CONSOLE_BACKEND = "console-dedicated"
IDDCX_BACKEND = "iddcx"

# A WTS session transition on the provider PC invalidates every console
# capture authorization in this Agent process. Clearing this fence requires
# an explicit service restart; never rearm on unlock/login alone.
_SESSION_CHANGE_FENCE = threading.Event()
# WTS HandlerEx must not perform socket, API, or service operations. Wake the
# interested gateway supervisors; their guardian threads close channels and
# request physical STOP outside the SCM control callback.
_FENCE_WAKEUPS: weakref.WeakSet[threading.Event] = weakref.WeakSet()
_FENCE_WAKEUPS_LOCK = threading.Lock()


def register_console_fence_wakeup(wakeup: threading.Event) -> None:
    with _FENCE_WAKEUPS_LOCK:
        _FENCE_WAKEUPS.add(wakeup)
        if _SESSION_CHANGE_FENCE.is_set():
            wakeup.set()


def fence_console_on_session_change() -> None:
    _SESSION_CHANGE_FENCE.set()
    with _FENCE_WAKEUPS_LOCK:
        for wakeup in tuple(_FENCE_WAKEUPS):
            wakeup.set()


def console_session_change_fenced() -> bool:
    return _SESSION_CHANGE_FENCE.is_set()


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
    if console_session_change_fenced():
        raise RuntimeError("native_console_session_change_fenced")
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
