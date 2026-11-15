"""Source-level unit tests only; deliberately no GPU/Docker commands are executed."""
import unittest
from unittest.mock import patch

from gpubnb_agent.runner import DESKTOP_EGL_HEALTHCHECK_SCRIPT, workspace_health_command
from gpubnb_agent.desktop_workspace_preview import DESKTOP_WORKSPACE_SLUGS

IMAGE_BY_SLUG = {
    "creator": "gpubnb-creator-workspace@sha256:" + "a" * 64,
    "cloud-desktop": "gpubnb-cloud-desktop-workspace@sha256:" + "b" * 64,
    "cad": "gpubnb-cad-workspace@sha256:" + "c" * 64,
    "gaming": "gpubnb-gaming-workspace@sha256:" + "d" * 64,
}
GPU_UUID = "GPU-12345678-aaaa-bbbb-cccc-123456789012"


class DesktopStreamingHealthCheckTests(unittest.TestCase):
    def test_all_four_require_real_egl_and_exact_leased_gpu(self):
        self.assertEqual(set(IMAGE_BY_SLUG), DESKTOP_WORKSPACE_SLUGS)
        with patch("gpubnb_agent.runner.desktop_workspace_preview_enabled", return_value=True):
            for slug, image in IMAGE_BY_SLUG.items():
                with self.subTest(slug=slug):
                    command = workspace_health_command(image, slug, GPU_UUID)
                    self.assertIn("--network=none", command)
                    self.assertIn(f"--gpus=device={GPU_UUID}", command)
                    self.assertIn(f"--env=GPUBNB_TARGET_GPU_UUID={GPU_UUID}", command)
                    self.assertIn("DESKTOP_EGL_HEALTHCHECK_SCRIPT", "DESKTOP_EGL_HEALTHCHECK_SCRIPT")
                    self.assertIn(DESKTOP_EGL_HEALTHCHECK_SCRIPT, command)
                    self.assertNotIn("--privileged", command)

    def test_preflight_refuses_missing_or_invalid_gpu(self):
        with patch("gpubnb_agent.runner.desktop_workspace_preview_enabled", return_value=True):
            for slug, image in IMAGE_BY_SLUG.items():
                for gpu_uuid in (None, "", "0", "x;rm -rf /"):
                    with self.subTest(slug=slug, gpu_uuid=gpu_uuid):
                        with self.assertRaisesRegex(RuntimeError, "invalid_target_gpu"):
                            workspace_health_command(image, slug, gpu_uuid)

    def test_preview_gate_is_applied_before_starting_a_container(self):
        with patch("gpubnb_agent.runner.desktop_workspace_preview_enabled", return_value=False):
            for slug, image in IMAGE_BY_SLUG.items():
                with self.assertRaisesRegex(RuntimeError, "preview_not_enabled"):
                    workspace_health_command(image, slug, GPU_UUID)

    def test_renderer_validation_denies_software_fallback(self):
        for required in ("/dev/dri/renderD", "nvidia-smi", "eglinfo", "swrast", "llvmpipe"):
            self.assertIn(required, DESKTOP_EGL_HEALTHCHECK_SCRIPT)


if __name__ == "__main__":
    unittest.main()
