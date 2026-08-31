"""Distributed-host resilience scenarios for GatewaySupervisor, driven entirely
through the same FakeDocker/FakeApi harness as test_workspace_gateway.py
(duplicated here rather than imported, matching this test suite's own
convention of every file owning its fakes - see e.g.
test_workspace_gateway_v5.py's own inline docker fake).

Covers two scenarios from the PC A -> PC B audit that weren't yet proven by
name: calling _reconcile_sessions() twice back to back never double-starts a
session, and a session already RUNNING survives a *sustained* (multi-cycle)
inability to reach the API - not just a single interruption before the
session ever started (already covered by
test_workspace_gateway.py::NetworkInterruptionTests) - without creating a
ghost/duplicate container once connectivity resumes.

"retry du meme job" (a Job redelivered/retried getting a new attempt while
an older attempt is still running) is already covered elsewhere and
deliberately NOT re-tested here: apps/api/test/job-fencing-wiring.test.ts
proves the server-side fencing (an obsolete attempt's mutations are
rejected) against a real Fastify app + DB, and
agent/tests/test_job_lease_protocol.py proves the agent always sends
attemptId/leaseToken and that the lease-renewal/fencing control flow is
present. The remaining gap - behaviorally proving the *threaded*
lease-renewal closure inside cli.run_next_job actually reacts to a
stale_job_attempt signal - would need either a real 10-second wait
(lease_stop.wait(10) runs before the loop's first request) or globally
patching threading.Event.wait, which risks destabilizing the rest of that
function's own threading. Not simple enough to add here without touching
run_next_job's structure - out of scope for this pass.
"""
from __future__ import annotations

import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any

from gpubnb_agent.workspace_gateway import GatewaySupervisor, names_for_session

OFFICIAL_IMAGE = "ghcr.io/khemisset18/gpubnb-developer@sha256:" + ("d" * 64)


def _future(seconds: int = 3600) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


class FakeDocker:
    def __init__(self) -> None:
        self.networks: set[str] = set()
        self.containers: dict[str, dict[str, Any]] = {}
        self.volumes: set[str] = set()
        self.calls: list[list[str]] = []
        self._next_port = 41000

    def __call__(self, args: list[str], timeout: int = 30, check: bool = True) -> "subprocess.CompletedProcess[str]":
        self.calls.append(list(args))
        cmd = args[0]
        if cmd == "network":
            if args[1] == "inspect":
                return self._result(args, 0 if args[2] in self.networks else 1)
            if args[1] == "create":
                self.networks.add(args[-1])
                return self._result(args, 0)
            if args[1] == "connect":
                return self._result(args, 0)
            if args[1] == "rm":
                self.networks.discard(args[-1])
                return self._result(args, 0)
            if args[1] == "ls":
                prefix = next(a for a in args if a.startswith("name=")).split("name=", 1)[1].lstrip("^")
                names = [name for name in self.networks if name.startswith(prefix)]
                return self._result(args, 0, stdout=("\n".join(names) + "\n") if names else "")
        if cmd == "volume":
            if args[1] == "create":
                self.volumes.add(args[2])
                return self._result(args, 0)
            if args[1] == "rm":
                self.volumes.discard(args[-1])
                return self._result(args, 0)
            if args[1] == "inspect":
                return self._result(args, 0 if args[-1] in self.volumes else 1)
            if args[1] == "ls":
                prefix = next(a for a in args if a.startswith("name=")).split("name=", 1)[1].lstrip("^")
                names = [name for name in self.volumes if name.startswith(prefix)]
                return self._result(args, 0, stdout=("\n".join(names) + "\n") if names else "")
        if cmd == "run":
            name = args[args.index("--name") + 1]
            publishes_port = "-p" in args or "--publish" in args
            port = self._next_port if publishes_port else None
            if publishes_port:
                self._next_port += 1
            self.containers[name] = {"running": True, "port": port, "exit_code": 0, "logs": ""}
            return self._result(args, 0)
        if cmd == "port":
            info = self.containers.get(args[1])
            if not info or not info["running"] or info["port"] is None:
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

    def _result(self, args: list[str], returncode: int, stdout: str = "", stderr: str = "", check: bool = True) -> "subprocess.CompletedProcess[str]":
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)


class FakeApi:
    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self.raise_on_desired: Exception | None = None

    def __call__(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
        self.calls.append((path, method, body))
        if path.endswith("/desired"):
            if self.raise_on_desired is not None:
                raise self.raise_on_desired
            return {"sessions": self.sessions}
        if path.endswith("/register") and isinstance(body, dict):
            # Mirrors the real API (workspace-gateway.ts's /register handler):
            # persists connectionMetadata onto the session record, so the next
            # /desired fetch reflects it - without this, a fake session would
            # look permanently unregistered and /register would be called
            # every single reconcile pass forever, which the real API does not do.
            session_id = path.rsplit("/", 2)[-2]
            for session in self.sessions:
                if str(session.get("id") or "") == session_id:
                    session["connectionMetadata"] = {
                        "runtimeId": body.get("runtimeId"),
                        "localPort": body.get("localPort"),
                    }
        return {"ok": True}


class NoMiners:
    def running_processes(self) -> list[tuple[int, str]]:
        return []

    def terminate(self, pid: int) -> None:
        raise AssertionError("no miner was running - terminate should never be called")

    def is_running(self, pid: int) -> bool:
        return False


def make_supervisor(docker: FakeDocker, api: FakeApi) -> GatewaySupervisor:
    supervisor = GatewaySupervisor(
        api=None, key=None, machine_id="machine-1",
        config={"workspaceImages": {"developer": OFFICIAL_IMAGE}},
        docker_runner=docker,
        process_inspector=NoMiners(),
        health_check=lambda port: True,
        mining_guard=lambda: True,
    )
    supervisor._request = api  # type: ignore[method-assign]
    return supervisor


class DoubleReconcileTests(unittest.TestCase):
    def test_calling_reconcile_twice_in_a_row_never_double_starts_a_session(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        container, _volume = names_for_session("sess-1")

        supervisor._reconcile_sessions()
        supervisor._reconcile_sessions()

        run_calls_for_container = [
            call for call in docker.calls
            if call[0] == "run" and call[call.index("--name") + 1] == container
        ]
        self.assertEqual(
            len(run_calls_for_container), 1,
            "a second, immediate reconcile pass for the same still-running "
            "session must adopt the existing container, not start a duplicate",
        )
        self.assertIn("sess-1", supervisor.runtimes)

    def test_calling_reconcile_twice_never_double_registers_the_gateway(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)

        supervisor._reconcile_sessions()
        supervisor._reconcile_sessions()

        register_calls = [call for call in api.calls if call[0].endswith("/register")]
        self.assertEqual(
            len(register_calls), 1,
            "connectionMetadata already matches the adopted runtime on the "
            "second pass, so /register must not be called again",
        )


class SustainedOfflineTests(unittest.TestCase):
    """Distinct from test_workspace_gateway.py::NetworkInterruptionTests,
    which only proves a single failed /desired call before a session has
    ever started. This proves the stronger, more realistic claim the user
    asked for: a session that is ALREADY RUNNING survives the machine being
    unable to reach the API across MULTIPLE consecutive reconcile cycles -
    matching what "machine OFFLINE pendant une session" and "reseau A<->B
    coupe" actually look like from the agent's own point of view (the agent
    cannot distinguish "the API considers me offline" from "the network
    between A and B is down" - both manifest identically as _request()
    raising on /desired)."""

    def test_a_running_session_survives_multiple_consecutive_offline_reconciles(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        container, _volume = names_for_session("sess-1")
        self.assertIn(container, docker.containers)
        calls_before_outage = len(docker.calls)

        api.raise_on_desired = ConnectionError("simulated sustained network/API outage")
        for _ in range(5):
            with self.assertRaises(ConnectionError):
                supervisor._reconcile_sessions()

        self.assertEqual(
            len(docker.calls), calls_before_outage,
            "no Docker command of any kind may run while the API is unreachable - "
            "an outage must never speculatively touch a live session's container",
        )
        self.assertTrue(docker.containers[container]["running"])
        self.assertIn("sess-1", supervisor.runtimes)

    def test_recovery_after_sustained_offline_adopts_without_creating_a_ghost_session(self) -> None:
        docker, api = FakeDocker(), FakeApi()
        api.sessions = [{"id": "sess-1", "status": "READY", "expiresAt": _future(), "connectionMetadata": {}}]
        supervisor = make_supervisor(docker, api)
        supervisor._reconcile_sessions()
        container, _volume = names_for_session("sess-1")

        api.raise_on_desired = TimeoutError("simulated sustained outage")
        for _ in range(3):
            with self.assertRaises(TimeoutError):
                supervisor._reconcile_sessions()

        api.raise_on_desired = None
        supervisor._reconcile_sessions()

        run_calls_for_container = [
            call for call in docker.calls
            if call[0] == "run" and call[call.index("--name") + 1] == container
        ]
        self.assertEqual(
            len(run_calls_for_container), 1,
            "recovery must adopt the container that was running the whole "
            "time, not start a second (ghost) one",
        )
        self.assertEqual(len(supervisor.runtimes), 1)


if __name__ == "__main__":
    unittest.main()
