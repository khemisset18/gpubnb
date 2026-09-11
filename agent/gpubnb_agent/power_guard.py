"""Keep a Windows GPUbnb host awake while server-owned rental authority is live.

This deliberately does *not* change the user's Windows power plan and does not keep
the display awake.  The Agent only asserts ES_SYSTEM_REQUIRED while the control
plane reports at least one rental-authority session for this machine.  A user can
still explicitly sleep, reboot or shut down the PC.

Authority failures are fail-safe: once a rental has acquired the guard, a transient
network/API failure never releases it.  The guard is released only after a
successful authority read proves there are no live rental sessions, or when the
Windows service itself is stopping.
"""
from __future__ import annotations

import ctypes
import os
import threading
from typing import Any, Callable

from .client import ApiClient, agent_request
from .gpu_rental_preemption import parse_rental_authority_sessions
from .storage import load_config, load_key

DEFAULT_API = "https://gpubnb.netlify.app/api"
ES_SYSTEM_REQUIRED = 0x00000001
ES_CONTINUOUS = 0x80000000
POWER_GUARD_INTERVAL_SECONDS = 10

EventSink = Callable[[dict[str, Any]], None]
ExecutionStateWriter = Callable[[int], None]
AuthorityLoader = Callable[[], int]


def _write_windows_execution_state(flags: int) -> None:
    if os.name != "nt":
        raise RuntimeError("power_guard_windows_only")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    set_execution_state = kernel32.SetThreadExecutionState
    set_execution_state.argtypes = [ctypes.c_uint]
    set_execution_state.restype = ctypes.c_uint
    if int(set_execution_state(flags)) == 0:
        error = ctypes.get_last_error()
        raise OSError(error, "SetThreadExecutionState failed")


class SystemAwakeGuard:
    """Thread-owned Windows execution-state guard.

    SetThreadExecutionState is intentionally called from the same long-lived guard
    thread for acquire and release.  ES_DISPLAY_REQUIRED is never asserted, so the
    monitor may still turn off normally while the rented GPU stays available.
    """

    def __init__(self, writer: ExecutionStateWriter | None = None) -> None:
        self._writer = writer or _write_windows_execution_state
        self._active = False

    @property
    def active(self) -> bool:
        return self._active

    def set_required(self, required: bool) -> bool:
        required = bool(required)
        if required == self._active:
            return False
        flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if required else ES_CONTINUOUS
        self._writer(flags)
        self._active = required
        return True

    def close(self) -> None:
        if self._active:
            self._writer(ES_CONTINUOUS)
            self._active = False


def _active_rental_count() -> int:
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str) or not machine_id:
        raise RuntimeError("machine_not_linked")
    key = load_key()
    api = ApiClient(str(config.get("apiUrl") or DEFAULT_API), config.get("caFile"))
    payload = agent_request(
        api,
        key,
        machine_id,
        f"/agent/mining/{machine_id}/rental-authority",
    )
    authority = parse_rental_authority_sessions(payload)
    return len(authority)


def reconcile_power_guard_once(
    guard: SystemAwakeGuard,
    authority_loader: AuthorityLoader = _active_rental_count,
    event_sink: EventSink | None = None,
) -> bool:
    emit = event_sink or (lambda _event: None)
    try:
        active_rentals = max(0, int(authority_loader()))
    except Exception as exc:
        # Critical invariant: an unavailable authority must never turn an already
        # protected paid rental into an unprotected one.  Keep the current state.
        emit({
            "event": "rental_power_guard_authority_error",
            "type": type(exc).__name__,
            "message": str(exc)[:300],
            "guardActive": guard.active,
        })
        return guard.active

    required = active_rentals > 0
    try:
        changed = guard.set_required(required)
    except Exception as exc:
        emit({
            "event": "rental_power_guard_state_error",
            "type": type(exc).__name__,
            "message": str(exc)[:300],
            "requested": required,
            "guardActive": guard.active,
        })
        return guard.active

    if changed:
        emit({
            "event": "rental_power_guard_acquired" if required else "rental_power_guard_released",
            "activeRentals": active_rentals,
        })
    return guard.active


def run_rental_power_guard(
    stop_event: threading.Event,
    event_sink: EventSink | None = None,
    interval_seconds: int = POWER_GUARD_INTERVAL_SECONDS,
    authority_loader: AuthorityLoader = _active_rental_count,
    writer: ExecutionStateWriter | None = None,
) -> None:
    """Run until the Windows service stops, then always release our sleep request."""
    emit = event_sink or (lambda _event: None)
    if os.name != "nt" and writer is None:
        return
    guard = SystemAwakeGuard(writer=writer)
    emit({"event": "rental_power_guard_started", "intervalSeconds": interval_seconds})
    try:
        while not stop_event.is_set():
            reconcile_power_guard_once(guard, authority_loader=authority_loader, event_sink=emit)
            if stop_event.wait(max(1, int(interval_seconds))):
                break
    finally:
        try:
            was_active = guard.active
            guard.close()
            if was_active:
                emit({"event": "rental_power_guard_released", "reason": "service_stopping"})
        except Exception as exc:
            emit({
                "event": "rental_power_guard_release_error",
                "type": type(exc).__name__,
                "message": str(exc)[:300],
            })
        emit({"event": "rental_power_guard_stopped"})
