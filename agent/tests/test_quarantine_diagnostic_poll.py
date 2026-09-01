"""Tests for the quarantine-diagnostic poll+report loop added to cli.py
(poll_and_run_diagnostic_once), which is separate from run_next_job's
booking-scoped Job machinery on purpose: it must keep working even while the
machine is quarantined (moderationStatus != CLEAR), which /agent/jobs/next
intentionally does not guarantee. See docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md and
apps/api/src/machine-diagnostics-routes.ts.
"""
from __future__ import annotations

import unittest
from unittest.mock import Mock, patch


class QuarantineDiagnosticPollTests(unittest.TestCase):
    def test_no_pending_diagnostic_run_is_a_silent_no_op(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        calls: list[tuple[str, str, object | None]] = []

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            return {"diagnosticRunId": None}

        with patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request):
            poll_and_run_diagnostic_once(Mock(), object(), "machine_test")

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "/agent/diagnostics/next/machine_test")

    def test_a_pending_run_executes_the_real_diagnostic_and_reports_a_real_result(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        machine_id = "machine_test"
        diagnostic_run_id = "diag_run_1"
        image = "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("a" * 64)
        calls: list[tuple[str, str, object | None]] = []
        events: list[dict[str, object]] = []

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path == f"/agent/diagnostics/next/{machine_id}":
                return {"diagnosticRunId": diagnostic_run_id, "diagnosticImage": image, "timeoutSeconds": 60}
            return {"ok": True}

        def fake_run_gpu_diagnostic(passed_image: str, timeout_seconds: int):
            self.assertEqual(passed_image, image)
            self.assertEqual(timeout_seconds, 60)
            return {"gpuDetected": True, "summary": "ok", "metrics": {"firstGpuUuid": "GPU-abc"}}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=fake_run_gpu_diagnostic),
        ):
            poll_and_run_diagnostic_once(Mock(), object(), machine_id, event_sink=events.append)

        result_call = next(c for c in calls if c[0] == f"/agent/diagnostics/{diagnostic_run_id}/result")
        self.assertEqual(result_call[1], "POST")
        body = result_call[2]
        self.assertEqual(body["machineId"], machine_id)
        self.assertEqual(body["gpuDetected"], True)
        self.assertEqual(body["gpuUuid"], "GPU-abc")
        self.assertNotIn("error", body)
        self.assertTrue(any(e.get("event") == "quarantine_diagnostic_completed" for e in events))

    def test_a_diagnostic_execution_failure_is_reported_as_an_explicit_error_never_as_a_passing_result(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        machine_id = "machine_test"
        diagnostic_run_id = "diag_run_2"
        calls: list[tuple[str, str, object | None]] = []
        events: list[dict[str, object]] = []

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path == f"/agent/diagnostics/next/{machine_id}":
                return {
                    "diagnosticRunId": diagnostic_run_id,
                    "diagnosticImage": "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("b" * 64),
                    "timeoutSeconds": 60,
                }
            return {"ok": True}

        def fake_run_gpu_diagnostic(_image: str, _timeout_seconds: int):
            raise RuntimeError("diagnostic_container_failed:1:boom")

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=fake_run_gpu_diagnostic),
        ):
            poll_and_run_diagnostic_once(Mock(), object(), machine_id, event_sink=events.append)

        result_call = next(c for c in calls if c[0] == f"/agent/diagnostics/{diagnostic_run_id}/result")
        body = result_call[2]
        self.assertEqual(body["gpuDetected"], False)
        self.assertIn("diagnostic_container_failed", body["error"])
        self.assertTrue(any(e.get("event") == "quarantine_diagnostic_failed" for e in events))

    def test_a_missing_diagnostic_image_is_reported_as_an_explicit_configuration_error(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        machine_id = "machine_test"
        diagnostic_run_id = "diag_run_3"
        calls: list[tuple[str, str, object | None]] = []

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path == f"/agent/diagnostics/next/{machine_id}":
                return {"diagnosticRunId": diagnostic_run_id, "diagnosticImage": None, "timeoutSeconds": 60}
            return {"ok": True}

        with patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request):
            poll_and_run_diagnostic_once(Mock(), object(), machine_id)

        result_call = next(c for c in calls if c[0] == f"/agent/diagnostics/{diagnostic_run_id}/result")
        self.assertIn("diagnostic_image_not_configured", result_call[2]["error"])


if __name__ == "__main__":
    unittest.main()
