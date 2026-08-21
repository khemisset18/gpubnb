from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from gpubnb_agent.cli import run_next_job
from gpubnb_agent.runtime_images import DEFAULT_DEVELOPER_IMAGE


GPU_UUID = "GPU-11111111-2222-3333-4444-555555555555"


class DeveloperWorkspaceJobFlowTests(unittest.TestCase):
    def test_developer_workspace_prepare_binds_to_the_leased_gpu_uuid(self) -> None:
        machine_id = "machine_test"
        job_id = "job_test"
        attempt_id = "attempt_test"
        session_id = "session_test"
        lease_token = "a" * 43
        resource_id = "resource_test01"
        events: list[dict[str, object]] = []

        job = {
            "id": job_id,
            "type": "WORKSPACE_PREPARE",
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            "parameters": {"workspaceSlug": "developer", "timeoutSeconds": 1200},
            "workspaceSession": {"id": session_id},
        }

        rental_authority = {
            "protocolVersion": 1,
            "leaseTtlSeconds": 45,
            "sessions": [{
                "sessionId": session_id,
                "status": "PREPARING",
                "resources": [{
                    "resourceId": resource_id,
                    "hardwareUuid": GPU_UUID,
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

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_args, **_kwargs):
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            if path == f"/agent/mining/{machine_id}/rental-authority":
                return rental_authority
            return {"ok": True}

        captured_calls: list[tuple] = []

        def fake_prepare_workspace(image, timeout_seconds, workspace_slug, progress_callback, gpu_uuid=None):
            captured_calls.append((image, timeout_seconds, workspace_slug, gpu_uuid))
            return {
                "gpuDetected": True,
                "summary": "Workspace developer préparé et contrôle isolé réussi.",
                "metrics": {"cacheHit": True, "workspaceSlug": "developer", "gpuCount": 1},
            }

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.prepare_workspace", side_effect=fake_prepare_workspace),
            patch("gpubnb_agent.cli.gpu_inventory", return_value=[{"gpuUuid": GPU_UUID}]),
        ):
            run_next_job(Mock(), object(), machine_id, {}, event_sink=events.append)

        # E/F. le workspace Developer a bien récupéré le hardwareUuid loué et l'a
        # transmis à prepare_workspace() - jamais None, jamais un index fixe.
        self.assertEqual(len(captured_calls), 1)
        image, _timeout, workspace_slug, gpu_uuid = captured_calls[0]
        self.assertEqual(image, DEFAULT_DEVELOPER_IMAGE)
        self.assertEqual(workspace_slug, "developer")
        self.assertEqual(gpu_uuid, GPU_UUID)

        self.assertTrue(any(event.get("event") == "job_completed" for event in events))
        self.assertFalse(any(event.get("event") == "job_failed" for event in events))

    def test_developer_workspace_fails_closed_without_touching_docker_when_authority_has_no_session(self) -> None:
        # H. rental authority absente (ou sans entrée pour cette session) -> échec
        # avant tout appel Docker, exactement comme pour GPU_PROOF.
        machine_id = "machine_test"
        job_id = "job_test"
        attempt_id = "attempt_test"
        session_id = "session_test"
        lease_token = "a" * 43
        events: list[dict[str, object]] = []

        job = {
            "id": job_id,
            "type": "WORKSPACE_PREPARE",
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            "parameters": {"workspaceSlug": "developer", "timeoutSeconds": 1200},
            "workspaceSession": {"id": session_id},
        }

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_args, **_kwargs):
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            if path == f"/agent/mining/{machine_id}/rental-authority":
                return {"protocolVersion": 1, "leaseTtlSeconds": 45, "sessions": []}
            return {"ok": True}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.prepare_workspace") as prepare_mock,
        ):
            run_next_job(Mock(), object(), machine_id, {}, event_sink=events.append)

        prepare_mock.assert_not_called()
        failed = [event for event in events if event.get("event") == "job_failed"]
        self.assertEqual(len(failed), 1)
        self.assertIn("rental_resource_authority_missing_for_session", str(failed[0]["message"]))
        self.assertFalse(any(event.get("event") == "job_completed" for event in events))

    def test_developer_workspace_fails_closed_when_leased_uuid_is_not_present_locally(self) -> None:
        # G. mismatch UUID serveur <-> UUID matériel -> échec, sans appel Docker.
        machine_id = "machine_test"
        job_id = "job_test"
        attempt_id = "attempt_test"
        session_id = "session_test"
        lease_token = "a" * 43
        resource_id = "resource_test01"
        events: list[dict[str, object]] = []

        job = {
            "id": job_id,
            "type": "WORKSPACE_PREPARE",
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            "parameters": {"workspaceSlug": "developer", "timeoutSeconds": 1200},
            "workspaceSession": {"id": session_id},
        }
        rental_authority = {
            "protocolVersion": 1,
            "leaseTtlSeconds": 45,
            "sessions": [{
                "sessionId": session_id,
                "status": "PREPARING",
                "resources": [{
                    "resourceId": resource_id,
                    "hardwareUuid": GPU_UUID,
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

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None, *_args, **_kwargs):
            if path == f"/agent/jobs/next/{machine_id}":
                return job
            if path == f"/agent/mining/{machine_id}/rental-authority":
                return rental_authority
            return {"ok": True}

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.prepare_workspace") as prepare_mock,
            patch("gpubnb_agent.cli.gpu_inventory", return_value=[{"gpuUuid": "GPU-99999999-8888-7777-6666-555555555555"}]),
        ):
            run_next_job(Mock(), object(), machine_id, {}, event_sink=events.append)

        prepare_mock.assert_not_called()
        failed = [event for event in events if event.get("event") == "job_failed"]
        self.assertEqual(len(failed), 1)
        self.assertIn("developer_workspace_gpu_uuid_not_found_locally", str(failed[0]["message"]))


if __name__ == "__main__":
    unittest.main()
