import subprocess
import unittest
from unittest.mock import patch

from gpubnb_agent.runner import prewarm_workspace_image


IMAGE = "ghcr.io/khemisset18/gpubnb-developer@sha256:" + ("a" * 64)


def result(code: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], code, "", "")


class ImagePrewarmTests(unittest.TestCase):
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_cached_digest_never_contacts_the_registry_again(self, run):
        run.return_value = result(0)
        value = prewarm_workspace_image(IMAGE)
        self.assertTrue(value["cacheHit"])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][:3], ["docker", "image", "inspect"])

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_missing_digest_is_pulled_once_then_verified(self, run):
        run.side_effect = [result(1), result(0), result(0)]
        progress = []
        value = prewarm_workspace_image(IMAGE, progress_callback=lambda step, elapsed: progress.append((step, elapsed)))
        self.assertFalse(value["cacheHit"])
        self.assertEqual([call.args[0][1] for call in run.call_args_list], ["image", "pull", "image"])
        self.assertEqual(
            [step for step, _ in progress],
            ["WAITING_FOR_IMAGE_PULL", "CHECKING_IMAGE_CACHE", "PULLING_IMAGE", "VERIFYING_IMAGE_DIGEST", "IMAGE_CACHE_READY"],
        )

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_unofficial_image_is_rejected_before_docker(self, run):
        with self.assertRaisesRegex(RuntimeError, "official"):
            prewarm_workspace_image("ghcr.io/attacker/gpubnb-developer@sha256:" + ("b" * 64))
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
