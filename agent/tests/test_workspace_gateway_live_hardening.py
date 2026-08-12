from __future__ import annotations

import subprocess
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import websocket

from gpubnb_agent.workspace_gateway import GatewaySupervisor, Runtime
from gpubnb_agent.workspace_gateway_v2 import (
    HTTP_RELAY_QUEUE_MAX_ITEMS,
    WS_OUTBOUND_QUEUE_MAX_ITEMS,
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


class LocalWebSocketHandshakeTests(unittest.TestCase):
    def test_connect_timeout_is_removed_after_handshake_and_subprotocol_is_structured(self) -> None:
        supervisor = make_supervisor()
        supervisor._request = MagicMock(return_value={"ok": True})  # type: ignore[method-assign]
        supervisor._ws_reader = MagicMock()  # type: ignore[method-assign]
        ws = MagicMock()
        ws.subprotocol = "vscode-remote"

        with patch(
            "gpubnb_agent.workspace_gateway_v2.websocket.create_connection",
            return_value=ws,
        ) as create_connection, patch(
            "gpubnb_agent.workspace_gateway_v2.threading.Thread",
            ImmediateThread,
        ):
            supervisor._ws_open({
                "id": "open-1",
                "sessionId": "session-1",
                "channelId": "channel-1",
                "path": "/stable",
                "headers": {
                    "Sec-WebSocket-Protocol": "vscode-remote, vscode-management",
                    "X-Test": "kept",
                },
            })

        kwargs = create_connection.call_args.kwargs
        self.assertEqual(
            kwargs["subprotocols"],
            ["vscode-remote", "vscode-management"],
        )
        self.assertTrue(all(
            not header.lower().startswith("sec-websocket-protocol:")
            for header in kwargs["header"]
        ))
        self.assertIn("X-Test: kept", kwargs["header"])
        ws.settimeout.assert_called_once_with(None)
        self.assertIn("channel-1", supervisor.channels)


class BurstBufferTests(unittest.TestCase):
    def test_more_than_eight_small_frames_are_drained_while_first_batch_is_blocked(self) -> None:
        self.assertGreater(WS_OUTBOUND_QUEUE_MAX_ITEMS, 8)
        supervisor = make_supervisor()
        first_post_started = threading.Event()
        release_first_post = threading.Event()
        ws = MagicMock()
        frame_count = 80
        ws.recv_data.side_effect = [
            *[(websocket.ABNF.OPCODE_BINARY, b"x") for _ in range(frame_count)],
            (websocket.ABNF.OPCODE_CLOSE, b""),
        ]

        def post_frames(_frames):
            first_post_started.set()
            release_first_post.wait(2)

        supervisor._post_ws_frames = post_frames  # type: ignore[method-assign]
        reader = threading.Thread(
            target=supervisor._ws_reader,
            args=("session-1", "channel-burst", ws),
            daemon=True,
        )
        reader.start()
        try:
            self.assertTrue(first_post_started.wait(1))
            deadline = time.monotonic() + 1
            while ws.recv_data.call_count < frame_count + 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(
                ws.recv_data.call_count,
                frame_count + 1,
                "small VS Code burst was backpressured before the WAN batch completed",
            )
        finally:
            release_first_post.set()
            reader.join(timeout=2)

        self.assertFalse(reader.is_alive())


class HttpRelayQueueTests(unittest.TestCase):
    def test_thirteenth_asset_queues_instead_of_immediate_503(self) -> None:
        supervisor = make_supervisor()
        started = 0
        started_lock = threading.Lock()
        workers_busy = threading.Event()
        release = threading.Event()
        responses: list[dict] = []

        def slow_http(_item):
            nonlocal started
            with started_lock:
                started += 1
                if started >= 12:
                    workers_busy.set()
            release.wait(2)

        def request(path, method="GET", body=None):
            if path.endswith("/respond"):
                responses.append(body or {})
            return {"ok": True}

        supervisor._http = slow_http  # type: ignore[method-assign]
        supervisor._request = request  # type: ignore[method-assign]
        try:
            for index in range(12):
                supervisor._dispatch_http({
                    "id": f"asset-{index}",
                    "kind": "http",
                    "sessionId": "session-1",
                })
            self.assertTrue(workers_busy.wait(1))
            supervisor._dispatch_http({
                "id": "asset-13",
                "kind": "http",
                "sessionId": "session-1",
            })
            self.assertFalse(
                any(response.get("id") == "asset-13" and response.get("status") == 503 for response in responses),
                "13th parallel asset was rejected instead of queued",
            )
            self.assertGreaterEqual(HTTP_RELAY_QUEUE_MAX_ITEMS, 1)
        finally:
            release.set()
            supervisor.stop_event.set()


if __name__ == "__main__":
    unittest.main()
