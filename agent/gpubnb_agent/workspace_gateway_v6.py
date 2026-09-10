"""Bounded concurrent WebSocket-open scheduler for Developer Workspace.

The browser can create several VS Code channels at startup (Management,
ExtensionHost, reconnect channels). Older gateway supervisors opened the local
code-server WebSocket synchronously from the control-message loop. One slow
local handshake could therefore head-of-line block later ws_open/ws_send
commands and consume the browser's own handshake budget.

v6 keeps the existing v5/v4/v3/v2 transport and security behavior, but moves
local WebSocket opens off the control loop. Browser frames that arrive behind a
pending ws_open are retained in a small bounded per-channel buffer and replayed
in order only after the local socket is established. This preserves the
ws_open -> ws_send ordering invariant without allowing an unbounded memory queue
or a slow channel to stall unrelated channels.
"""
from __future__ import annotations

import threading
from typing import Any

from . import workspace_gateway as legacy
from . import workspace_gateway_v5 as resource_scoped

WS_OPEN_MAX_CONCURRENCY = 8
WS_OPEN_PENDING_MAX_ITEMS = 128
WS_OPEN_PENDING_MAX_BASE64_BYTES = 8 * 1024 * 1024


class GatewaySupervisor(resource_scoped.GatewaySupervisor):
    """v5 supervisor with bounded, non-blocking local WebSocket opens."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._ws_open_slots = threading.BoundedSemaphore(WS_OPEN_MAX_CONCURRENCY)
        self._ws_open_state_lock = threading.Lock()
        self._ws_open_pending: dict[str, list[dict[str, Any]]] = {}
        self._ws_open_pending_bytes: dict[str, int] = {}
        self._ws_open_cancelled: set[str] = set()

    @staticmethod
    def _pending_size(item: dict[str, Any]) -> int:
        value = item.get("dataBase64")
        return len(value) if isinstance(value, str) else 0

    def _reject_open(self, item: dict[str, Any], error: str) -> None:
        request_id = str(item.get("id") or "")
        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        self._trace(
            "ws_open_rejected",
            session_id=session_id,
            channel_id=channel_id,
            detail=error,
        )
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
                    "error": error,
                },
            )
        except Exception as exc:
            self._report_error(exc)

    def _dispatch_ws_open(self, item: dict[str, Any]) -> None:
        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        if not channel_id:
            return super()._ws_open(item)

        if not self._ws_open_slots.acquire(blocking=False):
            self._reject_open(item, "workspace_ws_open_concurrency_exceeded")
            return

        with self._ws_open_state_lock:
            if channel_id in self._ws_open_pending:
                self._ws_open_slots.release()
                self._reject_open(item, "workspace_ws_open_duplicate")
                return
            self._ws_open_pending[channel_id] = []
            self._ws_open_pending_bytes[channel_id] = 0
            self._ws_open_cancelled.discard(channel_id)

        self._trace(
            "ws_open_dispatched",
            session_id=session_id,
            channel_id=channel_id,
            detail="async=1",
        )

        def open_local() -> None:
            pending: list[dict[str, Any]] = []
            cancelled = False
            opened = False
            try:
                super(GatewaySupervisor, self)._ws_open(item)
                with self._ws_open_state_lock:
                    opened = channel_id in self.channels
                    cancelled = channel_id in self._ws_open_cancelled
                    pending = self._ws_open_pending.pop(channel_id, [])
                    self._ws_open_pending_bytes.pop(channel_id, None)
                    self._ws_open_cancelled.discard(channel_id)

                if cancelled:
                    ws = self.channels.pop(channel_id, None)
                    self.session_channels.get(session_id, set()).discard(channel_id)
                    if ws is not None:
                        try:
                            ws.close()
                        except Exception:
                            pass
                    self._trace(
                        "ws_open_cancelled",
                        session_id=session_id,
                        channel_id=channel_id,
                        detail=f"buffered={len(pending)}",
                    )
                    return

                if not opened:
                    if pending:
                        self._trace(
                            "ws_open_pending_dropped",
                            session_id=session_id,
                            channel_id=channel_id,
                            detail=f"frames={len(pending)}",
                        )
                    return

                self._trace(
                    "ws_open_ready",
                    session_id=session_id,
                    channel_id=channel_id,
                    detail=f"buffered={len(pending)}",
                )
                for buffered in pending:
                    super(GatewaySupervisor, self)._handle(buffered)
            except Exception as exc:
                with self._ws_open_state_lock:
                    self._ws_open_pending.pop(channel_id, None)
                    self._ws_open_pending_bytes.pop(channel_id, None)
                    self._ws_open_cancelled.discard(channel_id)
                self._report_error(exc)
            finally:
                self._ws_open_slots.release()

        threading.Thread(
            target=open_local,
            daemon=True,
            name=f"gpubnb-ws-open-{channel_id[:8]}",
        ).start()

    def _buffer_while_opening(self, item: dict[str, Any]) -> bool:
        channel_id = str(item.get("channelId") or "")
        if not channel_id:
            return False
        size = self._pending_size(item)
        overflow = False
        first = False
        with self._ws_open_state_lock:
            pending = self._ws_open_pending.get(channel_id)
            if pending is None:
                return False
            current_bytes = self._ws_open_pending_bytes.get(channel_id, 0)
            if (
                len(pending) >= WS_OPEN_PENDING_MAX_ITEMS
                or current_bytes + size > WS_OPEN_PENDING_MAX_BASE64_BYTES
            ):
                self._ws_open_cancelled.add(channel_id)
                pending.clear()
                self._ws_open_pending_bytes[channel_id] = 0
                overflow = True
            else:
                first = len(pending) == 0
                pending.append(item)
                self._ws_open_pending_bytes[channel_id] = current_bytes + size
        if overflow:
            self._report_error(
                RuntimeError(
                    f"workspace_ws_open_pending_overflow:channel={channel_id[:8]}"
                )
            )
        elif first:
            self._trace(
                "ws_first_browser_frame_buffered",
                session_id=str(item.get("sessionId") or ""),
                channel_id=channel_id,
                detail=f"base64={size}",
            )
        return True

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")
        if kind == "ws_open":
            self._dispatch_ws_open(item)
            return
        if kind == "ws_send" and self._buffer_while_opening(item):
            return
        if kind == "ws_close":
            channel_id = str(item.get("channelId") or "")
            with self._ws_open_state_lock:
                if channel_id in self._ws_open_pending:
                    self._ws_open_cancelled.add(channel_id)
                    self._ws_open_pending[channel_id].clear()
                    self._ws_open_pending_bytes[channel_id] = 0
                    return
        return super()._handle(item)


def install() -> None:
    """Install the bounded WS-open scheduler after v5 transport/security layers."""
    legacy.GatewaySupervisor = GatewaySupervisor
