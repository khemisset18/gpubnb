"""Windows-native desktop Workspace contracts and capability preflight.

This module deliberately does *not* make a Workspace bookable by itself.  It
provides the common Windows-native contract for Cloud Desktop, Creator, CAD and
Gaming and a fail-closed capability probe that can later be wired into the
heartbeat/API once the native media helper is shipped and physically qualified.

The helper contract is intentionally stronger than "Windows + CUDA + enough
VRAM": a real isolated renter session, a GPUbnb-owned virtual display, a real
captured frame, hardware encoding and a local media round-trip must all succeed
for capability to be true. The provider desktop must be explicitly excluded.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import platform
from pathlib import Path, PureWindowsPath
import shutil
from typing import Any

from .platform_info import gpu_inventory, run_command

WINDOWS_NATIVE_WORKSPACE_SLUGS = frozenset(
    {"cloud-desktop", "creator", "cad", "gaming"}
)
SELF_TEST_SCHEMA_VERSION = 1
WINDOWS_STREAM_HELPER_INSTALL_PATH = r"C:\\Program Files\\GPUbnb\\gpubnb-windows-stream.exe"
WINDOWS_STREAM_HELPER_DEV_PATH_ENV = "GPUBNB_WINDOWS_STREAM_HELPER"
WINDOWS_STREAM_HELPER_DEV_ALLOW_ENV = "GPUBNB_WINDOWS_STREAM_HELPER_DEV_ALLOW"


@dataclass(frozen=True)
class NativeWorkspaceProfile:
    slug: str
    application: str | None
    executable_candidates: tuple[str, ...]
    requires_audio: bool = False
    requires_controller: bool = False
    allows_outbound_network: bool = False


WINDOWS_NATIVE_WORKSPACE_PROFILES: dict[str, NativeWorkspaceProfile] = {
    "cloud-desktop": NativeWorkspaceProfile(
        slug="cloud-desktop",
        application=None,
        executable_candidates=(),
    ),
    "creator": NativeWorkspaceProfile(
        slug="creator",
        application="Blender",
        executable_candidates=(
            r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
            r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
            r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
            "blender.exe",
        ),
    ),
    "cad": NativeWorkspaceProfile(
        slug="cad",
        application="FreeCAD",
        executable_candidates=(
            r"C:\Program Files\FreeCAD 1.0\bin\FreeCAD.exe",
            r"C:\Program Files\FreeCAD 0.21\bin\FreeCAD.exe",
            "FreeCAD.exe",
        ),
    ),
    "gaming": NativeWorkspaceProfile(
        slug="gaming",
        application="Steam",
        executable_candidates=(
            r"C:\Program Files (x86)\Steam\steam.exe",
            r"C:\Program Files\Steam\steam.exe",
            "steam.exe",
        ),
        requires_audio=True,
        requires_controller=True,
        allows_outbound_network=True,
    ),
}


@dataclass(frozen=True)
class NativeDesktopPreflight:
    available: bool
    reason: str
    gpu_uuid: str | None = None
    hardware_encoder: str | None = None
    helper_version: str | None = None
    audio_available: bool = False


def profile_for_slug(slug: str) -> NativeWorkspaceProfile:
    try:
        return WINDOWS_NATIVE_WORKSPACE_PROFILES[slug]
    except KeyError as exc:
        raise ValueError("unsupported_windows_native_workspace") from exc


def _find_candidate(candidate: str) -> str | None:
    path = Path(candidate)
    if path.is_absolute() and path.is_file():
        return str(path)
    resolved = shutil.which(candidate)
    return str(Path(resolved).resolve()) if resolved else None


def discover_native_application(slug: str) -> str | None:
    """Return the native app path for a Workspace, without installing anything."""
    profile = profile_for_slug(slug)
    if profile.application is None:
        return None
    for candidate in profile.executable_candidates:
        resolved = _find_candidate(candidate)
        if resolved:
            return resolved
    return None


def _find_absolute_windows_file(candidate: str | None) -> str | None:
    if not candidate or not PureWindowsPath(candidate).is_absolute():
        return None
    path = Path(candidate)
    if not path.is_file():
        return None
    return str(path.resolve())


def find_stream_helper() -> str | None:
    """Find the trusted GPUbnb Windows media helper without PATH lookup.

    Production prefers the fixed Program Files location. A development override
    is accepted only when an explicit opt-in flag is set and the path is absolute.
    Relative paths and PATH discovery are deliberately forbidden so an unrelated
    executable cannot accidentally satisfy the native-streaming capability probe.
    """
    installed = _find_absolute_windows_file(WINDOWS_STREAM_HELPER_INSTALL_PATH)
    if installed:
        return installed

    if os.environ.get(WINDOWS_STREAM_HELPER_DEV_ALLOW_ENV) == "1":
        return _find_absolute_windows_file(os.environ.get(WINDOWS_STREAM_HELPER_DEV_PATH_ENV))
    return None

def _parse_self_test(stdout: str) -> dict[str, Any] | None:
    try:
        value = json.loads(stdout)
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def windows_native_desktop_preflight(
    helper_path: str | None = None,
) -> NativeDesktopPreflight:
    """Prove the Windows-native desktop streaming path, or fail closed.

    Expected helper output::

        {
          "schemaVersion": 1,
          "platform": "windows",
          "helperVersion": "...",
          "gpuUuid": "GPU-...",
          "isolatedSession": true,
          "virtualDisplay": true,
          "providerDesktopExcluded": true,
          "captureFrame": true,
          "hardwareEncoder": "nvenc",
          "mediaLoopback": true,
          "inputIsolation": true,
          "audioAvailable": true
        }

    The helper is responsible for performing the real capture/encode/session
    checks.  This function never infers success from GPU model, CUDA or VRAM.
    """
    if platform.system() != "Windows":
        return NativeDesktopPreflight(False, "windows_required")

    executable = helper_path or find_stream_helper()
    if not executable:
        return NativeDesktopPreflight(False, "native_stream_helper_missing")

    result = run_command([executable, "--self-test", "--json"], timeout=30)
    if result.returncode != 0:
        return NativeDesktopPreflight(False, "native_stream_self_test_failed")

    report = _parse_self_test(result.stdout)
    if report is None:
        return NativeDesktopPreflight(False, "native_stream_self_test_invalid_json")
    if report.get("schemaVersion") != SELF_TEST_SCHEMA_VERSION:
        return NativeDesktopPreflight(False, "native_stream_self_test_schema_mismatch")
    if str(report.get("platform") or "").casefold() != "windows":
        return NativeDesktopPreflight(False, "native_stream_self_test_wrong_platform")

    required_true = (
        "isolatedSession",
        "virtualDisplay",
        "providerDesktopExcluded",
        "captureFrame",
        "mediaLoopback",
        "inputIsolation",
    )
    missing_proof = next((field for field in required_true if report.get(field) is not True), None)
    if missing_proof:
        return NativeDesktopPreflight(False, f"native_stream_self_test_missing_{missing_proof}")

    encoder = str(report.get("hardwareEncoder") or "").casefold()
    if encoder != "nvenc":
        return NativeDesktopPreflight(False, "native_stream_nvenc_required")

    gpu_uuid = str(report.get("gpuUuid") or "").strip()
    if not gpu_uuid:
        return NativeDesktopPreflight(False, "native_stream_gpu_uuid_missing")
    local_gpu_uuids = {
        str(gpu.get("gpuUuid") or "").casefold()
        for gpu in gpu_inventory()
        if str(gpu.get("gpuVendor") or "").upper() == "NVIDIA"
    }
    if gpu_uuid.casefold() not in local_gpu_uuids:
        return NativeDesktopPreflight(False, "native_stream_gpu_uuid_not_local")

    return NativeDesktopPreflight(
        available=True,
        reason="ready",
        gpu_uuid=gpu_uuid,
        hardware_encoder="nvenc",
        helper_version=str(report.get("helperVersion") or "")[:100] or None,
        audio_available=report.get("audioAvailable") is True,
    )


def native_desktop_streaming_available(helper_path: str | None = None) -> bool:
    return windows_native_desktop_preflight(helper_path).available


def workspace_native_ready(slug: str, helper_path: str | None = None) -> tuple[bool, str]:
    """Return local readiness for one of the four Windows-native Workspaces."""
    profile = profile_for_slug(slug)
    preflight = windows_native_desktop_preflight(helper_path)
    if not preflight.available:
        return False, preflight.reason
    if profile.requires_audio and not preflight.audio_available:
        return False, "workspace_audio_required"
    if profile.application is not None and discover_native_application(slug) is None:
        return False, f"{slug}_application_missing"
    return True, "ready"
