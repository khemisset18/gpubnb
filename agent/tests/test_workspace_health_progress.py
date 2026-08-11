import subprocess
import time
import unittest
from unittest.mock import patch

from gpubnb_agent.runner import prepare_workspace


IMAGE = "ghcr.io/khemisset18/gpubnb-developer@sha256:" + ("a" * 64)


class WorkspaceHealthProgressTests(unittest.TestCase):
    def test_long_health_check_keeps_reporting_progress(self) -> None:
        progress: list[tuple[str, int]] = []

        def slow_health(*_args, **_kwargs):
            time.sleep(0.05)
            return subprocess.CompletedProcess([], 0, "", "")

        with (
            patch("gpubnb_agent.runner._pull_image", return_value=True),
            patch("gpubnb_agent.runner.workspace_health_command", return_value=["docker", "run"]),
            patch("gpubnb_agent.runner.subprocess.run", side_effect=slow_health),
            patch("gpubnb_agent.runner.gpu_inventory", return_value=[{"gpuModel": "GPU"}]),
            patch("gpubnb_agent.runner.PROGRESS_INTERVAL_SECONDS", 0.01),
        ):
            result = prepare_workspace(
                IMAGE,
                1200,
                "developer",
                lambda step, elapsed: progress.append((step, elapsed)),
            )

        verifying = [step for step, _ in progress if step == "VERIFYING_WORKSPACE"]
        self.assertGreaterEqual(len(verifying), 2, "the job lease must stay fresh throughout the health check")
        self.assertEqual(progress[-1][0], "WORKSPACE_VERIFIED")
        self.assertTrue(result["gpuDetected"])


if __name__ == "__main__":
    unittest.main()
