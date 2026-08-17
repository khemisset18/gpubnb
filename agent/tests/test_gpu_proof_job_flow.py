from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from gpubnb_agent.cli import run_next_job
from gpubnb_agent.runtime_images import DEFAULT_COMPUTE_IMAGE


class GpuProofJobFlowTests(unittest.TestCase):
    def test_gpu_proof_job_publishes_signed_usage_then_completes_and_finalizes(self) -> None:
        machine_id = "machine_test"
        job_id = "job_test"
        attempt_id = "attempt_test"
        session_id = "session_test"
        lease_token = "a" * 43
        calls: list[tuple[str, str, object | None]] = []
        events: list[dict[str, object]] = []

        job = {
            "id": job_id,
            "type": "GPU_PROOF",
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            "parameters": {"durationSeconds": 30, "workspaceSlug": "compute"},
            "workspaceSession": {"id": session_id},
        }

        def fake_agent_request(
            _api: object,
            _key: object,
            _machine_id: str,
            path: str,
            method: str = "GET",
            body: object | None = None,
            *_args: object,
            **_kwargs: object,
        ) -> object:
            calls.append((path, method, body))
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            if path == f"/agent/jobs/{job_id}/control":
                return {"cancelRequested": False}
            return {"ok": True}

        def fake_gpu_proof(image: str, duration: int, on_sample):
            self.assertEqual(image, DEFAULT_COMPUTE_IMAGE)
            self.assertEqual(duration, 30)
            on_sample({"elapsedSeconds": 5, "iterations": 100})
            on_sample({"elapsedSeconds": 10, "iterations": 200})
            return {
                "gpuDetected": True,
                "summary": "GPU proof complete",
                "metrics": {
                    "durationSeconds": 30,
                    "iterations": 200,
                    "device": "NVIDIA Test GPU",
                    "containerCleaned": True,
                },
            }

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.run_gpu_proof_workspace", side_effect=fake_gpu_proof),
            patch(
                "gpubnb_agent.cli.system_inventory",
                return_value={
                    "ramTotalMiB": 16_384,
                    "ramAvailableMiB": 12_000,
                    "diskTotalMiB": 100_000,
                    "diskAvailableMiB": 90_000,
                },
            ),
            patch(
                "gpubnb_agent.cli.gpu_inventory",
                return_value=[{
                    "gpuUtilization": 80,
                    "memoryUsedMiB": 512,
                    "temperatureC": 55,
                }],
            ),
        ):
            run_next_job(Mock(), object(), machine_id, {}, event_sink=events.append)

        metric_calls = [call for call in calls if call[0] == f"/agent/workspace-sessions/{session_id}/metrics"]
        self.assertEqual(len(metric_calls), 2)
        for _, method, body in metric_calls:
            self.assertEqual(method, "POST")
            self.assertIsInstance(body, dict)
            assert isinstance(body, dict)
            self.assertEqual(body["machineId"], machine_id)
            self.assertEqual(body["intervalSeconds"], 5)
            self.assertIs(body["workloadProof"], True)

        state_bodies = [
            body for path, method, body in calls
            if method == "POST" and isinstance(body, dict) and "status" in body
        ]
        self.assertEqual(
            [body["status"] for body in state_bodies],
            ["DOWNLOADING", "PREPARING", "RUNNING", "UPLOADING_RESULTS"],
        )

        complete_index = next(i for i, call in enumerate(calls) if call[0] == f"/agent/jobs/{job_id}/complete")
        finalize_index = next(i for i, call in enumerate(calls) if call[0] == f"/agent/jobs/{job_id}/finalize-proof")
        self.assertLess(complete_index, finalize_index)

        complete_body = calls[complete_index][2]
        self.assertIsInstance(complete_body, dict)
        assert isinstance(complete_body, dict)
        self.assertEqual(complete_body["attemptId"], attempt_id)
        self.assertEqual(complete_body["leaseToken"], lease_token)
        self.assertIs(complete_body["result"]["gpuDetected"], True)
        self.assertIs(complete_body["result"]["metrics"]["containerCleaned"], True)

        finalize_body = calls[finalize_index][2]
        self.assertEqual(
            finalize_body,
            {"machineId": machine_id, "attemptId": attempt_id, "leaseToken": lease_token},
        )

        self.assertTrue(any(event.get("event") == "job_completed" for event in events))
        self.assertFalse(any(event.get("event") == "job_failed" for event in events))


if __name__ == "__main__":
    unittest.main()
