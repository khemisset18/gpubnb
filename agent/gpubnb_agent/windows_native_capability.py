"""Bounded cache for the expensive Windows-native desktop capability proof.

Heartbeat inventory will eventually report only the boolean capability from this
module. The runtime launch path deliberately does *not* use this cache: every real
renter launch re-runs the physical helper preflight and verifies the exact leased
GPU again.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import platform
import threading
from functools import wraps
import time
from typing import Callable

from .physical_gpu_authority import PHYSICAL_GPU_LOCK
from .windows_native_workspace import (
    NativeDesktopPreflight,
    find_stream_helper,
    windows_native_desktop_preflight,
)

POSITIVE_TTL_SECONDS = 60.0
NEGATIVE_TTL_SECONDS = 15.0


@dataclass(frozen=True)
class NativeDesktopCapabilitySnapshot:
    available: bool
    reason: str
    gpu_uuid: str | None
    hardware_encoder: str | None
    helper_version: str | None
    audio_available: bool
    measured_at: float


# The helper self-test creates a real IddCx monitor and NVENC capture. It must
# never run concurrently with preemption, native START or an active rental.
# This lock is deliberately process-local to the single Agent supervisor.
_PHYSICAL_PROBE_LOCK = PHYSICAL_GPU_LOCK
_FENCED_NATIVE_RENTALS: set[str] = set()


def _persisted_physical_probe_block_reason() -> str | None:
    # Lazy imports avoid the inventory -> preemption -> inventory module cycle.
    # Read every time, before using even a fresh READY cache. In-memory fences
    # disappear at restart, while active/quarantined claims must remain fences.
    from .gpu_rental_preemption import RentalClaimStore
    from .gpu_resource_supervisor import RuntimeStore

    try:
        if RentalClaimStore().load():
            return "native_rental_fenced"
        for record in RuntimeStore().load().values():
            if (
                record.state != "STOPPED"
                or record.pid is not None
                or record.process_creation_token is not None
            ):
                return "native_gpu_runtime_fenced"
    except Exception:
        # Corruption, invalid UTF-8, ACL errors and unknown authority all block
        # monitor creation. Never echo file contents, paths or exception text.
        return "native_resource_state_unverified"
    return None

def native_rental_physical_cleanup_confirmed(session_id: str) -> None:
    """Unfence only after the helper STOP and GPU claim release were proven."""
    with _PHYSICAL_PROBE_LOCK:
        _FENCED_NATIVE_RENTALS.discard(session_id)
        invalidate_native_desktop_capability_cache()


def fence_native_rental_launch(fn):
    """Serialize the complete GPU preemption + helper start against heartbeats.

    Retain the fence after launch, or after uncertain cleanup, until the physical
    owner proves release. A failed launch without any claim may be safely unfenced.
    """
    @wraps(fn)
    def guarded(self, session_id: str, *args, **kwargs):
        with _PHYSICAL_PROBE_LOCK:
            _FENCED_NATIVE_RENTALS.add(session_id)
            try:
                return fn(self, session_id, *args, **kwargs)
            finally:
                try:
                    claims = self.rental_preemption.claims_for_session(session_id)
                except Exception:
                    claims = [True]  # Indeterminate authority: fail closed.
                if not claims:
                    _FENCED_NATIVE_RENTALS.discard(session_id)
                    invalidate_native_desktop_capability_cache()
    return guarded


_CACHE_LOCK = threading.Lock()
_CACHE: tuple[str | None, int | None, int | None, NativeDesktopCapabilitySnapshot] | None = None


def _helper_identity(helper: str | None) -> tuple[str | None, int | None, int | None]:
    if not helper:
        return None, None, None
    try:
        stat = Path(helper).stat()
    except OSError:
        return helper, None, None
    return helper, stat.st_mtime_ns, stat.st_size


def _snapshot(preflight: NativeDesktopPreflight, measured_at: float) -> NativeDesktopCapabilitySnapshot:
    return NativeDesktopCapabilitySnapshot(
        available=bool(preflight.available),
        reason=str(preflight.reason)[:200],
        gpu_uuid=preflight.gpu_uuid,
        hardware_encoder=preflight.hardware_encoder,
        helper_version=preflight.helper_version,
        audio_available=bool(preflight.audio_available),
        measured_at=measured_at,
    )


def invalidate_native_desktop_capability_cache() -> None:
    global _CACHE
    with _CACHE_LOCK:
        _CACHE = None


def cached_native_desktop_capability_snapshot() -> NativeDesktopCapabilitySnapshot | None:
    """Return the latest measured snapshot without triggering a new physical probe."""
    with _CACHE_LOCK:
        return _CACHE[3] if _CACHE is not None else None


def _probe_native_desktop_capability_unfenced(
    *,
    force: bool = False,
    clock: Callable[[], float] = time.monotonic,
) -> NativeDesktopCapabilitySnapshot:
    """Return a recent fail-closed proof without hammering capture/NVENC each heartbeat.

    Positive proofs live for at most 60 seconds, negative proofs for 15 seconds.
    Helper path/mtime/size changes invalidate the cache immediately. Runtime launch
    never trusts this snapshot and performs its own fresh preflight.
    """
    global _CACHE

    now = clock()
    if platform.system() != "Windows":
        return NativeDesktopCapabilitySnapshot(
            False, "windows_required", None, None, None, False, now
        )

    helper = find_stream_helper()
    identity = _helper_identity(helper)

    with _CACHE_LOCK:
        cached = _CACHE
        if cached is not None and not force and cached[:3] == identity:
            snapshot = cached[3]
            ttl = POSITIVE_TTL_SECONDS if snapshot.available else NEGATIVE_TTL_SECONDS
            if 0 <= now - snapshot.measured_at < ttl:
                return snapshot

        try:
            preflight = windows_native_desktop_preflight(helper)
        except Exception as exc:
            # Inventory must remain available even if a future native helper/probe has
            # an unexpected bug. Unknown capability is treated as unavailable.
            preflight = NativeDesktopPreflight(
                False,
                f"native_stream_probe_error:{type(exc).__name__}",
            )
        snapshot = _snapshot(preflight, now)
        _CACHE = (*identity, snapshot)
        return snapshot


def probe_native_desktop_capability(
    *,
    force: bool = False,
    clock: Callable[[], float] = time.monotonic,
) -> NativeDesktopCapabilitySnapshot:
    """Do not create a qualification display while any rental owns the GPU."""
    if platform.system() != "Windows":
        return _snapshot(NativeDesktopPreflight(False, "windows_required"), clock())
    # A START/STOP may hold the lock for a complete helper deadline. Heartbeat
    # must still return promptly so the control plane can renew rental leases.
    if not _PHYSICAL_PROBE_LOCK.acquire(blocking=False):
        return _snapshot(NativeDesktopPreflight(False, "native_rental_fenced"), clock())
    try:
        reason = (
            "native_rental_fenced" if _FENCED_NATIVE_RENTALS
            else _persisted_physical_probe_block_reason()
        )
        if reason is not None:
            # Do not reuse a READY cache as permission for a new physical probe.
            # Emit an explicit bounded unavailable snapshot while GPU fencing
            # or physical cleanup is in progress.
            snapshot = _snapshot(
                NativeDesktopPreflight(False, reason),
                clock(),
            )
            helper = find_stream_helper()
            identity = _helper_identity(helper)
            global _CACHE
            with _CACHE_LOCK:
                _CACHE = (*identity, snapshot)
            return snapshot
        return _probe_native_desktop_capability_unfenced(force=force, clock=clock)
    finally:
        _PHYSICAL_PROBE_LOCK.release()


def native_desktop_streaming_available_cached(*, force: bool = False) -> bool:
    return probe_native_desktop_capability(force=force).available
