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
import time
from typing import Callable

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


def probe_native_desktop_capability(
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


def native_desktop_streaming_available_cached(*, force: bool = False) -> bool:
    return probe_native_desktop_capability(force=force).available
