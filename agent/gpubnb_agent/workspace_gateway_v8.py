"""Fail-closed 10-minute Workspace reconnect grace and billing suspension.

A browser/network interruption must not consume the renter's purchased minutes,
but merely stopping billing while the GPU container keeps executing would allow
free compute. This layer therefore couples the commercial pause to a real Docker
pause of the renter Workspace container. The loopback proxy remains alive so an
authenticated browser request can wake the same runtime and resume the same
session.

The API is authoritative for whether a session is in reconnect grace and for the
interruption/resume timestamps. Rolling deployments remain safe: an older API
that returns 404 simply disables this feature and leaves the already-qualified
v7 gateway/billing behavior unchanged.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from . import workspace_gateway as legacy
from . import workspace_gateway_v7 as qualified

WORKSPACE_RECONNECT_PROTOCOL_VERSION = 1
RECONNECT_LIVENESS_INTERVAL_SECONDS = 10.0
RECONNECT_HEALTH_TIMEOUT_SECONDS = 10.0


class GatewaySupervisor(qualified.GatewaySupervisor):
    """v7 gateway with server-authoritative reconnect pause/resume semantics."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._reconnect_lock = threading.Lock()
        self._reconnect_api_supported: bool | None = None
        self._reconnect_paused_sessions: set[str] = set()
        self._reconnect_beginning: set[str] = set()
        self._reconnect_last_liveness: dict[str, float] = {}

    def _reconnect_is_paused(self, session_id: str) -> bool:
        with self._reconnect_lock:
            return session_id in self._reconnect_paused_sessions

    def _reconnect_mark_paused(self, session_id: str) -> None:
        with self._reconnect_lock:
            self._reconnect_paused_sessions.add(session_id)
            self._reconnect_last_liveness[session_id] = time.monotonic()
        # Never let the first post-resume usage report include the grace period.
        self.usage_last_report[session_id] = time.monotonic()

    def _reconnect_clear(self, session_id: str) -> None:
        with self._reconnect_lock:
            self._reconnect_paused_sessions.discard(session_id)
            self._reconnect_beginning.discard(session_id)
            self._reconnect_last_liveness.pop(session_id, None)
        self.usage_last_report[session_id] = time.monotonic()

    @staticmethod
    def _bool_field(payload: dict[str, Any], name: str) -> bool:
        return payload.get(name) is True

    def _reconnect_event(self, session_id: str, event: str) -> dict[str, Any] | None:
        if self._reconnect_api_supported is False:
            return None
        path = f"/agent/workspace-reconnect/{session_id}/event"
        try:
            result = self._request(
                path,
                "POST",
                {"machineId": self.machine_id, "event": event},
            )
        except Exception as exc:
            if self._is_missing_endpoint(exc):
                self._reconnect_api_supported = False
                return None
            raise
        if not isinstance(result, dict):
            raise RuntimeError("workspace_reconnect_event_invalid_response")
        self._reconnect_api_supported = True
        return result

    def _reconnect_desired(self) -> set[str] | None:
        if self._reconnect_api_supported is False:
            return None
        path = f"/agent/workspace-reconnect/{self.machine_id}/desired"
        try:
            result = self._request(path)
        except Exception as exc:
            if self._is_missing_endpoint(exc):
                self._reconnect_api_supported = False
                return None
            raise
        if not isinstance(result, dict):
            raise RuntimeError("workspace_reconnect_desired_invalid_response")
        if result.get("protocolVersion") != WORKSPACE_RECONNECT_PROTOCOL_VERSION:
            raise RuntimeError("workspace_reconnect_protocol_mismatch")
        if result.get("graceSeconds") != 10 * 60:
            raise RuntimeError("workspace_reconnect_grace_mismatch")
        sessions = result.get("sessions")
        if not isinstance(sessions, list):
            raise RuntimeError("workspace_reconnect_desired_sessions_invalid")
        paused: set[str] = set()
        for item in sessions:
            if not isinstance(item, dict):
                raise RuntimeError("workspace_reconnect_desired_session_invalid")
            session_id = item.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                raise RuntimeError("workspace_reconnect_desired_session_id_invalid")
            paused.add(session_id)
        self._reconnect_api_supported = True
        return paused

    def _container_paused(self, container: str) -> bool:
        inspect = self._docker(
            ["inspect", "--format", "{{.State.Paused}}", container],
            check=False,
        )
        return inspect.returncode == 0 and inspect.stdout.strip() == "true"

    def _pause_runtime_for_reconnect(self, session_id: str) -> bool:
        runtime = self.runtimes.get(session_id)
        if runtime is None:
            return False
        if self._container_paused(runtime.container_name):
            return True
        result = self._docker(["pause", runtime.container_name], check=False)
        return result.returncode == 0 and self._container_paused(runtime.container_name)

    def _unpause_runtime_for_reconnect(self, session_id: str) -> bool:
        runtime = self.runtimes.get(session_id)
        if runtime is None:
            return False
        if self._container_paused(runtime.container_name):
            result = self._docker(["unpause", runtime.container_name], check=False)
            if result.returncode != 0:
                return False
        deadline = time.time() + RECONNECT_HEALTH_TIMEOUT_SECONDS
        return self._wait_healthy(runtime.port, deadline=deadline)

    def _begin_reconnect_grace(self, session_id: str) -> None:
        if not session_id or self._reconnect_api_supported is False:
            return
        if self.session_channels.get(session_id):
            return
        with self._reconnect_lock:
            if (
                session_id in self._reconnect_paused_sessions
                or session_id in self._reconnect_beginning
            ):
                return
            self._reconnect_beginning.add(session_id)

        try:
            # Physically suspend first. If the API write then fails, immediately
            # undo the pause; we never grant unbilled compute on ambiguous state.
            if not self._pause_runtime_for_reconnect(session_id):
                return
            try:
                result = self._reconnect_event(session_id, "INTERRUPTED")
            except Exception:
                self._unpause_runtime_for_reconnect(session_id)
                raise
            if result is None:
                self._unpause_runtime_for_reconnect(session_id)
                return
            if not self._bool_field(result, "paused"):
                # Session was not commercially active (for example a READY
                # pre-activation channel). Do not freeze a runtime the API did
                # not authorize as reconnecting.
                self._unpause_runtime_for_reconnect(session_id)
                return
            self._reconnect_mark_paused(session_id)
            self._trace(
                "reconnect_grace_started",
                session_id=session_id,
                detail="billing=paused:docker=paused:grace=600s",
            )
        finally:
            with self._reconnect_lock:
                self._reconnect_beginning.discard(session_id)

    def _resume_before_relay(self, session_id: str) -> bool:
        if not self._reconnect_is_paused(session_id):
            return True
        if not self._unpause_runtime_for_reconnect(session_id):
            try:
                self._reconnect_event(session_id, "SUSPEND_FAILED")
            except Exception as exc:
                self._report_error(exc)
            return False

        try:
            result = self._reconnect_event(session_id, "RESUMED")
        except Exception:
            # Commercial authority is unknown: restore the physical pause.
            self._pause_runtime_for_reconnect(session_id)
            raise
        if result is None:
            self._pause_runtime_for_reconnect(session_id)
            return False
        if self._bool_field(result, "expired"):
            self._pause_runtime_for_reconnect(session_id)
            return False

        # resumed=true is the normal path. resumed=false/expired=false means
        # the server already cleared the grace (e.g. Agent crashed immediately
        # after the API committed resume); in both cases server authority says
        # billing is no longer paused, so the local runtime may continue.
        self._reconnect_clear(session_id)
        self._trace(
            "reconnect_grace_resumed",
            session_id=session_id,
            detail="billing=active:docker=unpaused",
        )
        return True

    def _reject_http_reconnect(self, item: dict[str, Any]) -> None:
        request_id = str(item.get("id") or "")
        if not request_id:
            return
        try:
            self._request(
                "/agent/workspace-gateway/respond",
                "POST",
                {
                    "machineId": self.machine_id,
                    "id": request_id,
                    "status": 503,
                    "error": "workspace_reconnect_not_ready",
                },
            )
        except Exception as exc:
            self._report_error(exc)

    def _http(self, item: dict[str, Any]) -> None:
        session_id = str(item.get("sessionId") or "")
        try:
            if session_id and not self._resume_before_relay(session_id):
                self._reject_http_reconnect(item)
                return
        except Exception as exc:
            self._report_error(exc)
            self._reject_http_reconnect(item)
            return
        return super()._http(item)

    def _ws_open(self, item: dict[str, Any]) -> None:
        session_id = str(item.get("sessionId") or "")
        try:
            if session_id and not self._resume_before_relay(session_id):
                self._reject_open(item, "workspace_reconnect_not_ready")
                return
        except Exception as exc:
            self._report_error(exc)
            self._reject_open(item, "workspace_reconnect_not_ready")
            return
        return super()._ws_open(item)

    def _ws_reader(self, session_id: str, channel_id: str, ws: Any) -> None:
        try:
            return super()._ws_reader(session_id, channel_id, ws)
        finally:
            # The v2 reader removes this channel from session_channels in its
            # own finally block before returning. Only the last channel closing
            # starts a grace window, so normal VS Code channel churn is harmless.
            if not self.session_channels.get(session_id):
                try:
                    self._begin_reconnect_grace(session_id)
                except Exception as exc:
                    self._report_error(exc)

    def _report_running_usage(self, runtime: legacy.Runtime) -> None:
        if not self._reconnect_is_paused(runtime.session_id):
            return super()._report_running_usage(runtime)

        now = time.monotonic()
        with self._reconnect_lock:
            previous = self._reconnect_last_liveness.get(runtime.session_id, now)
            if now - previous < RECONNECT_LIVENESS_INTERVAL_SECONDS:
                return
            self._reconnect_last_liveness[runtime.session_id] = now
        try:
            self._reconnect_event(runtime.session_id, "LIVENESS")
        except Exception as exc:
            # Keep the container physically paused on control-plane failure.
            self._report_error(exc)

    def _adopt_or_start_runtime(
        self,
        session_id: str,
        workspace_slug: str = "developer",
    ) -> legacy.Runtime:
        if self._reconnect_is_paused(session_id):
            container, volume = legacy.names_for_session(session_id)
            proxy = legacy.proxy_name_for_session(session_id)
            internal_network = legacy.network_name_for_session(session_id)
            if (
                self._container_running(container)
                and self._container_running(proxy)
                and self._container_paused(container)
            ):
                port = self._discover_port(proxy)
                if port is not None:
                    runtime = legacy.Runtime(
                        session_id,
                        container,
                        proxy,
                        volume,
                        internal_network,
                        port,
                    )
                    self.runtimes[session_id] = runtime
                    return runtime
        return super()._adopt_or_start_runtime(session_id, workspace_slug)

    def _stop_runtime(self, session_id: str) -> bool:
        self._reconnect_clear(session_id)
        return super()._stop_runtime(session_id)

    def _reconcile_sessions(self) -> None:
        desired_paused = self._reconnect_desired()
        if desired_paused is not None:
            with self._reconnect_lock:
                self._reconnect_paused_sessions.update(desired_paused)
                now = time.monotonic()
                for session_id in desired_paused:
                    self._reconnect_last_liveness.setdefault(session_id, now)

        # v7/base reconciliation remains the owner of allocation authority,
        # runtime adoption/start/stop, cleanup and tunnel lifecycle. Our
        # _report_running_usage override suppresses billable usage while paused.
        super()._reconcile_sessions()

        if desired_paused is None:
            return
        for session_id in desired_paused:
            if session_id not in self.runtimes:
                continue
            if not self._pause_runtime_for_reconnect(session_id):
                try:
                    self._reconnect_event(session_id, "SUSPEND_FAILED")
                except Exception as exc:
                    self._report_error(exc)


def install() -> None:
    """Install reconnect-grace semantics after the qualified v7 gateway."""
    legacy.GatewaySupervisor = GatewaySupervisor
