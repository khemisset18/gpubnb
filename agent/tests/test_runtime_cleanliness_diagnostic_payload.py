from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch


class RuntimeCleanlinessDiagnosticPayloadTests(unittest.TestCase):
    def test_new_server_expectation_is_inspected_and_sent_as_evidence(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        machine_id = "machine_test"
        run_id = "diag_runtime_clean"
        expected = ["cmsession-1", "cmsession-2"]
        calls: list[tuple[str, str, object | None]] = []

        def fake_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path.endswith(f"/next/{machine_id}"):
                return {
                    "diagnosticRunId": run_id,
                    "diagnosticImage": "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + "a" * 64,
                    "timeoutSeconds": 60,
                    "expectedRuntimeSessionIds": expected,
                }
            return {"ok": True}

        evidence = {
            "unexpectedContainers": [],
            "unexpectedVolumes": [],
            "unexpectedNetworks": [],
        }
        report = SimpleNamespace(to_api_payload=lambda: evidence)

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_request),
            patch("gpubnb_agent.cli.inspect_runtime_cleanliness", return_value=report) as inspect,
            patch("gpubnb_agent.cli.run_gpu_diagnostic", return_value={"gpuDetected": True, "summary": "ok", "metrics": {}}),
        ):
            poll_and_run_diagnostic_once(Mock(), object(), machine_id)

        inspect.assert_called_once_with(expected)
        result = next(body for path, method, body in calls if path.endswith(f"/{run_id}/result") and method == "POST")
        self.assertEqual(
            result["runtimeCleanliness"],
            {**evidence, "expectedSessionIds": expected},
        )
        self.assertNotIn("clean", result["runtimeCleanliness"])

    def test_old_server_without_expectation_does_not_touch_docker(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        machine_id = "machine_test"
        run_id = "diag_old_server"
        calls: list[tuple[str, str, object | None]] = []

        def fake_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path.endswith(f"/next/{machine_id}"):
                return {
                    "diagnosticRunId": run_id,
                    "diagnosticImage": "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + "b" * 64,
                    "timeoutSeconds": 60,
                }
            return {"ok": True}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_request),
            patch("gpubnb_agent.cli.inspect_runtime_cleanliness") as inspect,
            patch("gpubnb_agent.cli.run_gpu_diagnostic", return_value={"gpuDetected": True, "summary": "ok", "metrics": {}}),
        ):
            poll_and_run_diagnostic_once(Mock(), object(), machine_id)

        inspect.assert_not_called()
        result = next(body for path, method, body in calls if path.endswith(f"/{run_id}/result") and method == "POST")
        self.assertNotIn("runtimeCleanliness", result)

    def test_inventory_failure_is_reported_as_diagnostic_failure(self) -> None:
        from gpubnb_agent.cli import poll_and_run_diagnostic_once

        machine_id = "machine_test"
        run_id = "diag_inventory_failure"
        calls: list[tuple[str, str, object | None]] = []

        def fake_request(_api, _key, _machine_id, path, method="GET", body=None, *_a, **_k):
            calls.append((path, method, body))
            if path.endswith(f"/next/{machine_id}"):
                return {
                    "diagnosticRunId": run_id,
                    "diagnosticImage": "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + "c" * 64,
                    "timeoutSeconds": 60,
                    "expectedRuntimeSessionIds": [],
                }
            return {"ok": True}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_request),
            patch("gpubnb_agent.cli.inspect_runtime_cleanliness", side_effect=RuntimeError("runtime_cleanliness_docker_failed:ps-a:1")),
            patch("gpubnb_agent.cli.run_gpu_diagnostic") as gpu,
        ):
            poll_and_run_diagnostic_once(Mock(), object(), machine_id)

        gpu.assert_not_called()
        result = next(body for path, method, body in calls if path.endswith(f"/{run_id}/result") and method == "POST")
        self.assertEqual(result["gpuDetected"], False)
        self.assertIn("runtime_cleanliness_docker_failed", result["error"])
        self.assertNotIn("runtimeCleanliness", result)


if __name__ == "__main__":
    unittest.main()
