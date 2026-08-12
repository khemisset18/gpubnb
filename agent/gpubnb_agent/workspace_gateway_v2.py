"""High-throughput transport for the outbound Developer Workspace gateway.

This module deliberately subclasses the hardened lifecycle implementation in
``workspace_gateway`` instead of duplicating container/mining safety logic. It
only replaces the latency-sensitive tunnel loop:

* code-server WebSocket readers never wait on an Internet HTTPS round trip;
* upstream frames are micro-batched with stable frame IDs so API retries are
  idempotent;
* browser->host commands are drained from the API in ordered batches;
* expensive Docker/session reconciliation runs outside the control-message loop;
* local WebSocket connect deadlines do not become long-lived read deadlines;
* HTTP startup bursts queue behind a bounded worker pool instead of failing as
  soon as all workers are busy.

The legacy single-frame/next endpoints remain as an automatic rollout fallback.
"""
from __future__ import annotations

import base64
import queue
import re
import threading
import time
import uuid
from typing import Any

import websocket

from . import workspace_gateway as legacy

WS_OUTBOUND_QUEUE_MAX_ITEMS = 256
WS_OUTBOUND_QUEUE_MAX_BYTES = 12 * 1024 * 1024
WS_FRAME_BATCH_MAX_ITEMS = 32
WS_FRAME_BATCH_MAX_BASE64_BYTES = 8 * 1024 * 1024
WS_FRAME_BATCH_COALESCE_SECONDS = 0.004
WS_QUEUE_PUT_TIMEOUT_SECONDS = 2.0
WS_SENDER_JOIN_TIMEOUT_SECONDS = 15.0
CONTROL_BURST_PAUSE_SECONDS = 0.005
NEXT_BATCH_MAX_ITEMS = 64
LOCAL_WS_CONNECT_TIMEOUT_SECONDS = 10.0
HTTP_RELAY_QUEUE_MAX_ITEMS = 128
HTTP_RELAY_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
WS_SUBPROTOCOL_MAX_ITEMS = 16
WS_SUBPROTOCOL_MAX_LENGTH = 128

_CLOSE = object()
_WS_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


class _FrameBuffer:
    """Bound a channel by bytes while allowing realistic bursts of small frames."""

    def __init__(self, *, max_items: int, max_bytes: int) -> None:
        self._queue: queue.Queue[object] = queue.Queue(maxsize=max_items)
        self._max_bytes = max_bytes
        self._queued_bytes = 0
        self._bytes_changed = threading.Condition()

    def put_frame(self, raw: bytes, binary: bool, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        with self._bytes_changed:
            while self._queued_bytes + len(raw) > self._max_bytes:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Full
                self._bytes_changed.wait(remaining)
            self._queued_bytes += len(raw)

        remaining = max(0.0, deadline - time.monotonic())
        try:
            self._queue.put((raw, binary), timeout=remaining)
        except queue.Full:
            with self._bytes_changed:
                self._queued_bytes -= len(raw)
                self._bytes_changed.notify_all()
            raise

    def put_close(self, timeout: float) -> None:
        self._queue.put(_CLOSE, timeout=timeout)

    def get(self, timeout: float | None = None) -> object:
        if timeout is None:
            item = self._queue.get()
        else:
            item = self._queue.get(timeout=timeout)
        if item is not _CLOSE:
            raw, _binary = item  # type: ignore[misc]
            with self._bytes_changed:
                self._queued_bytes -= len(raw)
                self._bytes_changed.notify_all()
        return item

    def qsize(self) -> int:
        return self._queue.qsize()

    def queued_bytes(self) -> int:
        with self._bytes_changed:
            return self._queued_bytes


class GatewaySupervisor(legacy.GatewaySupervisor):
    """Gateway supervisor with a transport path suitable for VS Code bursts."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._supports_ws_frame_batch: bool | None = None
        self._supports_next_batch: bool | None = None
        self._trace_started_at = time.monotonic()
        self._browser_frame_seen: set[str] = set()
        self._http_queue: queue.Queue[dict[str, Any]] = queue.Queue(
            maxsize=HTTP_RELAY_QUEUE_MAX_ITEMS
        )
        self._http_workers_lock = threading.Lock()
        self._http_workers_started = False

    def _trace(
        self,
        event: str,
        *,
        session_id: str = "",
        channel_id: str = "",
        detail: str = "",
    ) -> None:
        elapsed_ms = int((time.monotonic() - self._trace_started_at) * 1000)
        parts = [f"workspace_trace:{event}", f"t={elapsed_ms}ms"]
        if session_id:
            parts.append(f"session={session_id[:8]}")
        if channel_id:
            parts.append(f"channel={channel_id[:8]}")
        if detail:
            parts.append(detail[:220])
        self._report_error(RuntimeError(":".join(parts)))

    @staticmethod
    def _is_missing_endpoint(error: Exception) -> bool:
        text = str(error)
        return "API HTTP 404" in text or '"error":"Not Found"' in text

    @staticmethod
    def _subprotocols(headers: dict[Any, Any]) -> list[str]:
        raw = ""
        for key, value in headers.items():
            if str(key).lower() == "sec-websocket-protocol":
                raw = str(value)
                break
        if not raw:
            return []
        values = [part.strip() for part in raw.split(",") if part.strip()]
        if len(values) > WS_SUBPROTOCOL_MAX_ITEMS:
            raise RuntimeError("ws_subprotocol_count_exceeded")
        for value in values:
            if len(value) > WS_SUBPROTOCOL_MAX_LENGTH or not _WS_TOKEN.fullmatch(value):
                raise RuntimeError("ws_subprotocol_invalid")
        return values

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

    @staticmethod
    def _read_relay_body(stream: Any) -> bytes:
        data = stream.read(HTTP_RELAY_MAX_RESPONSE_BYTES + 1)
        if len(data) > HTTP_RELAY_MAX_RESPONSE_BYTES:
            raise RuntimeError(
                f"workspace_http_response_too_large:max={HTTP_RELAY_MAX_RESPONSE_BYTES}"
            )
        return data

    def _http(self, item: dict[str, Any]) -> None:
        request_id = str(item.get("id") or "")
        try:
            runtime = self._runtime_for(str(item.get("sessionId") or ""))
            path = str(item.get("path") or "/")
            if not path.startswith("/") or ".." in path:
                raise RuntimeError("invalid_relay_path")
            body = base64.b64decode(str(item.get("bodyBase64") or ""), validate=False)
            headers = {
                str(k): str(v)
                for k, v in (item.get("headers") or {}).items()
                if str(k).lower() not in {"host", "cookie", "authorization"}
            }
            req = legacy.urllib.request.Request(
                f"http://127.0.0.1:{runtime.port}{path}",
                data=body if body else None,
                method=str(item.get("method") or "GET"),
                headers=headers,
            )
            try:
                response = legacy._RELAY_OPENER.open(req, timeout=25)
                status = response.status
                response_headers = dict(response.headers.items())
                data = self._read_relay_body(response)
            except legacy.urllib.error.HTTPError as exc:
                status = exc.code
                response_headers = dict(exc.headers.items())
                data = self._read_relay_body(exc)
            payload = {
                "machineId": self.machine_id,
                "id": request_id,
                "status": status,
                "headers": response_headers,
                "bodyBase64": base64.b64encode(data).decode(),
            }
        except Exception as exc:
            payload = {
                "machineId": self.machine_id,
                "id": request_id,
                "status": 502,
                "error": str(exc)[:200],
            }
        self._request("/agent/workspace-gateway/respond", "POST", payload)

    def _ensure_http_workers(self) -> None:
        if self._http_workers_started:
            return
        with self._http_workers_lock:
            if self._http_workers_started:
                return

            def worker(index: int) -> None:
                while not self.stop_event.is_set():
                    try:
                        item = self._http_queue.get(timeout=0.5)
                    except queue.Empty:
                        continue
                    try:
                        self._http(item)
                    except Exception as exc:
                        self._report_error(exc)
                    finally:
                        self._http_queue.task_done()

            for index in range(legacy.HTTP_RELAY_MAX_CONCURRENCY):
                threading.Thread(
                    target=worker,
                    args=(index,),
                    daemon=True,
                    name=f"gpubnb-http-worker-{index + 1}",
                ).start()
            self._http_workers_started = True

    def _dispatch_http(self, item: dict[str, Any]) -> None:
        """Queue startup assets so a short HTTP burst does not create 503 holes."""
        self._ensure_http_workers()
        try:
            self._http_queue.put_nowait(item)
            return
        except queue.Full:
            request_id = str(item.get("id") or "")
            self._trace(
                "http_queue_overflow",
                session_id=str(item.get("sessionId") or ""),
                detail=f"queued={self._http_queue.qsize()}",
            )
        try:
            self._request(
                "/agent/workspace-gateway/respond",
                "POST",
                {
                    "machineId": self.machine_id,
                    "id": request_id,
                    "status": 503,
                    "error": "workspace_http_relay_queue_full",
                },
            )
        except Exception as exc:
            self._report_error(exc)

    def _ws_open(self, item: dict[str, Any]) -> None:
        request_id = str(item.get("id") or "")
        session_id = str(item.get("sessionId") or "")
        channel_id = str(item.get("channelId") or "")
        path = str(item.get("path") or "/")
        ws: websocket.WebSocket | None = None

        def report_failure(error: Exception) -> None:
            self._trace(
                "ws_open_failed",
                session_id=session_id,
                channel_id=channel_id,
                detail=str(error),
            )
            self._report_error(error)
            if not request_id:
                return
            try:
                self._request(
                    "/agent/workspace-gateway/respond",
                    "POST",
                    {
                        "machineId": self.machine_id,
                        "id": request_id,
                        "status": 502,
                        "error": str(error)[:200],
                    },
                )
            except Exception as report_exc:
                self._report_error(report_exc)

        try:
            if not channel_id or not path.startswith("/") or ".." in path:
                raise RuntimeError(
                    f"ws_channel_open_rejected:path={path[:80]!r}:channel_present={bool(channel_id)}"
                )
            runtime = self._runtime_for(session_id)
            incoming_headers = item.get("headers") or {}
            if not isinstance(incoming_headers, dict):
                raise RuntimeError("ws_headers_invalid")
            subprotocols = self._subprotocols(incoming_headers)
            headers = [
                f"{k}: {v}"
                for k, v in incoming_headers.items()
                if str(k).lower()
                not in {
                    "host",
                    "origin",
                    "cookie",
                    "authorization",
                    "connection",
                    "upgrade",
                    "sec-websocket-key",
                    "sec-websocket-version",
                    "sec-websocket-extensions",
                    "sec-websocket-protocol",
                }
            ]
            self._trace(
                "ws_open_received",
                session_id=session_id,
                channel_id=channel_id,
                detail=f"path={path[:80]!r}:subprotocols={len(subprotocols)}",
            )
            handshake_started = time.monotonic()
            ws = websocket.create_connection(
                f"ws://127.0.0.1:{runtime.port}{path}",
                header=headers,
                origin=f"http://127.0.0.1:{runtime.port}",
                timeout=LOCAL_WS_CONNECT_TIMEOUT_SECONDS,
                enable_multithread=True,
                subprotocols=subprotocols or None,
            )
            # create_connection(timeout=...) applies the timeout to the socket,
            # not just the handshake. VS Code channels are long-lived and may be
            # legitimately silent for >10s, so remove the read deadline only
            # after the local handshake has succeeded.
            ws.settimeout(None)
            handshake_ms = int((time.monotonic() - handshake_started) * 1000)
            self.channels[channel_id] = ws
            self.session_channels.setdefault(session_id, set()).add(channel_id)
            self._trace(
                "ws_local_connected",
                session_id=session_id,
                channel_id=channel_id,
                detail=f"handshake={handshake_ms}ms:selected={bool(ws.subprotocol)}",
            )
            reader = threading.Thread(
                target=self._ws_reader,
                args=(session_id, channel_id, ws),
                daemon=True,
                name=f"gpubnb-ws-{channel_id[:8]}",
            )
            reader.start()
        except Exception as exc:
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            report_failure(exc)
            return

        if request_id:
            def report_open_ack() -> None:
                started = time.monotonic()
                try:
                    self._request(
                        "/agent/workspace-gateway/respond",
                        "POST",
                        {"machineId": self.machine_id, "id": request_id, "status": 101},
                    )
                    self._trace(
                        "ws_open_ack",
                        session_id=session_id,
                        channel_id=channel_id,
                        detail=f"post={int((time.monotonic() - started) * 1000)}ms",
                    )
                except Exception as exc:
                    self._report_error(
                        RuntimeError(
                            f"ws_open_ack_report_failed:channel={channel_id[:8]}:{str(exc)[:180]}"
                        )
                    )

            threading.Thread(
                target=report_open_ack,
                daemon=True,
                name=f"gpubnb-ws-ack-{channel_id[:8]}",
            ).start()

    def _ws_reader(self, session_id: str, channel_id: str, ws: websocket.WebSocket) -> None:
        """Drain code-server immediately while a sender batches Internet writes."""
        outbound = _FrameBuffer(
            max_items=WS_OUTBOUND_QUEUE_MAX_ITEMS,
            max_bytes=WS_OUTBOUND_QUEUE_MAX_BYTES,
        )
        sender_failed = threading.Event()
        frame_count = 0
        first_batch = True

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
            nonlocal first_batch
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
                    started = time.monotonic()
                    self._post_ws_frames(batch)
                    if first_batch:
                        self._trace(
                            "ws_first_upstream_batch",
                            session_id=session_id,
                            channel_id=channel_id,
                            detail=(
                                f"frames={len(batch)}:encoded={encoded_bytes}:"
                                f"post={int((time.monotonic() - started) * 1000)}ms"
                            ),
                        )
                        first_batch = False
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
                    raise RuntimeError(
                        f"ws_frame_sender_unavailable:channel={channel_id[:8]}"
                    )
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
                        f"ws_frame_too_large:channel={channel_id[:8]}:"
                        f"len={len(raw)}:max={legacy.WS_MAX_FRAME_BYTES}"
                    )
                frame_count += 1
                if frame_count == 1:
                    self._trace(
                        "ws_first_local_frame",
                        session_id=session_id,
                        channel_id=channel_id,
                        detail=f"opcode={opcode}:len={len(raw)}",
                    )
                try:
                    outbound.put_frame(
                        raw,
                        opcode == websocket.ABNF.OPCODE_BINARY,
                        timeout=WS_QUEUE_PUT_TIMEOUT_SECONDS,
                    )
                except queue.Full as exc:
                    raise RuntimeError(
                        f"ws_outbound_backpressure:channel={channel_id[:8]}:"
                        f"queued={outbound.qsize()}:bytes={outbound.queued_bytes()}"
                    ) from exc
        except Exception as exc:
            self._report_error(exc)
        finally:
            self._trace(
                "ws_closed",
                session_id=session_id,
                channel_id=channel_id,
                detail=f"frames={frame_count}",
            )
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            self._browser_frame_seen.discard(channel_id)
            try:
                outbound.put_close(timeout=WS_QUEUE_PUT_TIMEOUT_SECONDS)
            except queue.Full:
                self._report_error(
                    RuntimeError(
                        f"ws_close_backpressure:channel={channel_id[:8]}:"
                        f"queued={outbound.qsize()}:bytes={outbound.queued_bytes()}"
                    )
                )
            sender_thread.join(timeout=WS_SENDER_JOIN_TIMEOUT_SECONDS)
            if sender_thread.is_alive():
                self._report_error(
                    RuntimeError(
                        f"ws_frame_sender_shutdown_timeout:channel={channel_id[:8]}"
                    )
                )

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")
        if kind == "ws_send":
            channel_id = str(item.get("channelId") or "")
            if channel_id and channel_id not in self._browser_frame_seen:
                self._browser_frame_seen.add(channel_id)
                self._trace(
                    "ws_first_browser_frame",
                    session_id=str(item.get("sessionId") or ""),
                    channel_id=channel_id,
                    detail=f"base64={len(str(item.get('dataBase64') or ''))}",
                )
        elif kind == "ws_close":
            self._browser_frame_seen.discard(str(item.get("channelId") or ""))
        super()._handle(item)

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
