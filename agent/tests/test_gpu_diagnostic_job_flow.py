"""Regression test for a real bug found live during the first PC A -> PC B
rental rehearsal (dev-bypass booking flow, this-machine-as-both-roles test).

dev-booking-reconciler.ts always sends the real pinned diagnostic image in
parameters.diagnosticImage when it queues a GPU_DIAGNOSTIC job (a separate,
minimal official image from the Compute workspace's own gpu-proof-workspace
image). cli.py's run_next_job ignored it and resolved the image via
workspace_image(config, workspace_slug) instead - workspace_slug defaults to
"compute" for a GPU_DIAGNOSTIC job (the API never sends a workspaceSlug for
this job type), so every fresh, correctly configured agent probed with the
wrong image and failed diagnostic_command()'s official-image check
(confirmed live: "diagnosticImage doit utiliser l'image officielle
ghcr.io/khemisset18/gpu-diagnostic epinglee par digest"), permanently
DEGRADING the booking. No prior unit test caught this because
DeveloperWorkspaceHealthCommandTests.test_other_workspace_slugs_are_unaffected
(test_developer_workspace_gpu_binding.py) only tests workspace_health_command
given an already-correct image - it never exercised run_next_job's own image
resolution for this job type.
"""
from __future__ import annotations

import unittest
from unittest.mock import Mock, patch


class GpuDiagnosticJobFlowTests(unittest.TestCase):
    def test_diagnostic_job_uses_the_servers_pinned_diagnostic_image_not_the_compute_workspace_image(self) -> None:
        from gpubnb_agent.cli import run_next_job
        from gpubnb_agent.runtime_images import DEFAULT_COMPUTE_IMAGE

        machine_id = "machine_test"
        job_id = "job_diag_test"
        attempt_id = "attempt_diag_test"
        lease_token = "a" * 43
        diagnostic_image = "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("c" * 64)
        calls: list[tuple[str, str, object | None]] = []
        events: list[dict[str, object]] = []

        job = {
            "id": job_id,
            "type": "GPU_DIAGNOSTIC",
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            # No workspaceSlug - dev-booking-reconciler.ts never sends one for
            # this job type, exactly as observed live.
            "parameters": {"timeoutSeconds": 120, "diagnosticImage": diagnostic_image},
        }

        def fake_agent_request(
            _api: object, _key: object, _machine_id: str, path: str,
            method: str = "GET", body: object | None = None, *_a: object, **_k: object,
        ) -> object:
            calls.append((path, method, body))
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            return {"ok": True}

        seen_images: list[str] = []

        def fake_run_gpu_diagnostic(image: str, timeout_seconds: int):
            seen_images.append(image)
            self.assertEqual(timeout_seconds, 120)
            return {"gpuDetected": True, "summary": "ok", "metrics": {}}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=fake_run_gpu_diagnostic),
        ):
            run_next_job(Mock(), object(), machine_id, {}, event_sink=events.append)

        self.assertEqual(seen_images, [diagnostic_image])
        self.assertNotIn(DEFAULT_COMPUTE_IMAGE, seen_images)
        self.assertTrue(
            any(event.get("event") == "job_completed" for event in events),
            f"expected a job_completed event, got: {events}",
        )

    def test_diagnostic_job_falls_back_to_local_config_when_the_server_sends_no_image(self) -> None:
        # Covers a renter-triggered re-run job (POST /jobs) that predates the
        # diagnosticImage parameter - must not silently resolve to the Compute
        # workspace image in that case either.
        from gpubnb_agent.cli import run_next_job

        machine_id = "machine_test"
        job_id = "job_diag_test_2"
        attempt_id = "attempt_diag_test_2"
        lease_token = "b" * 43
        configured_image = "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("d" * 64)

        job = {
            "id": job_id,
            "type": "GPU_DIAGNOSTIC",
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            "parameters": {"timeoutSeconds": 60},
        }

        def fake_agent_request(
            _api: object, _key: object, _machine_id: str, path: str,
            method: str = "GET", body: object | None = None, *_a: object, **_k: object,
        ) -> object:
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            return {"ok": True}

        seen_images: list[str] = []

        def fake_run_gpu_diagnostic(image: str, timeout_seconds: int):
            seen_images.append(image)
            return {"gpuDetected": True, "summary": "ok", "metrics": {}}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=fake_run_gpu_diagnostic),
        ):
            run_next_job(
                Mock(), object(), machine_id,
                {"diagnosticImage": configured_image},
            )

        self.assertEqual(seen_images, [configured_image])


if __name__ == "__main__":
    unittest.main()
