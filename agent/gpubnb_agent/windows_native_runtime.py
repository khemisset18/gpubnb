"""Fail-closed lifecycle contract for Windows-native graphical Workspaces.

The actual capture/encode/session implementation lives in the signed GPUbnb
Windows stream helper.  This module is the Agent-side authority boundary around
that helper: it validates the selected Workspace, re-runs the native capability
preflight, binds the helper to the exact leased GPU, accepts only loopback media
endpoints, and rejects any launch that cannot prove renter-session isolation.

Nothing in this module makes a machine bookable by itself.  Server-side
compatibility remains authoritative until this backend is physically qualified.
"""
from __future__ import annotations

from dataclasses import dataclass
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
    workspace_native_ready,
)


@dataclass(frozen=True)
class NativeRuntimeHandle:
    session_id: str
    workspace_slug: str
    gpu_uuid: str
    helper_version: str | None
    media_url: str
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


def _loopback_media_url(value: object) -> str | None:
    raw = str(value or "").strip()
    if not raw or len(raw) > 500:
        return None
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        return None
    host = (parsed.hostname or "").casefold()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        return None
    if parsed.username or parsed.password or parsed.fragment:
        return None
    return raw


def launch_windows_native_workspace(
    session_id: str,
    workspace_slug: str,
    gpu_uuid: str,
    *,
    helper_path: str | None = None,
) -> NativeRuntimeHandle:
    """Launch one native Workspace only after every local proof passes.

    The helper owns the dedicated Windows renter session.  The Agent never asks it
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

    ready, reason = workspace_native_ready(workspace_slug, executable)
    if not ready:
        raise RuntimeError(reason)

    preflight = windows_native_desktop_preflight(executable)
    if not preflight.available:
        raise RuntimeError(preflight.reason)
    if not preflight.gpu_uuid or preflight.gpu_uuid.casefold() != gpu_uuid.casefold():
        raise RuntimeError("native_stream_leased_gpu_mismatch")

    application = discover_native_application(workspace_slug)
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
        raise RuntimeError("native_workspace_start_failed")
    report = _json_object(result.stdout)
    if report is None:
        raise RuntimeError("native_workspace_start_invalid_json")
    if report.get("schemaVersion") != SELF_TEST_SCHEMA_VERSION:
        raise RuntimeError("native_workspace_start_schema_mismatch")
    if str(report.get("sessionId") or "") != session_id:
        raise RuntimeError("native_workspace_start_session_mismatch")
    if str(report.get("workspaceSlug") or "") != workspace_slug:
        raise RuntimeError("native_workspace_start_slug_mismatch")
    if str(report.get("gpuUuid") or "").casefold() != gpu_uuid.casefold():
        raise RuntimeError("native_workspace_start_gpu_mismatch")

    required_true = (
        "isolatedSession",
        "captureReady",
        "mediaReady",
        "inputIsolation",
    )
    missing = next((field for field in required_true if report.get(field) is not True), None)
    if missing:
        raise RuntimeError(f"native_workspace_start_missing_{missing}")
    if str(report.get("hardwareEncoder") or "").casefold() != "nvenc":
        raise RuntimeError("native_workspace_start_nvenc_required")

    audio_ready = report.get("audioReady") is True
    controller_ready = report.get("controllerReady") is True
    if profile.requires_audio and not audio_ready:
        raise RuntimeError("native_workspace_start_audio_required")
    if profile.requires_controller and not controller_ready:
        raise RuntimeError("native_workspace_start_controller_required")

    media_url = _loopback_media_url(report.get("mediaUrl"))
    if media_url is None:
        raise RuntimeError("native_workspace_start_loopback_media_required")

    return NativeRuntimeHandle(
        session_id=session_id,
        workspace_slug=workspace_slug,
        gpu_uuid=gpu_uuid,
        helper_version=str(report.get("helperVersion") or "")[:100] or preflight.helper_version,
        media_url=media_url,
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
