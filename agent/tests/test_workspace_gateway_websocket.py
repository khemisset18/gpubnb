from __future__ import annotations

import subprocess
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
        calls: list[dict] = []
        supervisor._request = lambda _path, _method="GET", body=None: (calls.append(body or {}), {"ok": True})[1]  # type: ignore[method-assign]
        ws = MagicMock()
        ws.recv_data.return_value = (
            websocket.ABNF.OPCODE_BINARY,
            b"x" * (WS_MAX_FRAME_BYTES + 1),
        )
        supervisor.channels["channel-4"] = ws
        supervisor.session_channels["session-1"] = {"channel-4"}

        supervisor._ws_reader("session-1", "channel-4", ws)

        data_frames = [body for body in calls if "dataBase64" in body]
        self.assertEqual(data_frames, [])
        self.assertTrue(any("ws_frame_too_large" in error for error in errors))
        self.assertEqual(calls[-1].get("close"), True)

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


if __name__ == "__main__":
    unittest.main()
