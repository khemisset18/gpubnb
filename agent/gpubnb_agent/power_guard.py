"""Keep an available Windows GPUbnb Host reachable without forcing full activity.

GPUbnb deliberately does not change the owner's Windows power plan and never keeps
the display awake. Windows remains free to turn the monitor off and idle CPU/GPU
hardware normally. The Agent asserts only ES_SYSTEM_REQUIRED while the signed server
power policy says the Host must remain reachable: an owner-available listing or a
live rental/session prevents *system sleep*, while an explicitly paused/offline Host
returns to ordinary Windows sleep behavior.

This is the GPUbnb standby model: the PC can sit idle for hours at normal S0 idle
power, but the Agent/network remain alive so a new rental can start immediately.
Explicit user sleep, reboot and shutdown remain possible.

Authority failures are fail-safe: once protection is active, a transient network/API
failure never releases it. Persisted fenced rental claims can also restore protection
immediately after a service/reboot recovery while signed server state reconnects.
"""
from __future__ import annotations

import ctypes
import os
import threading
from dataclasses import dataclass
from typing import Any, Callable

from .client import ApiClient, agent_request
from .gpu_rental_preemption import RentalClaimStore, parse_rental_authority_sessions
from .storage import load_config, load_key

DEFAULT_API = "https://gpubnb.netlify.app/api"
ES_SYSTEM_REQUIRED = 0x00000001
ES_CONTINUOUS = 0x80000000
POWER_GUARD_INTERVAL_SECONDS = 10
POWER_POLICY_REASONS = frozenset({"live_session", "marketplace_available", "not_available"})

EventSink = Callable[[dict[str, Any]], None]
ExecutionStateWriter = Callable[[int], None]
LocalClaimLoader = Callable[[], int]


@dataclass(frozen=True)
class HostPowerAuthority:
    keep_awake: bool
    reason: str
    live_session_count: int = 0
    availability_listing_count: int = 0


AuthorityLoader = Callable[[], HostPowerAuthority]


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
    thread for acquire and release. ES_DISPLAY_REQUIRED is never asserted, so the
    monitor may still turn off normally while GPUbnb remains remotely reachable.
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


def _client_context() -> tuple[ApiClient, Any, str]:
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str) or not machine_id:
        raise RuntimeError("machine_not_linked")
    key = load_key()
    api = ApiClient(str(config.get("apiUrl") or DEFAULT_API), config.get("caFile"))
    return api, key, machine_id


def _parse_power_policy(payload: dict[str, Any]) -> HostPowerAuthority:
    if payload.get("protocolVersion") != 1:
        raise RuntimeError("host_power_policy_protocol_invalid")
    keep_awake = payload.get("keepAwake")
    reason = payload.get("reason")
    live_sessions = payload.get("liveSessionCount")
    availability_listings = payload.get("availabilityListingCount")
    if not isinstance(keep_awake, bool) or reason not in POWER_POLICY_REASONS:
        raise RuntimeError("host_power_policy_invalid")
    if (
        not isinstance(live_sessions, int)
        or isinstance(live_sessions, bool)
        or live_sessions < 0
        or live_sessions > 1024
        or not isinstance(availability_listings, int)
        or isinstance(availability_listings, bool)
        or availability_listings < 0
        or availability_listings > 1024
    ):
        raise RuntimeError("host_power_policy_invalid")
    if keep_awake != (live_sessions > 0 or availability_listings > 0):
        raise RuntimeError("host_power_policy_inconsistent")
    return HostPowerAuthority(
        keep_awake=keep_awake,
        reason=str(reason),
        live_session_count=live_sessions,
        availability_listing_count=availability_listings,
    )


def _legacy_rental_authority_fallback(
    api: ApiClient,
    key: Any,
    machine_id: str,
) -> HostPowerAuthority:
    """Preserve safe behavior during a staged Agent/API rollout.

    An Agent carrying this feature may briefly run against an API release that does
    not yet expose /power-policy. In that case, fall back to the existing signed
    rental-authority contract. It cannot keep an idle listing awake, but it still
    guarantees that a live paid rental is never made less safe by deployment order.
    """
    payload = agent_request(
        api,
        key,
        machine_id,
        f"/agent/mining/{machine_id}/rental-authority",
    )
    authority = parse_rental_authority_sessions(payload)
    live_sessions = len(authority)
    return HostPowerAuthority(
        keep_awake=live_sessions > 0,
        reason="legacy_live_session" if live_sessions else "legacy_not_available",
        live_session_count=live_sessions,
    )


def _load_host_power_authority() -> HostPowerAuthority:
    api, key, machine_id = _client_context()
    try:
        payload = agent_request(
            api,
            key,
            machine_id,
            f"/agent/host/{machine_id}/power-policy",
        )
        return _parse_power_policy(payload)
    except Exception as policy_error:
        try:
            return _legacy_rental_authority_fallback(api, key, machine_id)
        except Exception as legacy_error:
            raise RuntimeError(
                f"host_power_policy_unavailable:{type(policy_error).__name__}:{type(legacy_error).__name__}"
            ) from legacy_error


def _persisted_rental_claim_count() -> int:
    return len(RentalClaimStore().load())


def reconcile_power_guard_once(
    guard: SystemAwakeGuard,
    authority_loader: AuthorityLoader = _load_host_power_authority,
    event_sink: EventSink | None = None,
) -> bool:
    emit = event_sink or (lambda _event: None)
    try:
        authority = authority_loader()
    except Exception as exc:
        # Critical invariant: an unavailable authority must never turn an already
        # protected paid/available Host into an unprotected one. Keep current state.
        emit({
            "event": "rental_power_guard_authority_error",
            "type": type(exc).__name__,
            "message": str(exc)[:300],
            "guardActive": guard.active,
        })
        return guard.active

    required = authority.keep_awake
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
            "reason": authority.reason,
            "liveSessions": authority.live_session_count,
            "availabilityListings": authority.availability_listing_count,
        })
    return guard.active


def _restore_from_local_claims(
    guard: SystemAwakeGuard,
    local_claim_loader: LocalClaimLoader,
    event_sink: EventSink,
) -> None:
    try:
        local_claims = max(0, int(local_claim_loader()))
    except Exception as exc:
        event_sink({
            "event": "rental_power_guard_local_claim_error",
            "type": type(exc).__name__,
            "message": str(exc)[:300],
        })
        return
    if local_claims == 0:
        return
    try:
        changed = guard.set_required(True)
    except Exception as exc:
        event_sink({
            "event": "rental_power_guard_state_error",
            "type": type(exc).__name__,
            "message": str(exc)[:300],
            "requested": True,
            "guardActive": guard.active,
        })
        return
    if changed:
        event_sink({
            "event": "rental_power_guard_restored",
            "persistedRentalClaims": local_claims,
        })


def run_rental_power_guard(
    stop_event: threading.Event,
    event_sink: EventSink | None = None,
    interval_seconds: int = POWER_GUARD_INTERVAL_SECONDS,
    authority_loader: AuthorityLoader = _load_host_power_authority,
    local_claim_loader: LocalClaimLoader = _persisted_rental_claim_count,
    writer: ExecutionStateWriter | None = None,
) -> None:
    """Run until the Windows service stops, then always release our sleep request."""
    emit = event_sink or (lambda _event: None)
    if os.name != "nt" and writer is None:
        return
    guard = SystemAwakeGuard(writer=writer)
    emit({"event": "rental_power_guard_started", "intervalSeconds": interval_seconds})
    try:
        # Reboots can happen while a paid session is active. Restore the local
        # protection immediately from the persisted fenced claim, then let signed
        # server power policy confirm/expand/release it on the first loop.
        _restore_from_local_claims(guard, local_claim_loader, emit)
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
