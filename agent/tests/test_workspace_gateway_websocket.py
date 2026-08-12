from __future__ import annotations

import subprocess
import threading
import unittest
from unittest.mock import MagicMock, patch

import websocket

from gpubnb_agent.workspace_gateway import (
    WS_MAX_FRAME_BYTES,
    GatewaySupervisor,
    Runtime,
)


class ImmediateThread:
    def __init__(self, target, args=(), kwargs=None, **_options):
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}

    def start(self) -> None:
        self.target(*self.args, **self.kwargs)


class DummyInspector:
    def running_processes(self):
        return []

    def terminate(self, _pid):
        return None

    def is_running(self, _pid):
        return False


def make_supervisor(error_sink: list[str] | None = None) -> GatewaySupervisor:
    def docker(args, timeout=30, check=True):
        return subprocess.CompletedProcess(args, 0, "", "")

    supervisor = GatewaySupervisor(
        api=None,
        key=None,
        machine_id="machine-1",
        config={},
        docker_runner=docker,
        process_inspector=DummyInspector(),
        health_check=lambda _port: True,
        mining_guard=lambda: True,
        error_callback=(lambda exc: error_sink.append(str(exc))) if error_sink is not None else None,
    )
    supervisor.runtimes["session-1"] = Runtime(
        "session-1",
        "workspace",
        "proxy",
        "volume",
        "network",
        41000,
    )
    return supervisor


class HttpRelaySchedulingTests(unittest.TestCase):
    def test_slow_http_asset_does_not_block_extension_host_open(self) -> None:
        supervisor = make_supervisor()
        http_started = threading.Event()
        release_http = threading.Event()
        websocket_seen = threading.Event()

        def slow_http(_item: dict) -> None:
            http_started.set()
            release_http.wait(2)

        supervisor._http = slow_http  # type: ignore[method-assign]
        supervisor._ws_open = lambda _item: websocket_seen.set()  # type: ignore[method-assign]

        try:
            supervisor._handle({
                "id": "asset-1",
                "kind": "http",
                "sessionId": "session-1",
                "path": "/stable/static/workbench.js",
            })
            self.assertTrue(http_started.wait(1), "HTTP worker never started")

            supervisor._handle({
                "id": "extension-host-open",
                "kind": "ws_open",
                "sessionId": "session-1",
                "channelId": "extension-host",
                "path": "/stable",
            })
            self.assertTrue(
                websocket_seen.wait(0.25),
                "ws_open was serialized behind a slow HTTP asset",
            )
        finally:
            release_http.set()


class WebSocketOpenAckTests(unittest.TestCase):
    def test_successful_local_open_reports_101(self) -> None:
        supervisor = make_supervisor()
        calls: list[tuple[str, str, dict | None]] = []
        supervisor._request = lambda path, method="GET", body=None: (calls.append((path, method, body)), {"ok": True})[1]  # type: ignore[method-assign]
        ws = MagicMock()

        with patch("gpubnb_agent.workspace_gateway.websocket.create_connection", return_value=ws), \
             patch.object(supervisor, "_ws_reader"), \
             patch("gpubnb_agent.workspace_gateway.threading.Thread", ImmediateThread):
            supervisor._ws_open({
                "id": "open-1",
                "sessionId": "session-1",
                "channelId": "channel-1",
                "path": "/",
                "headers": {},
            })

        ack = [body for path, method, body in calls if path.endswith("/respond") and method == "POST"]
        self.assertEqual(ack, [{"machineId": "machine-1", "id": "open-1", "status": 101}])
        self.assertIn("channel-1", supervisor.channels)
        ws.close.assert_not_called()

    def test_lost_101_report_never_closes_a_healthy_local_socket(self) -> None:
        errors: list[str] = []
        supervisor = make_supervisor(errors)
        ws = MagicMock()

        def request(path, method="GET", body=None):
            if path.endswith("/respond") and body and body.get("status") == 101:
                raise ConnectionError("simulated ack response loss")
            return {"ok": True}

        supervisor._request = request  # type: ignore[method-assign]
        with patch("gpubnb_agent.workspace_gateway.websocket.create_connection", return_value=ws), \
             patch.object(supervisor, "_ws_reader"), \
             patch("gpubnb_agent.workspace_gateway.threading.Thread", ImmediateThread):
            supervisor._ws_open({
                "id": "open-2",
                "sessionId": "session-1",
                "channelId": "channel-2",
                "path": "/",
                "headers": {},
            })

        self.assertIn("channel-2", supervisor.channels)
        ws.close.assert_not_called()
        self.assertTrue(any("ws_open_ack_report_failed" in error for error in errors))

    def test_local_connect_failure_reports_502_and_keeps_no_channel(self) -> None:
        supervisor = make_supervisor()
        calls: list[dict] = []
        supervisor._request = lambda _path, _method="GET", body=None: (calls.append(body or {}), {"ok": True})[1]  # type: ignore[method-assign]

        with patch("gpubnb_agent.workspace_gateway.websocket.create_connection", side_effect=OSError("connect refused")):
            supervisor._ws_open({
                "id": "open-3",
                "sessionId": "session-1",
                "channelId": "channel-3",
                "path": "/",
                "headers": {},
            })

        self.assertNotIn("channel-3", supervisor.channels)
        self.assertEqual(calls[-1]["status"], 502)
        self.assertIn("connect refused", calls[-1]["error"])


class WebSocketFrameGuardTests(unittest.TestCase):
    def test_oversized_upstream_frame_is_never_posted_to_api(self) -> None:
        errors: list[str] = []
        supervisor = make_supervisor(errors)
        calls: list[tuple[str, dict]] = []
        supervisor._request = lambda path, _method="GET", body=None: (calls.append((path, body or {})), {"ok": True})[1]  # type: ignore[method-assign]
        ws = MagicMock()
        ws.recv_data.return_value = (
            websocket.ABNF.OPCODE_BINARY,
            b"x" * (WS_MAX_FRAME_BYTES + 1),
        )
        supervisor.channels["channel-4"] = ws
        supervisor.session_channels["session-1"] = {"channel-4"}

        supervisor._ws_reader("session-1", "channel-4", ws)

        sent_frames = [
            frame
            for path, body in calls
            if path.endswith("/ws-frames")
            for frame in body.get("frames", [])
            if frame.get("close") is not True
        ]
        self.assertEqual(sent_frames, [])
        self.assertTrue(any("ws_frame_too_large" in error for error in errors))
        close_frames = [
            frame
            for path, body in calls
            if path.endswith("/ws-frames")
            for frame in body.get("frames", [])
            if frame.get("close") is True
        ]
        self.assertEqual(len(close_frames), 1)

    def test_failed_browser_to_upstream_send_removes_stale_channel(self) -> None:
        errors: list[str] = []
        supervisor = make_supervisor(errors)
        ws = MagicMock()
        ws.send_binary.side_effect = OSError("socket closed")
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
        calls: list[dict] = []
        ws = MagicMock()
        ws.recv_data.side_effect = [
            (websocket.ABNF.OPCODE_BINARY, b"first"),
            (websocket.ABNF.OPCODE_BINARY, b"second"),
            (websocket.ABNF.OPCODE_CLOSE, b""),
        ]

        def request(path, _method="GET", body=None):
            if path.endswith("/ws-frames"):
                calls.append(body or {})
                batch_started.set()
                release_batch.wait(2)
            return {"ok": True}

        supervisor._request = request  # type: ignore[method-assign]
        reader = threading.Thread(
            target=supervisor._ws_reader,
            args=("session-1", "channel-batch", ws),
            daemon=True,
        )
        reader.start()
        try:
            self.assertTrue(batch_started.wait(1), "batch sender never started")
            self.assertEqual(
                ws.recv_data.call_count,
                3,
                "local code-server reader blocked on the WAN/API request",
            )
        finally:
            release_batch.set()
            reader.join(timeout=2)

        self.assertFalse(reader.is_alive())
        frames = [frame for body in calls for frame in body.get("frames", [])]
        self.assertEqual([frame.get("dataBase64") for frame in frames if not frame.get("close")], ["Zmlyc3Q=", "c2Vjb25k"])
        self.assertEqual(sum(1 for frame in frames if frame.get("close") is True), 1)
        self.assertTrue(all(frame.get("frameId") for frame in frames))

    def test_batch_endpoint_falls_back_to_legacy_single_frame_route(self) -> None:
        supervisor = make_supervisor()
        paths: list[str] = []

        def request(path, _method="GET", _body=None):
            paths.append(path)
            if path.endswith("/ws-frames"):
                raise RuntimeError("API HTTP 404: not found")
            return {"ok": True}

        supervisor._request = request  # type: ignore[method-assign]
        supervisor._post_ws_frames([{
            "frameId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "channelId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "dataBase64": "eA==",
            "binary": True,
        }])

        self.assertEqual(paths[-2:], [
            "/agent/workspace-gateway/ws-frames",
            "/agent/workspace-gateway/ws-frame",
        ])


class ControlLoopIsolationTests(unittest.TestCase):
    def test_slow_reconciliation_does_not_block_control_messages(self) -> None:
        supervisor = make_supervisor()
        reconcile_calls = 0
        reconcile_blocked = threading.Event()
        release_reconcile = threading.Event()
        handled = threading.Event()

        def reconcile() -> None:
            nonlocal reconcile_calls
            reconcile_calls += 1
            if reconcile_calls >= 2:
                reconcile_blocked.set()
                release_reconcile.wait(2)

        def next_items() -> list[dict]:
            self.assertTrue(reconcile_blocked.wait(1))
            return [{"kind": "ws_close", "channelId": "unused"}]

        def handle(_item: dict) -> None:
            handled.set()
            supervisor.stop_event.set()

        supervisor._reconcile_sessions = reconcile  # type: ignore[method-assign]
        supervisor._next_items = next_items  # type: ignore[method-assign]
        supervisor._handle = handle  # type: ignore[method-assign]

        runner = threading.Thread(target=supervisor.run, daemon=True)
        runner.start()
        try:
            self.assertTrue(
                handled.wait(0.5),
                "control message was serialized behind Docker reconciliation",
            )
        finally:
            release_reconcile.set()
            runner.join(timeout=2)

        self.assertFalse(runner.is_alive())


if __name__ == "__main__":
    unittest.main()
