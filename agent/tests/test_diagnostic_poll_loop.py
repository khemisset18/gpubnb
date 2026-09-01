"""Integration-level tests for the diagnostic-poll loop wiring inside
heartbeat_loop() (cli.py) - as opposed to test_quarantine_diagnostic_poll.py,
which tests poll_and_run_diagnostic_once()'s own internal request/response
logic in isolation.

Written after a real production incident: the real Windows service silently
never ran this loop at all for an entire session, with zero trace of why in
the logs - the actual root cause turned out to be that the service's frozen
executable predated this code (see docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md §14),
not a logic bug here. These tests exist to lock down the loop's own
correctness (single instance, survives errors, starts/stops observably) now
that real observability events exist to prove it in production too.
"""
from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.cli import heartbeat_loop


class FastStopEvent:
    """Same minimal stand-in as test_heartbeat_job_concurrency.py's - a real
    threading.Event would work too, but this makes stop_event.wait() resolve
    quickly regardless of the real delay argument, so tests run fast."""

    def __init__(self) -> None:
        self.stopped = False

    def is_set(self) -> bool:
        return self.stopped

    def wait(self, _seconds: float) -> bool:
        time.sleep(0.005)
        return self.stopped


def _run_heartbeat_loop(stop: FastStopEvent, **overrides):
    """Runs heartbeat_loop with every dependency it touches besides the
    diagnostic path mocked out, exactly like test_heartbeat_job_concurrency.py.
    `overrides` lets each test patch cli.agent-visible names (heartbeat,
    poll_and_run_diagnostic_once, etc.) beyond the shared defaults below."""
    defaults = {
        "gpubnb_agent.cli.load_config": patch(
            "gpubnb_agent.cli.load_config", return_value={"machineId": "machine-1", "intervalSeconds": 5},
        ),
        "gpubnb_agent.cli.load_key": patch("gpubnb_agent.cli.load_key", return_value=object()),
        "gpubnb_agent.cli.workspace_image": patch(
            "gpubnb_agent.cli.workspace_image", return_value="image@sha256:" + "a" * 64,
        ),
        "gpubnb_agent.cli.prewarm_workspace_image": patch(
            "gpubnb_agent.cli.prewarm_workspace_image", return_value={"ready": True},
        ),
        "gpubnb_agent.cli.client": patch("gpubnb_agent.cli.client", return_value=object()),
        "gpubnb_agent.cli.run_next_job": patch("gpubnb_agent.cli.run_next_job", return_value=None),
        "gpubnb_agent.workspace_gateway.run_workspace_gateway_forever": patch(
            "gpubnb_agent.workspace_gateway.run_workspace_gateway_forever",
            side_effect=lambda **_kwargs: time.sleep(1),
        ),
        "gpubnb_agent.cli.print_json": patch("gpubnb_agent.cli.print_json"),
    }
    defaults.update(overrides)
    with tempfile.TemporaryDirectory() as directory, \
         patch("gpubnb_agent.cli.pid_path", return_value=Path(directory) / "agent.pid"), \
         defaults["gpubnb_agent.cli.load_config"], \
         defaults["gpubnb_agent.cli.load_key"], \
         defaults["gpubnb_agent.cli.workspace_image"], \
         defaults["gpubnb_agent.cli.prewarm_workspace_image"], \
         defaults["gpubnb_agent.cli.client"], \
         defaults["gpubnb_agent.cli.run_next_job"], \
         defaults["gpubnb_agent.workspace_gateway.run_workspace_gateway_forever"], \
         defaults["gpubnb_agent.cli.print_json"]:
        heartbeat_loop(stop_event=stop)  # type: ignore[arg-type]


class DiagnosticPollLoopTests(unittest.TestCase):
    def test_1_the_loop_starts_and_is_observable(self) -> None:
        """diagnostic_poll_loop_started fires exactly once, before any heartbeat."""
        stop = FastStopEvent()
        events: list[dict[str, object]] = []

        def fake_heartbeat(*_args):
            stop.stopped = True
            return {"ok": True}

        with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.poll_and_run_diagnostic_once", return_value=None):
            _run_heartbeat_loop(stop, **{"gpubnb_agent.cli.print_json": patch("gpubnb_agent.cli.print_json", side_effect=lambda e: events.append(e))})

        started = [e for e in events if e.get("event") == "diagnostic_poll_loop_started"]
        self.assertEqual(len(started), 1)
        self.assertEqual(started[0]["machineId"], "machine-1")
        stopped = [e for e in events if e.get("event") == "diagnostic_loop_stopped"]
        self.assertEqual(len(stopped), 1, "the loop must also report its own shutdown")

    def test_2_no_pending_diagnostic_keeps_polling_across_multiple_heartbeats(self) -> None:
        """The loop must not stop or degrade just because nothing is ever pending."""
        stop = FastStopEvent()
        poll_count = 0
        heartbeat_count = 0

        def fake_heartbeat(*_args):
            nonlocal heartbeat_count
            heartbeat_count += 1
            if heartbeat_count >= 4:
                stop.stopped = True
            return {"ok": True}

        def fake_poll(*_args, **_kwargs):
            nonlocal poll_count
            poll_count += 1

        with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.poll_and_run_diagnostic_once", side_effect=fake_poll):
            _run_heartbeat_loop(stop)

        self.assertGreaterEqual(heartbeat_count, 4)
        self.assertGreaterEqual(poll_count, 3, "the diagnostic poll must fire again on later heartbeats, not just the first")

    def test_3_a_pending_diagnostic_is_picked_up_and_the_real_workflow_runs(self) -> None:
        """Real integration of poll_and_run_diagnostic_once (not mocked this
        time) through the loop: a pending run is fetched, executed, reported."""
        stop = FastStopEvent()
        diagnostic_run_id = "diag-real-1"
        calls: list[tuple[str, str, object | None]] = []
        heartbeat_count = 0

        def fake_heartbeat(*_args):
            nonlocal heartbeat_count
            heartbeat_count += 1
            if heartbeat_count >= 2:
                stop.stopped = True
            return {"ok": True}

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path == "/agent/diagnostics/next/machine-1":
                return {"diagnosticRunId": diagnostic_run_id, "diagnosticImage": "image@sha256:" + "b" * 64, "timeoutSeconds": 30}
            return {"ok": True}

        def fake_run_gpu_diagnostic(_image, _timeout):
            return {"gpuDetected": True, "summary": "ok", "metrics": {}}

        with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request), \
             patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=fake_run_gpu_diagnostic):
            _run_heartbeat_loop(stop)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not any(c[0] == f"/agent/diagnostics/{diagnostic_run_id}/result" for c in calls):
                time.sleep(0.01)

        result_call = next((c for c in calls if c[0] == f"/agent/diagnostics/{diagnostic_run_id}/result"), None)
        self.assertIsNotNone(result_call, "the real diagnostic workflow must have run and reported a result through the loop")
        self.assertEqual(result_call[2]["gpuDetected"], True)

    def test_4_a_network_error_during_polling_never_permanently_kills_the_loop(self) -> None:
        """A transient failure (network error / bad response) must be reported
        and the loop must keep heartbeating and keep retrying on later cycles."""
        stop = FastStopEvent()
        heartbeat_count = 0
        poll_attempts = 0

        def fake_heartbeat(*_args):
            nonlocal heartbeat_count
            heartbeat_count += 1
            if heartbeat_count >= 4:
                stop.stopped = True
            return {"ok": True}

        def fake_poll(*_args, **_kwargs):
            nonlocal poll_attempts
            poll_attempts += 1
            if poll_attempts <= 2:
                raise RuntimeError("API inaccessible: [Errno 11001] getaddrinfo failed")

        events: list[dict[str, object]] = []
        with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.poll_and_run_diagnostic_once", side_effect=fake_poll):
            _run_heartbeat_loop(stop, **{"gpubnb_agent.cli.print_json": patch("gpubnb_agent.cli.print_json", side_effect=lambda e: events.append(e))})
            # heartbeat_loop() returns as soon as stop_event is observed, without
            # joining the daemon worker thread its last cycle may have just
            # spawned - give that thread a moment to actually run before
            # asserting on its side effects (poll_attempts/events).
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and poll_attempts < 3:
                time.sleep(0.01)

        self.assertGreaterEqual(heartbeat_count, 4, "heartbeats must keep happening despite the diagnostic poll failing")
        self.assertGreaterEqual(poll_attempts, 3, "the loop must retry polling on the next heartbeat after a transient failure")
        errors = [e for e in events if e.get("event") == "diagnostic_poll_error"]
        self.assertGreaterEqual(len(errors), 2, "every failure must be reported, never swallowed silently")
        self.assertIn("traceback", errors[0])
        self.assertIn("RuntimeError", errors[0]["type"])

    def test_5_a_diagnostic_execution_error_is_reported_and_the_loop_continues(self) -> None:
        """poll_and_run_diagnostic_once itself reports diagnostic_run_failed to
        the server (tested in test_quarantine_diagnostic_poll.py) - this proves
        the outer loop survives that too and keeps cycling afterwards."""
        stop = FastStopEvent()
        heartbeat_count = 0
        calls: list[tuple[str, str, object | None]] = []

        def fake_heartbeat(*_args):
            nonlocal heartbeat_count
            heartbeat_count += 1
            if heartbeat_count >= 3:
                stop.stopped = True
            return {"ok": True}

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path == "/agent/diagnostics/next/machine-1":
                return {"diagnosticRunId": f"diag-{len(calls)}", "diagnosticImage": "image@sha256:" + "c" * 64, "timeoutSeconds": 30}
            return {"ok": True}

        def fake_run_gpu_diagnostic(_image, _timeout):
            raise RuntimeError("diagnostic_container_failed:1:boom")

        with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request), \
             patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=fake_run_gpu_diagnostic):
            _run_heartbeat_loop(stop)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and heartbeat_count < 3:
                time.sleep(0.01)

        self.assertGreaterEqual(heartbeat_count, 3, "an execution failure inside one diagnostic must not stop later heartbeats/polls")
        result_calls = [c for c in calls if c[1] == "POST" and "/result" in c[0]]
        self.assertGreaterEqual(len(result_calls), 1)
        self.assertIn("diagnostic_container_failed", result_calls[0][2]["error"])

    def test_6_a_fresh_loop_invocation_starts_with_no_leftover_state_from_a_previous_one(self) -> None:
        """Models a service restart: heartbeat_loop() is a fresh Python call
        with its own local job_thread/diagnostic_thread variables - two
        independent invocations must each observe exactly one loop-started
        event and never see each other's thread state."""
        poll_counts = []
        for _ in range(2):
            stop = FastStopEvent()
            heartbeat_count = 0
            count = 0

            def fake_heartbeat(*_args):
                nonlocal heartbeat_count
                heartbeat_count += 1
                if heartbeat_count >= 2:
                    stop.stopped = True
                return {"ok": True}

            def fake_poll(*_args, **_kwargs):
                nonlocal count
                count += 1

            with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
                 patch("gpubnb_agent.cli.poll_and_run_diagnostic_once", side_effect=fake_poll):
                _run_heartbeat_loop(stop)
            poll_counts.append(count)

        self.assertTrue(all(c >= 1 for c in poll_counts), "each independent invocation must run its own poll cycle")

    def test_7_a_slow_running_diagnostic_worker_is_never_duplicated_by_a_later_heartbeat(self) -> None:
        """Mirrors test_heartbeat_job_concurrency.py's job-worker equivalent:
        while one diagnostic worker is still alive, a later heartbeat must not
        spawn a second overlapping one."""
        stop = FastStopEvent()
        worker_started = threading.Event()
        release_worker = threading.Event()
        heartbeat_count = 0
        start_count = 0

        def fake_heartbeat(*_args):
            nonlocal heartbeat_count
            heartbeat_count += 1
            if heartbeat_count >= 3:
                # Stop the loop while the worker is still deliberately held
                # blocked (release_worker is never set here) - this keeps
                # diagnostic_thread.is_alive() reliably True through every
                # is_alive() check this test performs, instead of racing
                # against the OS scheduler waking the worker back up the
                # instant it is released. It unblocks on its own via the
                # 1s wait() timeout below once the test's assertions are done.
                self.assertTrue(worker_started.wait(1), "the diagnostic worker should start after the first heartbeat")
                stop.stopped = True
            return {"ok": True}

        def fake_poll(*_args, **_kwargs):
            nonlocal start_count
            start_count += 1
            worker_started.set()
            release_worker.wait(1)

        with patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.poll_and_run_diagnostic_once", side_effect=fake_poll):
            _run_heartbeat_loop(stop)

        self.assertGreaterEqual(heartbeat_count, 3, "the loop must keep heartbeating across multiple cycles while the worker is still busy")
        self.assertEqual(start_count, 1, "only one diagnostic worker may be started while a previous one is still running")
        release_worker.set()


if __name__ == "__main__":
    unittest.main()
