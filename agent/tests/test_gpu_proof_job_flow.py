from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from nacl.signing import SigningKey

from gpubnb_agent.cli import run_next_job
from gpubnb_agent.client import agent_request
from gpubnb_agent.runtime_images import DEFAULT_COMPUTE_IMAGE


class GpuProofJobFlowTests(unittest.TestCase):
    def test_gpu_proof_job_publishes_signed_usage_then_completes_and_finalizes(self) -> None:
        machine_id = "machine_test"
        job_id = "job_test"
        attempt_id = "attempt_test"
        session_id = "session_test"
        lease_token = "a" * 43
        resource_id = "resource_test01"
        expected_gpu_uuid = "GPU-11111111-2222-3333-4444-555555555555"
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

        rental_authority = {
            "protocolVersion": 1,
            "leaseTtlSeconds": 45,
            "sessions": [{
                "sessionId": session_id,
                "status": "READY",
                "resources": [{
                    "resourceId": resource_id,
                    "hardwareUuid": expected_gpu_uuid,
                    "vendor": "NVIDIA",
                    "lease": {
                        "resourceId": resource_id,
                        "holderId": f"rental:{session_id}",
                        "leaseId": "lease_test0000001",
                        "fencingToken": "1",
                    },
                }],
            }],
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
            if path == f"/agent/mining/{machine_id}/rental-authority":
                return rental_authority
            return {"ok": True}

        def fake_gpu_proof(image: str, duration: int, gpu_uuid: str, on_sample):
            self.assertEqual(image, DEFAULT_COMPUTE_IMAGE)
            self.assertEqual(duration, 30)
            # Regression: the container must be launched against the exact hardware
            # UUID the rental resource authority leased for this session, not a
            # guessed/fixed device index.
            self.assertEqual(gpu_uuid, expected_gpu_uuid)
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
            body for _path, method, body in calls
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

    def test_gpu_proof_job_fails_closed_without_touching_docker_when_authority_has_no_session(self) -> None:
        # Regression for the reported `rental_resource_authority_missing_for_session`
        # failure: before this fix, /agent/mining/:machineId/rental-authority only
        # ever returned Developer-workspace sessions, so a Compute/GPU_PROOF session
        # could never be found there. The job must fail closed - it must never fall
        # back to launching the container against a guessed GPU.
        machine_id = "machine_test"
        job_id = "job_test"
        attempt_id = "attempt_test"
        session_id = "session_test"
        lease_token = "a" * 43
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
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            if path == f"/agent/mining/{machine_id}/rental-authority":
                # A well-formed authority payload that simply has no entry for this
                # session - exactly what a stale/mismatched workspace-slug filter
                # would have produced server-side.
                return {"protocolVersion": 1, "leaseTtlSeconds": 45, "sessions": []}
            return {"ok": True}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.run_gpu_proof_workspace") as gpu_proof_mock,
        ):
            run_next_job(Mock(), object(), machine_id, {}, event_sink=events.append)

        gpu_proof_mock.assert_not_called()
        failed = [event for event in events if event.get("event") == "job_failed"]
        self.assertEqual(len(failed), 1)
        self.assertIn("rental_resource_authority_missing_for_session", str(failed[0]["message"]))
        self.assertFalse(any(event.get("event") == "job_completed" for event in events))

    def test_terminal_request_retries_with_a_fresh_signature_after_lost_response(self) -> None:
        calls: list[dict[str, object]] = []
        body = {
            "machineId": "machine_test",
            "attemptId": "attempt_test",
            "leaseToken": "a" * 43,
            "result": {"gpuDetected": True, "summary": "ok"},
        }

        class Client:
            def request(self, path, method="GET", body=None, headers=None, timeout=12):
                calls.append({"path": path, "method": method, "body": body, "headers": headers})
                if len(calls) == 1:
                    raise RuntimeError("API inaccessible: response_lost")
                return {"id": "job_test", "status": "COMPLETED", "duplicate": True}

        with patch("gpubnb_agent.client.time.sleep"):
            result = agent_request(
                Client(),
                SigningKey.generate(),
                "machine_test",
                "/agent/jobs/job_test/complete",
                "POST",
                body,
            )

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["body"], calls[1]["body"])
        first_headers = calls[0]["headers"]
        second_headers = calls[1]["headers"]
        self.assertIsInstance(first_headers, dict)
        self.assertIsInstance(second_headers, dict)
        assert isinstance(first_headers, dict) and isinstance(second_headers, dict)
        self.assertNotEqual(first_headers["x-agent-nonce"], second_headers["x-agent-nonce"])
        self.assertNotEqual(first_headers["x-agent-signature-v2"], second_headers["x-agent-signature-v2"])


if __name__ == "__main__":
    unittest.main()
