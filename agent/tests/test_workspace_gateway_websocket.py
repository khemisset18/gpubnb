from __future__ import annotations

import base64
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import websocket

from gpubnb_agent import workspace_gateway as legacy
from gpubnb_agent.workspace_gateway_v2 import GatewaySupervisor


def make_supervisor(errors: list[str] | None = None) -> GatewaySupervisor:
    supervisor = object.__new__(GatewaySupervisor)
    supervisor.api = MagicMock()
    supervisor.key = MagicMock()
    supervisor.machine_id = "machine-1"
    supervisor.config = {}
    supervisor.runtimes = {}
    supervisor.channels = {}
    supervisor.session_channels = {}
    supervisor.usage_last_report = {}
    supervisor.start_failures = {}
    supervisor.start_retry_at = {}
    supervisor.stop_event = threading.Event()
    supervisor._supports_ws_frame_batch = None
    supervisor._supports_next_batch = None
    supervisor._trace_started_at = time.monotonic()
    supervisor._browser_frame_seen = set()
    supervisor._http_queue = __import__("queue").Queue(maxsize=128)
    supervisor._http_workers_lock = threading.Lock()
    supervisor._http_workers_started = False
    supervisor._last_error_signature = None
    supervisor._last_error_reported_at = 0.0
    supervisor._error_callback = (
        (lambda exc: errors.append(str(exc))) if errors is not None else None
    )
    return supervisor


class ControlLoopIsolationTests(unittest.TestCase):
    def test_slow_reconciliation_does_not_block_control_messages(self) -> None:
        supervisor = make_supervisor()
        reconcile_started = threading.Event()
        release_reconcile = threading.Event()
        handled = threading.Event()
        next_calls = 0

        def reconcile() -> None:
            reconcile_started.set()
            release_reconcile.wait(timeout=2)

        def next_items() -> list[dict[str, str]]:
            nonlocal next_calls
            next_calls += 1
            if next_calls == 1:
                return [{"kind": "ws_close", "channelId": "missing"}]
            supervisor.stop_event.set()
            return []

        supervisor._reconcile_sessions = reconcile  # type: ignore[method-assign]
        supervisor._next_items = next_items  # type: ignore[method-assign]
        original_handle = supervisor._handle

        def handle(item: dict[str, str]) -> None:
            handled.set()
            original_handle(item)

        supervisor._handle = handle  # type: ignore[method-assign]
        thread = threading.Thread(target=supervisor.run)
        thread.start()
        self.assertTrue(reconcile_started.wait(timeout=1))
        self.assertTrue(handled.wait(timeout=1))
        release_reconcile.set()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())


class HttpRelaySchedulingTests(unittest.TestCase):
    def test_slow_http_asset_does_not_block_extension_host_open(self) -> None:
        supervisor = make_supervisor()
        first_http_started = threading.Event()
        release_http = threading.Event()
        ws_open_seen = threading.Event()
        supervisor._ensure_http_workers = lambda: None  # type: ignore[method-assign]

        def slow_http(_item: dict[str, str]) -> None:
            first_http_started.set()
            release_http.wait(timeout=2)

        supervisor._http = slow_http  # type: ignore[method-assign]
        worker = threading.Thread(target=slow_http, args=({},), daemon=True)
        worker.start()
        self.assertTrue(first_http_started.wait(timeout=1))

        def open_ws(_item: dict[str, str]) -> None:
            ws_open_seen.set()

        supervisor._ws_open = open_ws  # type: ignore[method-assign]
        supervisor._handle({"kind": "ws_open"})
        self.assertTrue(ws_open_seen.wait(timeout=1))
        release_http.set()
        worker.join(timeout=2)


class WebSocketOpenAckTests(unittest.TestCase):
    def test_successful_local_open_reports_101(self) -> None:
        calls: list[tuple[str, str, dict[str, object] | None]] = []
        supervisor = make_supervisor()
        supervisor.runtimes["session-1"] = MagicMock(port=34567)
        supervisor._request = lambda path, method="GET", body=None: calls.append((path, method, body)) or {}  # type: ignore[method-assign]
        fake_ws = MagicMock()
        fake_ws.subprotocol = None

        with patch("gpubnb_agent.workspace_gateway_v2.websocket.create_connection", return_value=fake_ws):
            supervisor._ws_open({
                "id": "request-1",
                "kind": "ws_open",
                "sessionId": "session-1",
                "channelId": "channel-1",
                "path": "/socket",
                "headers": {},
            })

        deadline = time.time() + 1
        while not calls and time.time() < deadline:
            time.sleep(0.01)
        self.assertTrue(any(body and body.get("status") == 101 for _, _, body in calls))
        supervisor.stop_event.set()
        fake_ws.close()

    def test_local_connect_failure_reports_502_and_keeps_no_channel(self) -> None:
        calls: list[tuple[str, str, dict[str, object] | None]] = []
        supervisor = make_supervisor()
        supervisor.runtimes["session-1"] = MagicMock(port=34567)
        supervisor._request = lambda path, method="GET", body=None: calls.append((path, method, body)) or {}  # type: ignore[method-assign]

        with patch("gpubnb_agent.workspace_gateway_v2.websocket.create_connection", side_effect=OSError("refused")):
            supervisor._ws_open({
                "id": "request-2",
                "kind": "ws_open",
                "sessionId": "session-1",
                "channelId": "channel-2",
                "path": "/socket",
                "headers": {},
            })

        self.assertNotIn("channel-2", supervisor.channels)
        self.assertTrue(any(body and body.get("status") == 502 for _, _, body in calls))

    def test_lost_101_report_never_closes_a_healthy_local_socket(self) -> None:
        errors: list[str] = []
        supervisor = make_supervisor(errors)
        supervisor.runtimes["session-1"] = MagicMock(port=34567)
        fake_ws = MagicMock()
        fake_ws.subprotocol = None

        def request(_path: str, _method: str = "GET", body=None):
            if body and body.get("status") == 101:
                raise RuntimeError("network lost")
            return {}

        supervisor._request = request  # type: ignore[method-assign]
        with patch("gpubnb_agent.workspace_gateway_v2.websocket.create_connection", return_value=fake_ws):
            supervisor._ws_open({
                "id": "request-3",
                "kind": "ws_open",
                "sessionId": "session-1",
                "channelId": "channel-3",
                "path": "/socket",
                "headers": {},
            })

        deadline = time.time() + 1
        while not errors and time.time() < deadline:
            time.sleep(0.01)
        self.assertIn("channel-3", supervisor.channels)
        self.assertFalse(fake_ws.close.called)
        self.assertTrue(any("ws_open_ack_report_failed" in error for error in errors))
        supervisor.stop_event.set()
        fake_ws.close()


class WebSocketFrameGuardTests(unittest.TestCase):
    def test_oversized_upstream_frame_is_never_posted_to_api(self) -> None:
        calls: list[tuple[str, dict[str, object]]] = []
        errors: list[str] = []
        supervisor = make_supervisor(errors)
        supervisor._post_ws_frames = lambda frames: calls.append(("frames", {"frames": frames}))  # type: ignore[method-assign]
        fake_ws = MagicMock()
        fake_ws.recv_data.side_effect = [
            (websocket.ABNF.OPCODE_BINARY, b"x" * (legacy.WS_MAX_FRAME_BYTES + 1)),
            (websocket.ABNF.OPCODE_CLOSE, b""),
        ]
        supervisor.channels["channel-4"] = fake_ws
        supervisor.session_channels["session-1"] = {"channel-4"}

        supervisor._ws_reader("session-1", "channel-4", fake_ws)

        sent_frames = [
            frame
            for _, body in calls
            for frame in body.get("frames", [])
            if frame.get("close") is not True
        ]
        self.assertEqual(sent_frames, [])
        self.assertTrue(any("ws_frame_too_large" in error for error in errors))
        close_frames = [
            frame
            for _, body in calls
            for frame in body.get("frames", [])
            if frame.get("close") is True
        ]
        self.assertEqual(len(close_frames), 1)

    def test_failed_browser_to_upstream_send_removes_stale_channel(self) -> None:
        errors: list[str] = []
        # Import the installed public supervisor so this regression follows the
        # active v3 browser-frame relay rather than testing the superseded v2 send.
        from gpubnb_agent import workspace_gateway

        supervisor = object.__new__(workspace_gateway.GatewaySupervisor)
        supervisor.channels = {}
        supervisor.session_channels = {}
        supervisor._browser_frame_seen = set()
        supervisor._error_callback = lambda exc: errors.append(str(exc))
        supervisor._last_error_signature = None
        supervisor._last_error_reported_at = 0.0
        supervisor._trace_started_at = time.monotonic()
        ws = MagicMock()
        ws.send.side_effect = OSError("socket closed")
        supervisor.channels["channel-5"] = ws
        supervisor.session_channels["session-1"] = {"channel-5"}

        supervisor._handle({
            "kind": "ws_send",
            "sessionId": "session-1",
            "channelId": "channel-5",
            "dataBase64": "eA==",
            "binary": True,
        })

        self.assertNotIn("channel-5", supervisor.channels)
        self.assertNotIn("channel-5", supervisor.session_channels["session-1"])
        ws.close.assert_called_once()
        self.assertTrue(any("socket closed" in error for error in errors))


class WebSocketBatchTransportTests(unittest.TestCase):
    def test_reader_drains_local_socket_while_api_batch_is_slow(self) -> None:
        supervisor = make_supervisor()
        batch_started = threading.Event()
        release_batch = threading.Event()
        frames: list[dict[str, object]] = []

        def slow_post(batch: list[dict[str, object]]) -> None:
            batch_started.set()
            release_batch.wait(timeout=2)
            frames.extend(batch)

        supervisor._post_ws_frames = slow_post  # type: ignore[method-assign]
        fake_ws = MagicMock()
        fake_ws.recv_data.side_effect = [
            (websocket.ABNF.OPCODE_BINARY, b"one"),
            (websocket.ABNF.OPCODE_BINARY, b"two"),
            (websocket.ABNF.OPCODE_CLOSE, b""),
        ]
        supervisor.channels["channel-6"] = fake_ws
        supervisor.session_channels["session-1"] = {"channel-6"}

        reader = threading.Thread(target=supervisor._ws_reader, args=("session-1", "channel-6", fake_ws))
        reader.start()
        self.assertTrue(batch_started.wait(timeout=1))
        # The local reader should continue into the second frame while the Internet
        # sender is deliberately blocked on the first batch.
        deadline = time.time() + 1
        while fake_ws.recv_data.call_count < 2 and time.time() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(fake_ws.recv_data.call_count, 2)
        release_batch.set()
        reader.join(timeout=2)
        self.assertFalse(reader.is_alive())
        data_frames = [frame for frame in frames if not frame.get("close")]
        self.assertEqual([base64.b64decode(str(frame["dataBase64"])) for frame in data_frames], [b"one", b"two"])

    def test_batch_endpoint_falls_back_to_legacy_single_frame_route(self) -> None:
        supervisor = make_supervisor()
        calls: list[tuple[str, str, dict[str, object] | None]] = []

        def request(path: str, method: str = "GET", body=None):
            calls.append((path, method, body))
            if path.endswith("/ws-frames"):
                raise RuntimeError('API HTTP 404: {"error":"Not Found"}')
            return {}

        supervisor._request = request  # type: ignore[method-assign]
        supervisor._post_ws_frames([
            {
                "frameId": "frame-1",
                "channelId": "channel-7",
                "dataBase64": "eA==",
                "binary": True,
            }
        ])

        self.assertFalse(supervisor._supports_ws_frame_batch)
        self.assertTrue(any(path.endswith("/ws-frame") for path, _, _ in calls))


if __name__ == "__main__":
    unittest.main()
