import inspect
import unittest
from unittest.mock import patch

import gpubnb_agent
from gpubnb_agent import cli


class JobLeaseProtocolTests(unittest.TestCase):
    def test_agent_version_moves_with_the_job_lease_protocol(self):
        self.assertEqual(gpubnb_agent.__version__, "0.6.0")

    def test_state_update_sends_attempt_and_lease_token_inside_signed_body(self):
        captured = {}

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None):
            captured.update(path=path, method=method, body=body)
            return {"ok": True}

        with patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request):
            cli.update_job(
                object(), object(), "machine-1", "job-1",
                "attempt-1", "lease-token-value", "RUNNING",
            )

        self.assertEqual(captured["path"], "/agent/jobs/job-1/state")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["body"]["attemptId"], "attempt-1")
        self.assertEqual(captured["body"]["leaseToken"], "lease-token-value")

    def test_progress_report_sends_attempt_and_lease_token(self):
        captured = {}

        def fake_agent_request(_api, _key, _machine_id, path, method="GET", body=None):
            captured.update(path=path, method=method, body=body)
            return {"ok": True}

        with patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request):
            cli.report_job_progress(
                object(), object(), "machine-1", "job-1",
                "attempt-1", "lease-token-value", "PULLING_IMAGE", 12,
            )

        self.assertEqual(captured["path"], "/agent/jobs/job-1/progress")
        self.assertEqual(captured["body"]["attemptId"], "attempt-1")
        self.assertEqual(captured["body"]["leaseToken"], "lease-token-value")

    def test_claim_without_lease_credentials_is_rejected_before_execution(self):
        job = {
            "id": "job-1",
            "type": "WORKSPACE_PREPARE",
            "parameters": {"workspaceSlug": "developer"},
        }
        with patch("gpubnb_agent.cli.agent_request", return_value=job):
            with self.assertRaisesRegex(RuntimeError, "job_lease_credentials_missing"):
                cli.run_next_job(object(), object(), "machine-1", {})

    def test_worker_contains_independent_lease_renewal_and_fenced_control(self):
        source = inspect.getsource(cli.run_next_job)
        self.assertIn('lease_path = f"/agent/jobs/{job_id}/lease"', source)
        self.assertIn('lease_stop.wait(10)', source)
        self.assertIn('"stale_job_attempt"', source)
        self.assertIn('control_path = f"/agent/jobs/{job_id}/control"', source)
        self.assertIn('control_path, "POST"', source)
        self.assertNotIn('leaseToken": lease_token})\n                    emit', source)


if __name__ == "__main__":
    unittest.main()