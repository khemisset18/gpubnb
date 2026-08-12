"""High-throughput transport for the outbound Developer Workspace gateway.

This module deliberately subclasses the hardened lifecycle implementation in
``workspace_gateway`` instead of duplicating container/mining safety logic.  It
only replaces the latency-sensitive tunnel loop:

* code-server WebSocket readers never wait on an Internet HTTPS round trip;
* upstream frames are micro-batched with stable frame IDs so API retries are
  idempotent;
* browser->host commands are drained from the API in ordered batches;
* expensive Docker/session reconciliation runs outside the control-message loop.

The legacy single-frame/next endpoints remain as an automatic rollout fallback.
"""
from __future__ import annotations

import base64
import queue
import threading
import time
import uuid
from typing import Any

import websocket

from . import workspace_gateway as legacy

WS_OUTBOUND_QUEUE_MAX_ITEMS = 8
WS_FRAME_BATCH_MAX_ITEMS = 32
WS_FRAME_BATCH_MAX_BASE64_BYTES = 8 * 1024 * 1024
WS_FRAME_BATCH_COALESCE_SECONDS = 0.004
WS_QUEUE_PUT_TIMEOUT_SECONDS = 2.0
WS_SENDER_JOIN_TIMEOUT_SECONDS = 15.0
CONTROL_BURST_PAUSE_SECONDS = 0.005
NEXT_BATCH_MAX_ITEMS = 64

_CLOSE = object()


class GatewaySupervisor(legacy.GatewaySupervisor):
    """Gateway supervisor with a transport path suitable for VS Code bursts."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._supports_ws_frame_batch: bool | None = None
        self._supports_next_batch: bool | None = None

    @staticmethod
    def _is_missing_endpoint(error: Exception) -> bool:
        text = str(error)
        return "API HTTP 404" in text or '"error":"Not Found"' in text

    def _post_ws_frames(self, frames: list[dict[str, Any]]) -> None:
        """Post an ordered frame batch, falling back during rolling deploys."""
        if not frames:
            return
        if self._supports_ws_frame_batch is not False:
            try:
                self._request(
                    "/agent/workspace-gateway/ws-frames",
                    "POST",
                    {"machineId": self.machine_id, "frames": frames},
                )
                self._supports_ws_frame_batch = True
                return
            except Exception as exc:
                if not self._is_missing_endpoint(exc):
                    raise
                self._supports_ws_frame_batch = False

        # Backward-compatible fallback for an Agent updated a few seconds before
        # the API deployment. Frame IDs are intentionally omitted because the
        # legacy route predates idempotent batch support.
        for frame in frames:
            payload = {
                "machineId": self.machine_id,
                "channelId": frame["channelId"],
                "binary": frame.get("binary") is True,
            }
            if frame.get("close") is True:
                payload["close"] = True
            else:
                payload["dataBase64"] = str(frame.get("dataBase64") or "")
            self._request("/agent/workspace-gateway/ws-frame", "POST", payload)

    def _next_items(self) -> list[dict[str, Any]]:
        """Fetch an ordered burst of browser/API commands with legacy fallback."""
        if self._supports_next_batch is not False:
            path = f"/agent/workspace-gateway/{self.machine_id}/next-batch"
            try:
                result = self._request(path)
                self._supports_next_batch = True
                items = result.get("items") if isinstance(result, dict) else None
                if items is None:
                    return []
                if not isinstance(items, list) or len(items) > NEXT_BATCH_MAX_ITEMS:
                    raise RuntimeError("workspace_gateway_invalid_next_batch")
                return [item for item in items if isinstance(item, dict)]
            except Exception as exc:
                if not self._is_missing_endpoint(exc):
                    raise
                self._supports_next_batch = False

        item = self._request(f"/agent/workspace-gateway/{self.machine_id}/next")
        return [item] if isinstance(item, dict) and item else []

    @staticmethod
    def _encoded_size(raw: bytes) -> int:
        return ((len(raw) + 2) // 3) * 4

    def _ws_reader(self, session_id: str, channel_id: str, ws: websocket.WebSocket) -> None:
        """Drain code-server immediately while a sender batches Internet writes.

        The old reader performed a complete signed HTTPS request before calling
        ``recv_data`` again.  A burst of Management frames therefore applied
        WAN/TLS latency directly as backpressure to code-server.  This bounded
        producer/consumer split keeps local reads hot while still failing closed
        if the remote API cannot keep up.
        """
        outbound: queue.Queue[object] = queue.Queue(maxsize=WS_OUTBOUND_QUEUE_MAX_ITEMS)
        sender_failed = threading.Event()
        frame_count = 0

        def make_frame(raw: bytes, binary: bool) -> dict[str, Any]:
            return {
                "frameId": str(uuid.uuid4()),
                "channelId": channel_id,
                "dataBase64": base64.b64encode(raw).decode(),
                "binary": binary,
            }

        def make_close() -> dict[str, Any]:
            return {
                "frameId": str(uuid.uuid4()),
                "channelId": channel_id,
                "close": True,
                "binary": False,
            }

        def sender() -> None:
            pending: object | None = None
            try:
                while not self.stop_event.is_set():
                    current = pending if pending is not None else outbound.get()
                    pending = None
                    if current is _CLOSE:
                        self._post_ws_frames([make_close()])
                        return

                    raw, binary = current  # type: ignore[misc]
                    batch = [make_frame(raw, bool(binary))]
                    encoded_bytes = self._encoded_size(raw)
                    close_after_batch = False
                    deadline = time.monotonic() + WS_FRAME_BATCH_COALESCE_SECONDS

                    while len(batch) < WS_FRAME_BATCH_MAX_ITEMS:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        try:
                            candidate = outbound.get(timeout=remaining)
                        except queue.Empty:
                            break
                        if candidate is _CLOSE:
                            close_after_batch = True
                            break
                        candidate_raw, candidate_binary = candidate  # type: ignore[misc]
                        candidate_size = self._encoded_size(candidate_raw)
                        if encoded_bytes + candidate_size > WS_FRAME_BATCH_MAX_BASE64_BYTES:
                            pending = candidate
                            break
                        batch.append(make_frame(candidate_raw, bool(candidate_binary)))
                        encoded_bytes += candidate_size

                    if close_after_batch:
                        batch.append(make_close())
                    self._post_ws_frames(batch)
                    if close_after_batch:
                        return
            except Exception as exc:
                sender_failed.set()
                self._report_error(
                    RuntimeError(
                        f"ws_frame_sender_failed:channel={channel_id[:8]}:{str(exc)[:220]}"
                    )
                )
                try:
                    ws.close()
                except Exception:
                    pass

        sender_thread = threading.Thread(
            target=sender,
            daemon=True,
            name=f"gpubnb-ws-send-{channel_id[:8]}",
        )
        sender_thread.start()

        try:
            while not self.stop_event.is_set():
                if sender_failed.is_set():
                    raise RuntimeError(f"ws_frame_sender_unavailable:channel={channel_id[:8]}")
                opcode, data = ws.recv_data()
                if opcode == websocket.ABNF.OPCODE_CLOSE:
                    break
                if opcode not in {
                    websocket.ABNF.OPCODE_TEXT,
                    websocket.ABNF.OPCODE_BINARY,
                }:
                    continue
                raw = data.encode() if isinstance(data, str) else bytes(data)
                if len(raw) > legacy.WS_MAX_FRAME_BYTES:
                    raise RuntimeError(
                        f"ws_frame_too_large:channel={channel_id[:8]}:len={len(raw)}:max={legacy.WS_MAX_FRAME_BYTES}"
                    )
                frame_count += 1
                if frame_count == 1:
                    self._report_error(
                        RuntimeError(
                            f"ws_channel_first_frame:channel={channel_id[:8]}:opcode={opcode}:len={len(raw)}"
                        )
                    )
                try:
                    outbound.put(
                        (raw, opcode == websocket.ABNF.OPCODE_BINARY),
                        timeout=WS_QUEUE_PUT_TIMEOUT_SECONDS,
                    )
                except queue.Full as exc:
                    raise RuntimeError(
                        f"ws_outbound_backpressure:channel={channel_id[:8]}:queued={outbound.qsize()}"
                    ) from exc
        except Exception as exc:
            self._report_error(exc)
        finally:
            self._report_error(
                RuntimeError(
                    f"ws_channel_closed:channel={channel_id[:8]}:frames={frame_count}"
                )
            )
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            try:
                outbound.put(_CLOSE, timeout=WS_QUEUE_PUT_TIMEOUT_SECONDS)
            except queue.Full:
                self._report_error(
                    RuntimeError(
                        f"ws_close_backpressure:channel={channel_id[:8]}:queued={outbound.qsize()}"
                    )
                )
            sender_thread.join(timeout=WS_SENDER_JOIN_TIMEOUT_SECONDS)
            if sender_thread.is_alive():
                self._report_error(
                    RuntimeError(f"ws_frame_sender_shutdown_timeout:channel={channel_id[:8]}")
                )

    def _reconcile_loop(self) -> None:
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                self._reconcile_sessions()
            except Exception as exc:
                self._report_error(exc)
            elapsed = time.monotonic() - started
            delay = max(0.0, legacy.RECONCILE_INTERVAL_SECONDS - elapsed)
            if self.stop_event.wait(delay):
                return

    def run(self) -> None:
        # Preserve the old startup guarantee: adopt/start any already-active
        # runtime once before accepting control messages.  Ongoing Docker scans
        # then move to their own worker so they never stall Management traffic.
        try:
            self._reconcile_sessions()
        except Exception as exc:
            self._report_error(exc)

        reconcile_thread = threading.Thread(
            target=self._reconcile_loop,
            daemon=True,
            name="gpubnb-workspace-reconcile",
        )
        reconcile_thread.start()
        try:
            while not self.stop_event.is_set():
                try:
                    items = self._next_items()
                    for item in items:
                        self._handle(item)
                except Exception as exc:
                    self._report_error(exc)
                    if self.stop_event.wait(1.0):
                        return
                else:
                    self._last_error_signature = None
                    if items and self.stop_event.wait(CONTROL_BURST_PAUSE_SECONDS):
                        return
        finally:
            self.stop_event.set()
            reconcile_thread.join(timeout=2.0)


def install() -> None:
    """Install the transport supervisor while preserving the public API module."""
    legacy.GatewaySupervisor = GatewaySupervisor
