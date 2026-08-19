import unittest
from unittest.mock import patch

from gpubnb_agent.runner import (
    GPU_PROOF_IMAGE_PULL_TIMEOUT_SECONDS,
    gpu_proof_command,
    run_gpu_proof_workspace,
)


OFFICIAL_PROOF_IMAGE = "ghcr.io/khemisset18/gpu-proof-workspace@sha256:" + ("a" * 64)


class GpuProofCommandTests(unittest.TestCase):
    def test_command_is_bounded_and_has_no_host_or_network_access(self):
        command = gpu_proof_command(OFFICIAL_PROOF_IMAGE, 300, "gpubnb-proof-test")
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)
        self.assertIn("--cap-drop=ALL", command)
        self.assertIn("--security-opt=no-new-privileges", command)
        self.assertNotIn("--privileged", command)
        self.assertFalse(any(value.startswith("--volume") or value.startswith("--mount") for value in command))
        self.assertEqual(command[-3:], [OFFICIAL_PROOF_IMAGE, "--duration-seconds", "300"])

    @patch("gpubnb_agent.runner.cleanup_workspace", return_value={"cleaned": True})
    @patch("gpubnb_agent.runner.subprocess.Popen", side_effect=RuntimeError("stop_after_pull"))
    @patch("gpubnb_agent.runner._pull_image")
    def test_gpu_proof_allows_long_uncached_image_pull(self, pull, _popen, _cleanup):
        self.assertGreaterEqual(GPU_PROOF_IMAGE_PULL_TIMEOUT_SECONDS, 600)
        with self.assertRaisesRegex(RuntimeError, "stop_after_pull"):
            run_gpu_proof_workspace(OFFICIAL_PROOF_IMAGE, 30)
        pull.assert_called_once_with(
            OFFICIAL_PROOF_IMAGE,
            GPU_PROOF_IMAGE_PULL_TIMEOUT_SECONDS,
        )

    def test_duration_is_clamped_and_untrusted_images_are_rejected(self):
        command = gpu_proof_command(OFFICIAL_PROOF_IMAGE, 9999, "gpubnb-proof-test")
        self.assertEqual(command[-1], "600")
        with self.assertRaisesRegex(RuntimeError, "gpu_proof_image_not_official_or_pinned"):
            gpu_proof_command("evil.example/workspace@sha256:" + ("b" * 64), 60, "safe")


if __name__ == "__main__":
    unittest.main()
