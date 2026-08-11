"""Integration tests for GatewaySupervisor: the real Developer Workspace runtime
lifecycle, driven entirely through a FakeDocker simulator and a scriptable fake API,
never a real container. See docs/WORKSPACE_RUNTIME_ARCHITECTURE.md and the ten
scenarios in the accompanying PR description for what each test below proves.
"""
from __future__ import annotations

import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

from gpubnb_agent.workspace_gateway import CONTAINER_PREFIX, VOLUME_PREFIX, GatewaySupervisor, names_for_session

OFFICIAL_IMAGE = "ghcr.io/khemisset18/gpubnb-developer@sha256:" + ("d" * 64)


def _future(seconds: int = 3600) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _past(seconds: int = 60) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


class FakeDocker:
    """Enough of the real `docker` CLI surface for GatewaySupervisor to run its whole
    lifecycle against, entirely in memory. Container/volume identity, --name
    collisions, and `docker ps` filtering all behave the way the real CLI does."""

    def __init__(self) -> None:
        self.networks: set[str] = set()
        self.containers: dict[str, dict[str, Any]] = {}
        self.volumes: set[str] = set()
        self.calls: list[list[str]] = []
        self._next_port = 41000
        self.fail_next_run = False
        self.exit_next_run: tuple[int, str] | None = None
        self.volumes_that_wont_die: set[str] = set()

    def __call__(self, args: list[str], timeout: int = 30, check: bool = True) -> "subprocess.CompletedProcess[str]":
        self.calls.append(list(args))
        cmd = args[0]
        if cmd == "network":
            if args[1] == "inspect":
                return self._result(args, 0 if args[2] in self.networks else 1)
            if args[1] == "create":
                self.networks.add(args[-1])
                return self._result(args, 0)
        if cmd == "volume":
            if args[1] == "create":
                self.volumes.add(args[2])
                return self._result(args, 0)
            if args[1] == "rm":
                if args[-1] not in self.volumes_that_wont_die:
                    self.volumes.discard(args[-1])
                return self._result(args, 0)
            if args[1] == "inspect":
                return self._result(args, 0 if args[-1] in self.volumes else 1)
        if cmd == "run":
            name = args[args.index("--name") + 1]
            if self.fail_next_run:
                self.fail_next_run = False
                if check:
                    raise RuntimeError("workspace_docker_failed:run:1:simulated failure")
                return self._result(args, 1)
            port = self._next_port
            self._next_port += 1
            exit_code, logs = self.exit_next_run or (0, "")
            self.exit_next_run = None
            self.containers[name] = {
                "running": exit_code == 0,
                "port": port,
                "healthy": exit_code == 0,
                "exit_code": exit_code,
                "logs": logs,
            }
            return self._result(args, 0)
        if cmd == "port":
            info = self.containers.get(args[1])
            if not info or not info["running"]:
                return self._result(args, 1, check=False)
            return self._result(args, 0, stdout=f"3000/tcp -> 127.0.0.1:{info['port']}\n")
        if cmd == "inspect":
            if "--format" in args:
                name = args[-1]
                info = self.containers.get(name)
                if info is None:
                    return self._result(args, 1)
                template = args[args.index("--format") + 1]
                if ".State.Running" in template:
                    return self._result(args, 0, stdout=("true" if info["running"] else "false") + "\n")
                if ".State.ExitCode" in template:
                    return self._result(args, 0, stdout=f"exit={info['exit_code']} oom=false error=\n")
                return self._result(args, 0)
            return self._result(args, 0 if args[-1] in self.containers else 1)
        if cmd == "logs":
            info = self.containers.get(args[-1])
            return self._result(args, 0 if info else 1, stdout=(info or {}).get("logs", ""))
        if cmd == "rm":
            name = args[-1]
            existed = name in self.containers
            self.containers.pop(name, None)
            return self._result(args, 0 if existed else 1)
        if cmd == "ps":
            prefix = next(a for a in args if a.startswith("name=")).split("name=", 1)[1].lstrip("^")
            names = [name for name in self.containers if name.startswith(prefix)]
            return self._result(args, 0, stdout=("\n".join(names) + "\n") if names else "")
        return self._result(args, 0)

    def crash(self, container_name: str) -> None:
        """Simulates a container dying without --rm having reclaimed it yet."""
        if container_name in self.containers:
            self.containers[container_name]["running"] = False

    def hard_remove(self, container_name: str) -> None:
        """Simulates --rm having already reclaimed a crashed container."""
        self.containers.pop(container_name, None)

    def _result(self, args: list[str], returncode: int, stdout: str = "", stderr: str = "", check: bool = True) -> "subprocess.CompletedProcess[str]":
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)


class FakeApi:
    """Scriptable stand-in for the agent<->API traffic GatewaySupervisor drives
    through self._request. Tests set .sessions directly; every request/response is
    recorded in .calls for assertions."""

    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self.raise_on_desired: Exception | None = None

    def __call__(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
        self.calls.append((path, method, body))
        if path.endswith("/desired"):
            if self.raise_on_desired is not None:
                exc, self.raise_on_desired = self.raise_on_desired, None
                raise exc
            return {"sessions": self.sessions}
        return {"ok": True}


class NoMiners:
    def running_processes(self) -> list[tuple[int, str]]:
        return []

    def terminate(self, pid: int) -> None:
        raise AssertionError("no miner was running - terminate should never be called")

    def is_running(self, pid: int) -> bool:
        return False


def make_supervisor(docker: FakeDocker, api: FakeApi, config: dict[str, Any] | None = None) -> GatewaySupervisor:
    supervisor = GatewaySupervisor(
        api=None, key=None, machine_id="machine-1",
        config=config or {"workspaceImages": {"developer": OFFICIAL_IMAGE}},
        docker_runner=docker,
        process_inspector=NoMiners(),
        health_check=lambda port: True,
        # Bypasses real path resolution (%LOCALAPPDATA%, Windows-only) entirely, not
        # just the process backend - these tests aren't about mining, and this same
        # suite runs on Linux/macOS CI runners too. MiningExclusivityTests below
        # overrides this per-test to actually exercise the gate.
        mining_guard=lambda: True,
    )
    supervisor._request = api  # type: ignore[method-assign]
    return supervisor


class StartNormalTests(unittest.TestCase):
    def test_start_normal_creates_container_and_registers(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)

        supervisor._reconcile_sessions()

        container, volume = names_for_session("sess-1")
        self.assertIn(container, docker.containers)
        self.assertIn(volume, docker.volumes)
        self.assertIn("sess-1", supervisor.runtimes)
        register_calls = [c for c in api.calls if c[0].endswith("/register")]
        self.assertEqual(len(register_calls), 1)
        self.assertEqual(register_calls[0][2]["runtimeId"], container)  # type: ignore[index]

    def test_early_code_server_exit_preserves_diagnostics_then_cleans_up(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        docker.exit_next_run = (1, "EACCES: cannot create ~/.local/share/code-server")
        supervisor = make_supervisor(docker, api)

        with self.assertRaises(RuntimeError) as ctx:
            supervisor._start_runtime("sess-early-exit")

        self.assertIn("developer_workspace_container_exited", str(ctx.exception))
        self.assertIn("exit=1", str(ctx.exception))
        self.assertIn("EACCES", str(ctx.exception))
        container, volume = names_for_session("sess-early-exit")
        self.assertNotIn(container, docker.containers)
        self.assertNotIn(volume, docker.volumes)
        run_call = next(call for call in docker.calls if call[0] == "run")
        self.assertNotIn("--rm", run_call)

    def test_repeated_start_failure_is_backed_off_per_session(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        docker.exit_next_run = (1, "startup failed")
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)

        with self.assertRaises(RuntimeError):
            supervisor._reconcile_sessions()
        first_run_count = sum(1 for call in docker.calls if call[0] == "run")

        supervisor._reconcile_sessions()
        second_run_count = sum(1 for call in docker.calls if call[0] == "run")

        self.assertEqual(first_run_count, 1)
        self.assertEqual(second_run_count, 1, "backoff must prevent a Docker create/delete storm")


class DoubleStartTests(unittest.TestCase):
    def test_double_start_never_creates_a_second_container(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)

        supervisor._reconcile_sessions()
        run_calls_after_first = sum(1 for call in docker.calls if call[0] == "run")
        # Second reconcile pass sees the same READY session, already tracked.
        supervisor._reconcile_sessions()
        run_calls_after_second = sum(1 for call in docker.calls if call[0] == "run")

        self.assertEqual(run_calls_after_first, 1)
        self.assertEqual(run_calls_after_second, 1, "a second reconcile pass must not start a second container")
        self.assertEqual(len(supervisor.runtimes), 1)


class StopNormalTests(unittest.TestCase):
    def test_stop_requested_stops_and_cleans_the_runtime(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        container, volume = names_for_session("sess-1")
        self.assertIn(container, docker.containers)

        api.sessions = [{"id": "sess-1", "status": "STOP_REQUESTED", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor._reconcile_sessions()

        self.assertNotIn(container, docker.containers)
        self.assertNotIn(volume, docker.volumes)
        self.assertNotIn("sess-1", supervisor.runtimes)
        stopped_calls = [c for c in api.calls if c[0].endswith("/stopped")]
        self.assertEqual(len(stopped_calls), 1)
        self.assertTrue(stopped_calls[0][2]["cleaned"])  # type: ignore[index]


class ExpirationTests(unittest.TestCase):
    def test_expired_session_is_stopped_without_a_stop_request(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        container, _ = names_for_session("sess-1")
        self.assertIn(container, docker.containers)

        # Status is still READY (the API never got a chance to flip it), but the
        # deadline has passed - the agent must catch this locally.
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _past(), "connectionMetadata": {}}]
        supervisor._reconcile_sessions()

        self.assertNotIn(container, docker.containers)
        self.assertNotIn("sess-1", supervisor.runtimes)
        stopped_calls = [c for c in api.calls if c[0].endswith("/stopped")]
        self.assertEqual(len(stopped_calls), 1)


class AgentRestartTests(unittest.TestCase):
    def test_fresh_supervisor_adopts_the_still_running_container(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        first = make_supervisor(docker, api)
        first._reconcile_sessions()
        container, _ = names_for_session("sess-1")
        original_run_count = sum(1 for call in docker.calls if call[0] == "run")

        # Simulate an agent restart: a brand new supervisor, empty self.runtimes,
        # against the SAME docker daemon where the container is still alive.
        second_api = FakeApi()
        second_api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {"runtimeId": container, "localPort": docker.containers[container]["port"]}}]
        second = make_supervisor(docker, second_api)
        self.assertEqual(second.runtimes, {})

        second._reconcile_sessions()

        run_count_after_restart = sum(1 for call in docker.calls if call[0] == "run")
        self.assertEqual(run_count_after_restart, original_run_count, "adoption must not start a duplicate container")
        self.assertIn("sess-1", second.runtimes)
        self.assertEqual(second.runtimes["sess-1"].container_name, container)


class ContainerCrashTests(unittest.TestCase):
    def test_crashed_but_not_yet_reclaimed_container_is_replaced(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        container, _ = names_for_session("sess-1")

        docker.crash(container)
        supervisor._reconcile_sessions()

        # A fresh container must exist and be running again under the same name.
        self.assertIn(container, docker.containers)
        self.assertTrue(docker.containers[container]["running"])
        self.assertIn("sess-1", supervisor.runtimes)

    def test_crashed_and_already_reclaimed_container_is_restarted(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        container, _ = names_for_session("sess-1")

        docker.hard_remove(container)  # --rm already cleaned it up
        supervisor._reconcile_sessions()

        self.assertIn(container, docker.containers)
        self.assertTrue(docker.containers[container]["running"])


class NetworkInterruptionTests(unittest.TestCase):
    def test_a_failed_desired_request_does_not_corrupt_state_and_recovers(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        api.raise_on_desired = ConnectionError("simulated network interruption")
        supervisor = make_supervisor(docker, api)

        with self.assertRaises(ConnectionError):
            supervisor._reconcile_sessions()
        self.assertEqual(supervisor.runtimes, {})

        # Network recovers; the very next reconcile pass must proceed normally.
        supervisor._reconcile_sessions()
        self.assertIn("sess-1", supervisor.runtimes)


class GatewayReconnectTests(unittest.TestCase):
    def test_reconnect_opens_a_new_channel_without_disturbing_the_old_one(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()

        with patch("gpubnb_agent.workspace_gateway.websocket.create_connection") as create_connection, \
             patch.object(supervisor, "_ws_reader"):  # the reader loop itself isn't under test here
            create_connection.side_effect = [object(), object()]
            supervisor._ws_open({"sessionId": "sess-1", "channelId": "chan-1", "path": "/", "headers": {}})
            supervisor._ws_open({"sessionId": "sess-1", "channelId": "chan-2", "path": "/", "headers": {}})

        self.assertEqual(supervisor.session_channels["sess-1"], {"chan-1", "chan-2"})
        self.assertEqual(set(supervisor.channels.keys()), {"chan-1", "chan-2"})

    def test_stopping_a_session_closes_only_its_own_channels(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [
            {"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}},
            {"id": "sess-2", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}},
        ]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()

        ws1, ws2 = unittest.mock.MagicMock(), unittest.mock.MagicMock()
        with patch("gpubnb_agent.workspace_gateway.websocket.create_connection", side_effect=[ws1, ws2]), \
             patch.object(supervisor, "_ws_reader"):
            supervisor._ws_open({"sessionId": "sess-1", "channelId": "chan-1", "path": "/", "headers": {}})
            supervisor._ws_open({"sessionId": "sess-2", "channelId": "chan-2", "path": "/", "headers": {}})

        supervisor._stop_runtime("sess-1")

        ws1.close.assert_called_once()
        ws2.close.assert_not_called()
        self.assertNotIn("chan-1", supervisor.channels)
        self.assertIn("chan-2", supervisor.channels)
        self.assertNotIn("sess-1", supervisor.session_channels)


class CleanupFailureTests(unittest.TestCase):
    def test_unverified_cleanup_is_reported_as_not_cleaned(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        _, volume = names_for_session("sess-1")

        # Simulate a volume that refuses to actually go away (e.g. still mounted
        # elsewhere) even though `volume rm -f` reports success.
        docker.volumes_that_wont_die.add(volume)
        api.sessions = [{"id": "sess-1", "status": "STOP_REQUESTED", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor._reconcile_sessions()

        stopped_calls = [c for c in api.calls if c[0].endswith("/stopped")]
        self.assertEqual(len(stopped_calls), 1)
        self.assertFalse(stopped_calls[0][2]["cleaned"])  # type: ignore[index]


class UsageBillingTests(unittest.TestCase):
    def test_first_ready_tick_establishes_baseline_without_billing_preparation(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)

        supervisor._reconcile_sessions()

        self.assertFalse(any(call[0].endswith("/usage") for call in api.calls))

    def test_running_healthy_workspace_reports_billable_intervals(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        supervisor = make_supervisor(docker, api)
        runtime = supervisor._start_runtime("sess-1")
        supervisor.usage_last_report["sess-1"] = 0.0

        with patch("gpubnb_agent.workspace_gateway.time.monotonic", return_value=11.0), patch(
            "gpubnb_agent.workspace_gateway.time.time", return_value=1_800_000_000.0
        ):
            supervisor._report_running_usage(runtime)

        usage = [call for call in api.calls if call[0].endswith("/usage")]
        self.assertEqual(len(usage), 1)
        self.assertEqual(usage[0][2]["intervalSeconds"], 11)  # type: ignore[index]
        self.assertTrue(usage[0][2]["available"])  # type: ignore[index]


class MiningExclusivityTests(unittest.TestCase):
    def test_workspace_refuses_to_start_while_a_miner_cannot_be_verified_stopped(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._mining_guard = lambda: False  # type: ignore[method-assign]

        with self.assertRaises(RuntimeError) as ctx:
            supervisor._start_runtime("sess-1")
        self.assertIn("workspace_start_blocked_mining_stop_unverified", str(ctx.exception))
        self.assertEqual(docker.calls, [], "no docker command may run before mining stop is verified")

    def test_workspace_starts_once_mining_stop_is_verified(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        supervisor = make_supervisor(docker, api)
        stop_calls = []
        supervisor._mining_guard = lambda: (stop_calls.append(1), True)[1]  # type: ignore[method-assign]

        runtime = supervisor._start_runtime("sess-1")

        self.assertEqual(stop_calls, [1])
        self.assertIn(runtime.container_name, docker.containers)


class ImagePinningTests(unittest.TestCase):
    def test_unpinned_or_unofficial_image_is_rejected_before_any_docker_call(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        supervisor = make_supervisor(docker, api, config={"workspaceImages": {"developer": "ghcr.io/someone-else/gpubnb-developer:latest"}})

        with self.assertRaises(RuntimeError):
            supervisor._start_runtime("sess-1")
        self.assertEqual(docker.calls, [])


class OrphanSweepTests(unittest.TestCase):
    def test_a_container_with_no_matching_session_at_all_is_removed(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        orphan_container = f"{CONTAINER_PREFIX}orphaned0000000"
        orphan_volume = f"{VOLUME_PREFIX}orphaned0000000"
        docker.containers[orphan_container] = {"running": True, "port": 5000, "healthy": True}
        docker.volumes.add(orphan_volume)
        api.sessions = []
        supervisor = make_supervisor(docker, api)

        supervisor._reconcile_sessions()

        self.assertNotIn(orphan_container, docker.containers)
        self.assertNotIn(orphan_volume, docker.volumes)

    def test_a_container_matching_a_desired_session_is_left_for_adoption(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        container, _ = names_for_session("sess-1")

        supervisor._reconcile_sessions()

        self.assertIn(container, docker.containers)
        self.assertIn("sess-1", supervisor.runtimes)


class GatewayErrorVisibilityTests(unittest.TestCase):
    def test_repeated_gateway_failure_is_reported_without_log_flooding(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        reported: list[str] = []
        supervisor = GatewaySupervisor(
            api=None,
            key=None,
            machine_id="machine-1",
            config={"workspaceImages": {"developer": OFFICIAL_IMAGE}},
            docker_runner=docker,
            process_inspector=NoMiners(),
            health_check=lambda _port: True,
            mining_guard=lambda: True,
            error_callback=lambda exc: reported.append(str(exc)),
        )

        supervisor._report_error(RuntimeError("api unavailable"))
        supervisor._report_error(RuntimeError("api unavailable"))
        supervisor._report_error(RuntimeError("docker unavailable"))

        self.assertEqual(reported, ["api unavailable", "docker unavailable"])


if __name__ == "__main__":
    unittest.main()
