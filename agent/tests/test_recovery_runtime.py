from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gpubnb_agent.recovery_runtime import install


class ScriptedServiceStop:
    def __init__(self, results: list[bool]) -> None:
        self.results = list(results)
        self.stopped = False
        self.waits: list[float | None] = []

    def is_set(self) -> bool:
        return self.stopped

    def wait(self, timeout: float | None = None) -> bool:
        self.waits.append(timeout)
        result = self.results.pop(0) if self.results else True
        if result:
            self.stopped = True
        return result


def fake_cli(tmp: str, heartbeat_func, diagnostic_func, job_func):
    events: list[dict[str, object]] = []
    pid = Path(tmp) / "agent.pid"
    return SimpleNamespace(
        _recovery_runtime_installed=False,
        _GATEWAY_ERROR_EXPLANATIONS={},
        print_json=events.append,
        load_config=lambda: {"machineId": "machine-1", "intervalSeconds": 5},
        load_key=lambda: object(),
        workspace_image=lambda _config, _slug: "image@sha256:" + "a" * 64,
        prewarm_workspace_image=lambda _image, progress_callback=None: {"ready": True},
        client=lambda _config: object(),
        heartbeat=heartbeat_func,
        run_next_job=job_func,
        poll_and_run_diagnostic_once=diagnostic_func,
        pid_path=lambda: pid,
        sys=SimpleNamespace(executable="gpubnb-agent.exe"),
        events=events,
    )


class RecoveryRuntimeTests(unittest.TestCase):
    def test_quarantine_keeps_diagnostics_alive_and_never_starts_normal_job(self) -> None:
        diagnostic_started = threading.Event()
        job_calls: list[int] = []

        def diagnostic(*_args, **_kwargs):
            diagnostic_started.set()

        def heartbeat(*_args):
            self.assertTrue(diagnostic_started.wait(1))
            raise RuntimeError("machine_quarantined")

        with tempfile.TemporaryDirectory() as tmp:
            module = fake_cli(tmp, heartbeat, diagnostic, lambda *_a, **_k: job_calls.append(1))
            install(module)
            stop = ScriptedServiceStop([True])
            with patch(
                "gpubnb_agent.workspace_gateway.run_workspace_gateway_forever",
                side_effect=lambda stop_event=None, **_kwargs: stop_event.wait(1),
            ):
                self.assertEqual(
                    module.heartbeat_loop(
                        stop_event=stop,
                        process_mode="_service",
                        event_sink=module.events.append,
                    ),
                    0,
                )

        self.assertEqual(job_calls, [])
        self.assertIn(60.0, stop.waits)
        recovery = [e for e in module.events if e.get("event") == "heartbeat_recovery"]
        self.assertTrue(recovery)
        self.assertEqual(recovery[0]["mode"], "platform_action")
        self.assertEqual(recovery[0]["reason"], "machine_quarantined")
        self.assertTrue(diagnostic_started.is_set())

    def test_transient_heartbeat_failure_uses_central_backoff_then_resumes_jobs(self) -> None:
        diagnostic_started = threading.Event()
        heartbeat_calls = 0
        job_started = threading.Event()

        def diagnostic(*_args, **_kwargs):
            diagnostic_started.set()

        def heartbeat(*_args):
            nonlocal heartbeat_calls
            heartbeat_calls += 1
            if heartbeat_calls == 1:
                raise TimeoutError("API timed out")
            return {"ok": True}

        def job(*_args, **_kwargs):
            job_started.set()

        with tempfile.TemporaryDirectory() as tmp:
            module = fake_cli(tmp, heartbeat, diagnostic, job)
            install(module)
            stop = ScriptedServiceStop([False, True])
            with patch(
                "gpubnb_agent.workspace_gateway.run_workspace_gateway_forever",
                side_effect=lambda stop_event=None, **_kwargs: stop_event.wait(1),
            ):
                module.heartbeat_loop(
                    stop_event=stop,
                    process_mode="_service",
                    event_sink=module.events.append,
                )

        self.assertEqual(heartbeat_calls, 2)
        self.assertEqual(stop.waits[:2], [5.0, 5.0])
        self.assertTrue(diagnostic_started.is_set())
        self.assertTrue(job_started.wait(1))
        recovery = [e for e in module.events if e.get("event") == "heartbeat_recovery"]
        self.assertEqual(recovery[0]["mode"], "retry")
        self.assertEqual(recovery[0]["reason"], "api_timeout")

    def test_security_stop_stops_unsafe_runtime_threads_without_stopping_service_authority(self) -> None:
        diagnostic_started = threading.Event()
        job_calls: list[int] = []

        def diagnostic(*_args, **_kwargs):
            diagnostic_started.set()

        def heartbeat(*_args):
            self.assertTrue(diagnostic_started.wait(1))
            raise RuntimeError("unsafe_runtime_state")

        with tempfile.TemporaryDirectory() as tmp:
            module = fake_cli(tmp, heartbeat, diagnostic, lambda *_a, **_k: job_calls.append(1))
            install(module)
            stop = ScriptedServiceStop([True])
            with patch(
                "gpubnb_agent.workspace_gateway.run_workspace_gateway_forever",
                side_effect=lambda stop_event=None, **_kwargs: stop_event.wait(1),
            ):
                module.heartbeat_loop(
                    stop_event=stop,
                    process_mode="_service",
                    event_sink=module.events.append,
                )

        self.assertEqual(job_calls, [])
        self.assertIn(None, stop.waits)
        recovery = [e for e in module.events if e.get("event") == "heartbeat_recovery"]
        self.assertEqual(recovery[0]["mode"], "stop")
        self.assertEqual(recovery[0]["reason"], "unsafe_runtime_state")

    def test_diagnostic_auth_rejection_uses_platform_backoff_not_hot_polling(self) -> None:
        diagnostic_attempted = threading.Event()

        def diagnostic(*_args, **_kwargs):
            diagnostic_attempted.set()
            raise RuntimeError('API HTTP 401: {"error":"invalid_agent_request"}')

        def heartbeat(*_args):
            self.assertTrue(diagnostic_attempted.wait(1))
            return {"ok": True}

        with tempfile.TemporaryDirectory() as tmp:
            module = fake_cli(tmp, heartbeat, diagnostic, lambda *_a, **_k: None)
            install(module)
            stop = ScriptedServiceStop([True])
            with patch(
                "gpubnb_agent.workspace_gateway.run_workspace_gateway_forever",
                side_effect=lambda stop_event=None, **_kwargs: stop_event.wait(1),
            ):
                module.heartbeat_loop(
                    stop_event=stop,
                    process_mode="_service",
                    event_sink=module.events.append,
                )

        recovery = [e for e in module.events if e.get("event") == "diagnostic_recovery"]
        self.assertTrue(recovery)
        self.assertEqual(recovery[0]["mode"], "platform_action")
        self.assertEqual(recovery[0]["reason"], "agent_auth_rejected")
        self.assertEqual(recovery[0]["retryAfterSeconds"], None)

    def test_install_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            module = fake_cli(tmp, lambda *_a: {"ok": True}, lambda *_a, **_k: None, lambda *_a, **_k: None)
            install(module)
            installed = module.heartbeat_loop
            install(module)
            self.assertIs(module.heartbeat_loop, installed)


if __name__ == "__main__":
    unittest.main()
