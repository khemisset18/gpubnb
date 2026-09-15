from __future__ import annotations

import subprocess
import time
import unittest
from typing import Any

from gpubnb_agent import workspace_gateway as legacy
from gpubnb_agent.workspace_gateway_v8 import GatewaySupervisor


class FakeDocker:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.running: dict[str, bool] = {}
        self.paused: dict[str, bool] = {}

    def __call__(
        self,
        args: list[str],
        timeout: int = 30,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(args))
        command = args[0]
        if command == "inspect" and "--format" in args:
            name = args[-1]
            template = args[args.index("--format") + 1]
            if name not in self.running:
                return subprocess.CompletedProcess(args, 1, "", "")
            if ".State.Paused" in template:
                value = "true" if self.paused.get(name, False) else "false"
                return subprocess.CompletedProcess(args, 0, value + "\n", "")
            if ".State.Running" in template:
                value = "true" if self.running.get(name, False) else "false"
                return subprocess.CompletedProcess(args, 0, value + "\n", "")
        if command == "pause":
            name = args[1]
            if not self.running.get(name, False):
                return subprocess.CompletedProcess(args, 1, "", "")
            self.paused[name] = True
            return subprocess.CompletedProcess(args, 0, name + "\n", "")
        if command == "unpause":
            name = args[1]
            if not self.running.get(name, False):
                return subprocess.CompletedProcess(args, 1, "", "")
            self.paused[name] = False
            return subprocess.CompletedProcess(args, 0, name + "\n", "")
        if command == "port":
            return subprocess.CompletedProcess(args, 0, "3000/tcp -> 127.0.0.1:41000\n", "")
        return subprocess.CompletedProcess(args, 0, "", "")


class FakeRequest:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self.interrupted: dict[str, Any] = {"ok": True, "paused": True}
        self.resumed: dict[str, Any] = {"ok": True, "resumed": True, "expired": False}

    def __call__(
        self,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append((path, method, body))
        if path.endswith("/event") and body:
            if body.get("event") == "INTERRUPTED":
                return dict(self.interrupted)
            if body.get("event") == "RESUMED":
                return dict(self.resumed)
            return {"ok": True}
        if path.endswith("/desired"):
            return {"protocolVersion": 1, "graceSeconds": 600, "sessions": []}
        return {"ok": True}


def make_supervisor(docker: FakeDocker, request: FakeRequest) -> GatewaySupervisor:
    supervisor = GatewaySupervisor(
        api=None,
        key=None,
        machine_id="machine-1",
        config={},
        docker_runner=docker,
        health_check=lambda _port: True,
        mining_guard=lambda: True,
    )
    supervisor._request = request  # type: ignore[method-assign]
    return supervisor


def attach_runtime(supervisor: GatewaySupervisor, docker: FakeDocker, session_id: str) -> legacy.Runtime:
    container = f"gpubnb-dev-{session_id}"
    proxy = f"gpubnb-dev-proxy-{session_id}"
    runtime = legacy.Runtime(
        session_id=session_id,
        container_name=container,
        proxy_name=proxy,
        volume_name=f"gpubnb-workspace-{session_id}",
        network_name=f"gpubnb-workspace-internal-{session_id}",
        port=41000,
    )
    supervisor.runtimes[session_id] = runtime
    docker.running[container] = True
    docker.running[proxy] = True
    docker.paused[container] = False
    docker.paused[proxy] = False
    return runtime


class WorkspaceReconnectGraceTests(unittest.TestCase):
    def test_last_channel_interruption_physically_pauses_before_commercial_grace(self) -> None:
        docker, request = FakeDocker(), FakeRequest()
        supervisor = make_supervisor(docker, request)
        attach_runtime(supervisor, docker, "session1")

        supervisor._begin_reconnect_grace("session1")

        self.assertTrue(docker.paused["gpubnb-dev-session1"])
        self.assertFalse(docker.paused["gpubnb-dev-proxy-session1"])
        self.assertTrue(supervisor._reconnect_is_paused("session1"))
        pause_index = docker.calls.index(["pause", "gpubnb-dev-session1"])
        self.assertGreaterEqual(pause_index, 0)
        self.assertIn(
            ("/agent/workspace-reconnect/session1/event", "POST", {
                "machineId": "machine-1",
                "event": "INTERRUPTED",
            }),
            request.calls,
        )

    def test_server_rejection_immediately_unpauses_so_no_free_compute_window_exists(self) -> None:
        docker, request = FakeDocker(), FakeRequest()
        request.interrupted = {"ok": True, "paused": False}
        supervisor = make_supervisor(docker, request)
        attach_runtime(supervisor, docker, "session2")

        supervisor._begin_reconnect_grace("session2")

        self.assertFalse(docker.paused["gpubnb-dev-session2"])
        self.assertFalse(supervisor._reconnect_is_paused("session2"))
        self.assertIn(["pause", "gpubnb-dev-session2"], docker.calls)
        self.assertIn(["unpause", "gpubnb-dev-session2"], docker.calls)

    def test_paused_session_reports_liveness_but_never_legacy_billable_usage(self) -> None:
        docker, request = FakeDocker(), FakeRequest()
        supervisor = make_supervisor(docker, request)
        runtime = attach_runtime(supervisor, docker, "session3")
        docker.paused[runtime.container_name] = True
        supervisor._reconnect_mark_paused("session3")
        supervisor._reconnect_last_liveness["session3"] = time.monotonic() - 20.0

        supervisor._report_running_usage(runtime)

        self.assertIn(
            ("/agent/workspace-reconnect/session3/event", "POST", {
                "machineId": "machine-1",
                "event": "LIVENESS",
            }),
            request.calls,
        )
        self.assertFalse(any(path.endswith("/usage") for path, _method, _body in request.calls))

    def test_authenticated_relay_resumes_same_container_and_billing_together(self) -> None:
        docker, request = FakeDocker(), FakeRequest()
        supervisor = make_supervisor(docker, request)
        runtime = attach_runtime(supervisor, docker, "session4")
        docker.paused[runtime.container_name] = True
        supervisor._reconnect_mark_paused("session4")

        self.assertTrue(supervisor._resume_before_relay("session4"))

        self.assertFalse(docker.paused[runtime.container_name])
        self.assertIs(supervisor.runtimes["session4"], runtime)
        self.assertFalse(supervisor._reconnect_is_paused("session4"))
        self.assertIn(
            ("/agent/workspace-reconnect/session4/event", "POST", {
                "machineId": "machine-1",
                "event": "RESUMED",
            }),
            request.calls,
        )

    def test_expired_grace_repauses_runtime_instead_of_returning_free_compute(self) -> None:
        docker, request = FakeDocker(), FakeRequest()
        request.resumed = {"ok": True, "resumed": False, "expired": True}
        supervisor = make_supervisor(docker, request)
        runtime = attach_runtime(supervisor, docker, "session5")
        docker.paused[runtime.container_name] = True
        supervisor._reconnect_mark_paused("session5")

        self.assertFalse(supervisor._resume_before_relay("session5"))

        self.assertTrue(docker.paused[runtime.container_name])
        self.assertTrue(supervisor._reconnect_is_paused("session5"))


if __name__ == "__main__":
    unittest.main()
