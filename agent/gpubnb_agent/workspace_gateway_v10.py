"""Windows-native Cloud Desktop gateway integration.

This layer is deliberately *dormant* until the production Windows helper can
satisfy its start/status/suspend/resume/stop contracts. It never turns Windows
bookability on. Its job is to make the already-qualified native graphics path
fit the existing authenticated Workspace gateway without weakening the v2-v8
transport, rental-fencing, reconnect or billing invariants.

Security boundaries:
* native sessions are split out before the Docker reconciler sees them;
* exactly one server-authorized rental GPU UUID is accepted;
* browser HTTP is never relayed to the native helper;
* the helper media token is injected only on 127.0.0.1 and is never returned
  to the API/browser or logged;
* browser input remains the fixed 32-byte, epoch/sequence-fenced binary
  protocol enforced by the helper;
* reconnect suspension revokes media/input before billing may pause;
* resume requires a fresh exact-GPU + capture + NVENC + input proof;
* any ambiguous suspend/resume/health/cleanup result hard-stops or quarantines
  rather than granting free compute or stale READY state.
"""
from __future__ import annotations

import platform
import re
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import websocket

from . import workspace_gateway as legacy
from . import workspace_gateway_v8 as reconnect
from .execution_control import ExecutionControlError
from .windows_native_runtime import (
    NativeRuntimeHandle,
    launch_windows_native_workspace,
    resume_windows_native_workspace,
    stop_windows_native_workspace,
    suspend_windows_native_workspace,
    windows_native_workspace_ready,
)

WINDOWS_NATIVE_RUNTIME_BACKEND = "WINDOWS_NATIVE"
WINDOWS_NATIVE_INITIAL_WORKSPACE_SLUGS = frozenset({"cloud-desktop"})
WINDOWS_NATIVE_MEDIA_HEADER = "X-GPUbnb-Media-Token"
WINDOWS_NATIVE_USAGE_INTERVAL_SECONDS = 10.0
WINDOWS_NATIVE_START_RETRY_MAX_SECONDS = 60.0
_NATIVE_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")


@dataclass
class NativeGatewayRuntime:
    session_id: str
    runtime_id: str
    port: int
    websocket_url: str
    handle: NativeRuntimeHandle


def _native_runtime_id(session_id: str) -> str:
    if not _NATIVE_SESSION_ID.fullmatch(session_id):
        raise RuntimeError("windows_native_session_id_invalid")
    compact = re.sub(r"[^A-Za-z0-9_-]", "", session_id)[-72:]
    return f"gpubnb-native-{compact}"


def _native_websocket_target(handle: NativeRuntimeHandle) -> tuple[str, int]:
    try:
        parsed = urlsplit(handle.media_url)
        if parsed.scheme not in {"http", "https", "ws", "wss"}:
            raise ValueError("scheme")
        if parsed.hostname not in {"127.0.0.1", "::1"}:
            raise ValueError("host")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("credentials")
        port = parsed.port
        if port is None or not (1024 <= port <= 65535):
            raise ValueError("port")
        if parsed.path != f"/session/{handle.session_id}":
            raise ValueError("path")
    except (TypeError, ValueError):
        raise RuntimeError("windows_native_media_endpoint_invalid") from None

    scheme = "wss" if parsed.scheme in {"https", "wss"} else "ws"
    host = "[::1]" if parsed.hostname == "::1" else "127.0.0.1"
    return f"{scheme}://{host}:{port}{parsed.path}", port


def _split_desired_sessions(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sessions = payload.get("sessions")
    if not isinstance(sessions, list):
        return payload, []
    containers: list[dict[str, Any]] = []
    native: list[dict[str, Any]] = []
    for item in sessions:
        if not isinstance(item, dict):
            containers.append(item)
            continue
        if item.get("runtimeBackend") == WINDOWS_NATIVE_RUNTIME_BACKEND:
            native.append(item)
        else:
            containers.append(item)
    filtered = dict(payload)
    filtered["sessions"] = containers
    return filtered, native


class GatewaySupervisor(reconnect.GatewaySupervisor):
    """v8 reconnect/billing semantics plus a separate Windows-native runtime map."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.native_runtimes: dict[str, NativeGatewayRuntime] = {}
        self._native_desired_sessions: list[dict[str, Any]] = []
        self._native_blocked: set[str] = set()
        self._native_lock = threading.RLock()

    def _request(
        self,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        result = super()._request(path, method, body)
        desired_path = f"/agent/workspace-gateway/{self.machine_id}/desired"
        if path == desired_path and method == "GET" and body is None and isinstance(result, dict):
            filtered, native = _split_desired_sessions(result)
            with self._native_lock:
                self._native_desired_sessions = native
            return filtered
        return result

    def _native_specs(self, session_id: str) -> list[Any]:
        specs = self._session_specs(session_id)
        if specs is None:
            raise RuntimeError("windows_native_rental_authority_required")
        if len(specs) != 1:
            raise RuntimeError("windows_native_exactly_one_gpu_required")
        uuid = str(specs[0].hardware_uuid or "")
        if not uuid.startswith("GPU-"):
            raise RuntimeError("windows_native_gpu_uuid_required")
        return specs

    def _release_native_claims(self, session_id: str) -> bool:
        claims = self.rental_preemption.claims_for_session(session_id)
        if not claims:
            return True
        try:
            released = self.rental_preemption.release_after_cleanup(session_id)
        except ExecutionControlError:
            return False
        self._release_server_leases(session_id, released)
        return True

    def _start_native_runtime(
        self,
        session_id: str,
        workspace_slug: str,
    ) -> NativeGatewayRuntime:
        if workspace_slug not in WINDOWS_NATIVE_INITIAL_WORKSPACE_SLUGS:
            raise RuntimeError("windows_native_workspace_not_promoted")
        specs = self._native_specs(session_id)
        for spec in specs:
            self.rental_preemption.preempt_for_rental(spec)

        try:
            handle = launch_windows_native_workspace(
                session_id,
                workspace_slug,
                str(specs[0].hardware_uuid),
            )
        except Exception as exc:
            # The launch wrapper's *_cleanup_unverified suffix is an explicit
            # authority boundary: never release a leased GPU if the helper may
            # still own renter graphics/session state.
            if str(exc).endswith("_cleanup_unverified"):
                with self._native_lock:
                    self._native_blocked.add(session_id)
            else:
                self._release_native_claims(session_id)
            raise

        try:
            websocket_url, port = _native_websocket_target(handle)
            runtime = NativeGatewayRuntime(
                session_id=session_id,
                runtime_id=_native_runtime_id(session_id),
                port=port,
                websocket_url=websocket_url,
                handle=handle,
            )
            for spec in specs:
                self.rental_preemption.mark_rental_active(spec)
        except Exception:
            try:
                stop_windows_native_workspace(session_id)
            except Exception:
                with self._native_lock:
                    self._native_blocked.add(session_id)
                raise RuntimeError("windows_native_start_cleanup_unverified") from None
            self._release_native_claims(session_id)
            raise

        with self._native_lock:
            self.native_runtimes[session_id] = runtime
            self._native_blocked.discard(session_id)
        self.usage_last_report[session_id] = time.monotonic()
        return runtime

    def _native_runtime(self, session_id: str) -> NativeGatewayRuntime:
        with self._native_lock:
            runtime = self.native_runtimes.get(session_id)
            blocked = session_id in self._native_blocked
        if runtime is None or blocked:
            raise RuntimeError("windows_native_runtime_not_ready")
        return runtime

    def _stop_native_runtime(self, session_id: str) -> bool:
        # Block reconnect callbacks before closing sockets; a reader thread may
        # observe the close concurrently and must not suspend/resume a runtime
        # that is already being destroyed.
        with self._native_lock:
            runtime = self.native_runtimes.get(session_id)
            self._native_blocked.add(session_id)
        self._close_session_channels(session_id)
        self.usage_last_report.pop(session_id, None)

        if runtime is None:
            released = self._release_native_claims(session_id)
            if released:
                with self._native_lock:
                    self._native_blocked.discard(session_id)
            return released

        try:
            stop_windows_native_workspace(session_id)
        except Exception:
            return False

        released = self._release_native_claims(session_id)
        if not released:
            return False
        with self._native_lock:
            self.native_runtimes.pop(session_id, None)
            self._native_blocked.discard(session_id)
        return True

    def _native_stop_and_report(self, session_id: str) -> bool:
        cleaned = self._stop_native_runtime(session_id)
        try:
            self._request(
                f"/agent/workspace-gateway/{session_id}/stopped",
                "POST",
                {"machineId": self.machine_id, "cleaned": cleaned},
            )
        except Exception as exc:
            self._report_error(exc)
        return cleaned

    def _native_register_if_needed(
        self,
        runtime: NativeGatewayRuntime,
        metadata: dict[str, Any],
    ) -> None:
        if (
            metadata.get("runtimeId") == runtime.runtime_id
            and metadata.get("localPort") == runtime.port
        ):
            return
        self._request(
            f"/agent/workspace-gateway/{runtime.session_id}/register",
            "POST",
            {
                "machineId": self.machine_id,
                "runtimeId": runtime.runtime_id,
                "localPort": runtime.port,
            },
        )

    def _report_native_usage(self, runtime: NativeGatewayRuntime) -> None:
        now = time.monotonic()
        previous = self.usage_last_report.setdefault(runtime.session_id, now)
        elapsed = int(now - previous)
        if elapsed < WINDOWS_NATIVE_USAGE_INTERVAL_SECONDS:
            return

        if not windows_native_workspace_ready(runtime.session_id):
            self._report_error(RuntimeError("windows_native_live_proof_lost"))
            self._native_stop_and_report(runtime.session_id)
            return

        interval = max(1, min(30, elapsed))
        self._request(
            f"/agent/workspace-gateway/{runtime.session_id}/usage",
            "POST",
            {
                "machineId": self.machine_id,
                "counter": str(int(time.time() * 1000)),
                "intervalSeconds": interval,
                "available": True,
            },
        )
        self.usage_last_report[runtime.session_id] = now

    def _reconcile_native_sessions(self) -> None:
        with self._native_lock:
            desired = list(self._native_desired_sessions)
        desired_ids: set[str] = set()

        for session in desired:
            session_id = str(session.get("id") or "")
            if not _NATIVE_SESSION_ID.fullmatch(session_id):
                self._report_error(RuntimeError("windows_native_session_id_invalid"))
                continue
            desired_ids.add(session_id)
            status = str(session.get("status") or "")
            workspace_slug = str(session.get("workspaceSlug") or "")
            metadata = (
                session.get("connectionMetadata")
                if isinstance(session.get("connectionMetadata"), dict)
                else {}
            )

            if workspace_slug not in WINDOWS_NATIVE_INITIAL_WORKSPACE_SLUGS:
                self._report_error(RuntimeError("windows_native_workspace_not_promoted"))
                if session_id in self.native_runtimes:
                    self._native_stop_and_report(session_id)
                continue

            if status in {"STOP_REQUESTED", "STOPPING"} or self._expired(session.get("expiresAt")):
                self._native_stop_and_report(session_id)
                continue
            if status not in {"READY", "RUNNING"}:
                continue
            with self._native_lock:
                if session_id in self._native_blocked:
                    continue
                runtime = self.native_runtimes.get(session_id)

            if runtime is None:
                if time.monotonic() < self.start_retry_at.get(session_id, 0.0):
                    continue
                try:
                    runtime = self._start_native_runtime(session_id, workspace_slug)
                except Exception:
                    failures = self.start_failures.get(session_id, 0) + 1
                    self.start_failures[session_id] = failures
                    self.start_retry_at[session_id] = time.monotonic() + min(
                        WINDOWS_NATIVE_START_RETRY_MAX_SECONDS,
                        5.0 * (2 ** min(failures - 1, 4)),
                    )
                    self._report_error(RuntimeError("windows_native_runtime_start_failed"))
                    continue
                self.start_failures.pop(session_id, None)
                self.start_retry_at.pop(session_id, None)

            self._native_register_if_needed(runtime, metadata)
            self._report_native_usage(runtime)

        with self._native_lock:
            orphan_ids = set(self.native_runtimes) - desired_ids
        for session_id in orphan_ids:
            self._stop_native_runtime(session_id)

    def _reconcile_sessions(self) -> None:
        # v8 -> v7 -> v5 remains authoritative for container sessions, rental
        # fencing and reconnect state. _request splits native sessions out before
        # that stack can ever interpret them as Docker workloads.
        super()._reconcile_sessions()
        self._reconcile_native_sessions()

    def _pause_runtime_for_reconnect(self, session_id: str) -> bool:
        with self._native_lock:
            is_native = session_id in self.native_runtimes
            blocked = session_id in self._native_blocked
        if not is_native:
            return super()._pause_runtime_for_reconnect(session_id)
        if blocked:
            return False
        try:
            suspend_windows_native_workspace(session_id)
            return True
        except Exception:
            self._report_error(RuntimeError("windows_native_suspend_failed"))
            self._native_stop_and_report(session_id)
            return False

    def _unpause_runtime_for_reconnect(self, session_id: str) -> bool:
        with self._native_lock:
            is_native = session_id in self.native_runtimes
            blocked = session_id in self._native_blocked
        if not is_native:
            return super()._unpause_runtime_for_reconnect(session_id)
        if blocked:
            return False
        try:
            resume_windows_native_workspace(session_id)
            self.usage_last_report[session_id] = time.monotonic()
            return True
        except Exception:
            self._report_error(RuntimeError("windows_native_resume_reproof_failed"))
            self._native_stop_and_report(session_id)
            return False

    def _stop_runtime(self, session_id: str) -> bool:
        with self._native_lock:
            is_native = session_id in self.native_runtimes or session_id in self._native_blocked
        if is_native:
            return self._stop_native_runtime(session_id)
        return super()._stop_runtime(session_id)

    def _ws_open(self, item: dict[str, Any]) -> None:
        session_id = str(item.get("sessionId") or "")
        with self._native_lock:
            is_native = session_id in self.native_runtimes
        if not is_native:
            return super()._ws_open(item)

        request_id = str(item.get("id") or "")
        channel_id = str(item.get("channelId") or "")
        path = str(item.get("path") or "")
        ws: websocket.WebSocket | None = None

        if path != "/native-stream" or not channel_id:
            self._reject_open(item, "windows_native_stream_path_invalid")
            return
        try:
            if self._reconnect_is_paused(session_id) and not self._resume_before_relay(session_id):
                self._reject_open(item, "workspace_reconnect_not_ready")
                return
            runtime = self._native_runtime(session_id)
            # No browser header, cookie, subprotocol or authorization value is
            # forwarded to the privileged helper. Its capability is injected
            # exclusively by the Agent on loopback.
            ws = websocket.create_connection(
                runtime.websocket_url,
                header=[f"{WINDOWS_NATIVE_MEDIA_HEADER}: {runtime.handle.media_token}"],
                origin=f"http://127.0.0.1:{runtime.port}",
                timeout=10.0,
                enable_multithread=True,
            )
            set_timeout = getattr(ws, "settimeout", None)
            if callable(set_timeout):
                set_timeout(None)
            self.channels[channel_id] = ws
            self.session_channels.setdefault(session_id, set()).add(channel_id)
            reader = threading.Thread(
                target=self._ws_reader,
                args=(session_id, channel_id, ws),
                daemon=True,
                name=f"gpubnb-native-ws-{channel_id[:8]}",
            )
            reader.start()
        except Exception:
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            self._reject_open(item, "windows_native_media_connect_failed")
            return

        if request_id:
            def report_open_ack() -> None:
                try:
                    self._request(
                        "/agent/workspace-gateway/respond",
                        "POST",
                        {"machineId": self.machine_id, "id": request_id, "status": 101},
                    )
                except Exception:
                    self._report_error(RuntimeError("windows_native_open_ack_failed"))

            threading.Thread(
                target=report_open_ack,
                daemon=True,
                name=f"gpubnb-native-ack-{channel_id[:8]}",
            ).start()


def install() -> None:
    """Install native integration only on Windows; Linux/Selkies is unchanged."""
    if platform.system() != "Windows":
        return
    legacy.GatewaySupervisor = GatewaySupervisor
