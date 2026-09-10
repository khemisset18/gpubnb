from __future__ import annotations

import subprocess
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from gpubnb_agent import workspace_gateway_v5 as resource_scoped
from gpubnb_agent.workspace_gateway import Runtime
from gpubnb_agent.workspace_gateway_v6 import GatewaySupervisor


class DummyInspector:
    def running_processes(self):
        return []

    def terminate(self, _pid):
        return None

    def is_running(self, _pid):
        return False


def make_supervisor(errors: list[str] | None = None) -> GatewaySupervisor:
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
        error_callback=(lambda exc: errors.append(str(exc))) if errors is not None else None,
    )
    supervisor.runtimes["session-1"] = Runtime(
        "session-1", "workspace", "proxy", "volume", "network", 41000
    )
    return supervisor


def open_item(channel: str) -> dict:
    return {
        "id": f"open-{channel}",
        "kind": "ws_open",
        "sessionId": "session-1",
        "channelId": channel,
        "path": "/stable",
        "headers": {},
    }


class WorkspaceWebSocketOpenSchedulerTests(unittest.TestCase):
    def test_slow_management_open_does_not_head_of_line_block_extension_host(self) -> None:
        supervisor = make_supervisor()
        slow_started = threading.Event()
        release_slow = threading.Event()
        fast_seen = threading.Event()

        def fake_open(self, item):
            channel = str(item["channelId"])
            if channel == "management":
                slow_started.set()
                release_slow.wait(2)
            else:
                fast_seen.set()
            self.channels[channel] = MagicMock()
            self.session_channels.setdefault("session-1", set()).add(channel)

        with patch.object(resource_scoped.GatewaySupervisor, "_ws_open", fake_open):
            supervisor._handle(open_item("management"))
            self.assertTrue(slow_started.wait(1), "slow Management open never started")
            started = time.monotonic()
            supervisor._handle(open_item("extension-host"))
            self.assertTrue(
                fast_seen.wait(0.25),
                "ExtensionHost open was serialized behind the slow Management open",
            )
            self.assertLess(time.monotonic() - started, 0.5)
            release_slow.set()

    def test_browser_frames_are_buffered_and_replayed_in_order_after_local_open(self) -> None:
        supervisor = make_supervisor()
        open_started = threading.Event()
        release_open = threading.Event()
        replayed: list[str] = []

        def fake_open(self, item):
            open_started.set()
            release_open.wait(2)
            channel = str(item["channelId"])
            self.channels[channel] = MagicMock()
            self.session_channels.setdefault("session-1", set()).add(channel)

        def fake_parent_handle(self, item):
            replayed.append(str(item.get("dataBase64") or item.get("kind")))

        with patch.object(resource_scoped.GatewaySupervisor, "_ws_open", fake_open), patch.object(
            resource_scoped.GatewaySupervisor, "_handle", fake_parent_handle
        ):
            supervisor._handle(open_item("management"))
            self.assertTrue(open_started.wait(1))
            supervisor._handle(
                {
                    "kind": "ws_send",
                    "sessionId": "session-1",
                    "channelId": "management",
                    "dataBase64": "Zmlyc3Q=",
                    "binary": True,
                }
            )
            supervisor._handle(
                {
                    "kind": "ws_send",
                    "sessionId": "session-1",
                    "channelId": "management",
                    "dataBase64": "c2Vjb25k",
                    "binary": True,
                }
            )
            self.assertEqual(replayed, [], "browser frames leaked before local ws_open completed")
            release_open.set()
            deadline = time.monotonic() + 1
            while len(replayed) < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(replayed, ["Zmlyc3Q=", "c2Vjb25k"])

    def test_pending_buffer_overflow_fails_closed_instead_of_growing_unbounded(self) -> None:
        errors: list[str] = []
        supervisor = make_supervisor(errors)
        open_started = threading.Event()
        release_open = threading.Event()

        def fake_open(self, item):
            open_started.set()
            release_open.wait(2)

        with patch.object(resource_scoped.GatewaySupervisor, "_ws_open", fake_open):
            supervisor._handle(open_item("management"))
            self.assertTrue(open_started.wait(1))
            huge = "A" * (5 * 1024 * 1024)
            supervisor._handle(
                {
                    "kind": "ws_send",
                    "sessionId": "session-1",
                    "channelId": "management",
                    "dataBase64": huge,
                    "binary": True,
                }
            )
            supervisor._handle(
                {
                    "kind": "ws_send",
                    "sessionId": "session-1",
                    "channelId": "management",
                    "dataBase64": huge,
                    "binary": True,
                }
            )
            self.assertTrue(any("workspace_ws_open_pending_overflow" in error for error in errors))
            release_open.set()


if __name__ == "__main__":
    unittest.main()
