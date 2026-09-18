"""Fail-closed lifecycle contract for Windows-native graphical Workspaces.

The actual capture/encode/session implementation lives in the signed GPUbnb
Windows stream helper. This module is the Agent-side authority boundary around
that helper: it validates the selected Workspace, re-runs the native capability
preflight, binds the helper to the exact leased GPU, accepts only loopback media
endpoints, and rejects any launch that cannot prove renter-session isolation.

Nothing in this module makes a machine bookable by itself. Server-side
compatibility remains authoritative until this backend is physically qualified.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from ipaddress import ip_address
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .platform_info import run_command
from .windows_native_workspace import (
    SELF_TEST_SCHEMA_VERSION,
    discover_native_application,
    find_stream_helper,
    profile_for_slug,
    windows_native_desktop_preflight,
)


@dataclass(frozen=True)
class NativeRuntimeHandle:
    session_id: str
    workspace_slug: str
    gpu_uuid: str
    helper_version: str | None
    media_url: str
    media_token: str = field(repr=False)
    application_path: str | None
    audio_ready: bool
    controller_ready: bool


def _json_object(stdout: str) -> dict[str, Any] | None:
    try:
        value = json.loads(stdout)
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _safe_id(value: str, field: str) -> str:
    candidate = value.strip()
    if not candidate or len(candidate) > 200:
        raise RuntimeError(f"invalid_{field}")
    if any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in candidate):
        raise RuntimeError(f"invalid_{field}")
    return candidate


def _loopback_media_url(value: object, expected_session_id: str) -> str | None:
    raw = str(value or "").strip()
    if not raw or len(raw) > 500:
        return None
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        return None
    host = (parsed.hostname or "").strip()
    # Never resolve a hostname here. Even "localhost" can be redirected through a
    # modified hosts file. A literal loopback IP is the only accepted network
    # boundary between the native helper and GPUbnb's authenticated gateway.
    try:
        address = ip_address(host)
    except ValueError:
        return None
    if not address.is_loopback:
        return None
    if parsed.username or parsed.password or parsed.fragment or parsed.query:
        return None
    # Cross-session routing is forbidden even on loopback. The helper contract
    # exposes exactly one media resource for the requested opaque session id.
    if parsed.path != f"/session/{expected_session_id}":
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    # The native helper must bind an explicit ephemeral/local service port. Accepting
    # an implicit 80/443 endpoint could accidentally point the gateway at an unrelated
    # provider-local service rather than the helper instance we just launched.
    if port is None or not 1 <= port <= 65535:
        return None
    return raw


def _media_token(value: object) -> str | None:
    token = str(value or "").strip()
    if not 32 <= len(token) <= 200:
        return None
    if any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in token):
        return None
    return token


def _helper_stop_confirmed(executable: str, session_id: str) -> bool:
    """Best-effort helper cleanup used after a successful-but-invalid start reply."""
    result = run_command(
        [executable, "--stop", "--json", "--session-id", session_id],
        timeout=30,
    )
    if result.returncode != 0:
        return False
    report = _json_object(result.stdout)
    return bool(
        report is not None
        and report.get("stopped") is True
        and str(report.get("sessionId") or "") == session_id
    )


def _raise_after_started_session_validation_failure(
    executable: str,
    session_id: str,
    code: str,
) -> None:
    """Never leave a helper-owned session alive after rejecting its start report."""
    if _helper_stop_confirmed(executable, session_id):
        raise RuntimeError(code)
    raise RuntimeError(f"{code}_cleanup_unverified")


def launch_windows_native_workspace(
    session_id: str,
    workspace_slug: str,
    gpu_uuid: str,
    *,
    helper_path: str | None = None,
) -> NativeRuntimeHandle:
    """Launch one native Workspace only after every local proof passes.

    The helper owns the dedicated Windows renter session. The Agent never asks it
    to capture the provider desktop and never accepts a public media listener: the
    returned media endpoint must be loopback-only so the existing authenticated
    GPUbnb gateway can remain the network authority.
    """
    session_id = _safe_id(session_id, "native_session_id")
    gpu_uuid = gpu_uuid.strip()
    if not gpu_uuid or len(gpu_uuid) > 200:
        raise RuntimeError("invalid_native_gpu_uuid")

    profile = profile_for_slug(workspace_slug)
    executable = helper_path or find_stream_helper()
    if not executable:
        raise RuntimeError("native_stream_helper_missing")

    # Run the expensive physical capture/NVENC/isolation proof exactly once per
    # launch attempt. The previous implementation called workspace_native_ready()
    # and then repeated the same helper self-test, doubling launch latency and side
    # effects for no security benefit.
    preflight = windows_native_desktop_preflight(executable)
    if not preflight.available:
        raise RuntimeError(preflight.reason)
    if not preflight.gpu_uuid or preflight.gpu_uuid.casefold() != gpu_uuid.casefold():
        raise RuntimeError("native_stream_leased_gpu_mismatch")
    if profile.requires_audio and not preflight.audio_available:
        raise RuntimeError("workspace_audio_required")

    application = discover_native_application(workspace_slug)
    if profile.application is not None and application is None:
        raise RuntimeError(f"{workspace_slug}_application_missing")

    command = [
        executable,
        "--start",
        "--json",
        "--session-id",
        session_id,
        "--workspace",
        workspace_slug,
        "--gpu-uuid",
        gpu_uuid,
    ]
    if application:
        command.extend(["--application", str(Path(application))])

    result = run_command(command, timeout=60)
    if result.returncode != 0:
        # Helper contract: a non-zero --start must not leave a live renter session.
        # Only a successful start reply crosses the boundary where cleanup below is
        # mandatory before the Agent may reject the returned metadata.
        raise RuntimeError("native_workspace_start_failed")

    report = _json_object(result.stdout)
    if report is None:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_invalid_json"
        )
    assert report is not None
    if report.get("schemaVersion") != SELF_TEST_SCHEMA_VERSION:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_schema_mismatch"
        )
    if str(report.get("sessionId") or "") != session_id:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_session_mismatch"
        )
    if str(report.get("workspaceSlug") or "") != workspace_slug:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_slug_mismatch"
        )
    if str(report.get("gpuUuid") or "").casefold() != gpu_uuid.casefold():
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_gpu_mismatch"
        )

    required_true = (
        "isolatedSession",
        "virtualDisplay",
        "providerDesktopExcluded",
        "captureReady",
        "mediaReady",
        "inputIsolation",
    )
    missing = next((field for field in required_true if report.get(field) is not True), None)
    if missing:
        _raise_after_started_session_validation_failure(
            executable, session_id, f"native_workspace_start_missing_{missing}"
        )
    if str(report.get("hardwareEncoder") or "").casefold() != "nvenc":
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_nvenc_required"
        )

    audio_ready = report.get("audioReady") is True
    controller_ready = report.get("controllerReady") is True
    if profile.requires_audio and not audio_ready:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_audio_required"
        )
    if profile.requires_controller and not controller_ready:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_controller_required"
        )

    media_url = _loopback_media_url(report.get("mediaUrl"), session_id)
    if media_url is None:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_loopback_media_required"
        )
    media_token = _media_token(report.get("mediaToken"))
    if media_token is None:
        _raise_after_started_session_validation_failure(
            executable, session_id, "native_workspace_start_media_token_required"
        )

    return NativeRuntimeHandle(
        session_id=session_id,
        workspace_slug=workspace_slug,
        gpu_uuid=gpu_uuid,
        helper_version=str(report.get("helperVersion") or "")[:100] or preflight.helper_version,
        media_url=media_url,
        media_token=media_token,
        application_path=application,
        audio_ready=audio_ready,
        controller_ready=controller_ready,
    )


def stop_windows_native_workspace(
    session_id: str,
    *,
    helper_path: str | None = None,
) -> None:
    """Stop a helper-owned renter session; failure is surfaced to cleanup logic."""
    session_id = _safe_id(session_id, "native_session_id")
    executable = helper_path or find_stream_helper()
    if not executable:
        raise RuntimeError("native_stream_helper_missing")
    result = run_command(
        [executable, "--stop", "--json", "--session-id", session_id],
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError("native_workspace_stop_failed")
    report = _json_object(result.stdout)
    if report is None or report.get("stopped") is not True:
        raise RuntimeError("native_workspace_stop_unconfirmed")
    if str(report.get("sessionId") or "") != session_id:
        raise RuntimeError("native_workspace_stop_session_mismatch")
