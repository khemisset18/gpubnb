import unittest

from gpubnb_agent.runtime_images import (
    DEFAULT_AI_IMAGE,
    DEFAULT_API_IMAGE,
    DEFAULT_AUDIO_IMAGE,
    DEFAULT_CAD_IMAGE,
    DEFAULT_CLOUD_DESKTOP_IMAGE,
    DEFAULT_COMPUTE_IMAGE,
    DEFAULT_CREATOR_IMAGE,
    DEFAULT_DATA_IMAGE,
    DEFAULT_DEVELOPER_IMAGE,
    DEFAULT_GAMING_IMAGE,
    DEFAULT_MOBILE_IMAGE,
    DEFAULT_SECURITY_LAB_IMAGE,
    DEFAULT_VIDEO_IMAGE,
    workspace_image,
)


class RuntimeImageDefaultsTests(unittest.TestCase):
    def test_fresh_host_has_an_official_digest_pinned_developer_image(self):
        self.assertRegex(
            DEFAULT_DEVELOPER_IMAGE,
            r"^ghcr\.io/khemisset18/gpubnb-developer@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "developer"), DEFAULT_DEVELOPER_IMAGE)

    def test_owner_never_needs_to_paste_an_image_but_explicit_pins_remain_supported(self):
        explicit = "ghcr.io/khemisset18/gpubnb-developer@sha256:" + ("a" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"developer": explicit}}, "developer"),
            explicit,
        )

    def test_retired_official_image_is_migrated_to_the_current_default(self):
        retired = (
            "ghcr.io/khemisset18/gpubnb-developer@sha256:"
            "26700fdc955495b610bbcf8a912110395fc72181a236de2b70b539a0c02150b7"
        )
        self.assertEqual(
            workspace_image({"workspaceImages": {"developer": retired}}, "developer"),
            DEFAULT_DEVELOPER_IMAGE,
        )

    def test_fresh_host_has_an_official_digest_pinned_compute_image(self):
        self.assertRegex(
            DEFAULT_COMPUTE_IMAGE,
            r"^ghcr\.io/khemisset18/gpu-proof-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "compute"), DEFAULT_COMPUTE_IMAGE)

    def test_explicit_compute_pin_remains_supported(self):
        explicit = "ghcr.io/khemisset18/gpu-proof-workspace@sha256:" + ("b" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"compute": explicit}}, "compute"),
            explicit,
        )

    def test_fresh_host_has_an_official_digest_pinned_data_image(self):
        self.assertRegex(
            DEFAULT_DATA_IMAGE,
            r"^quay\.io/jupyter/datascience-notebook@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "data"), DEFAULT_DATA_IMAGE)

    def test_explicit_data_pin_remains_supported(self):
        explicit = "quay.io/jupyter/datascience-notebook@sha256:" + ("c" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"data": explicit}}, "data"),
            explicit,
        )

    def test_fresh_host_has_an_official_digest_pinned_ai_image(self):
        self.assertRegex(
            DEFAULT_AI_IMAGE,
            r"^quay\.io/jupyter/pytorch-notebook@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "ai"), DEFAULT_AI_IMAGE)

    def test_explicit_ai_pin_remains_supported(self):
        explicit = "quay.io/jupyter/pytorch-notebook@sha256:" + ("e" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"ai": explicit}}, "ai"),
            explicit,
        )

    def test_fresh_host_has_an_official_digest_pinned_video_image(self):
        self.assertRegex(
            DEFAULT_VIDEO_IMAGE,
            r"^quay\.io/jupyter/datascience-notebook@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "video"), DEFAULT_VIDEO_IMAGE)

    def test_explicit_video_pin_remains_supported(self):
        explicit = "quay.io/jupyter/datascience-notebook@sha256:" + ("f" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"video": explicit}}, "video"),
            explicit,
        )

    def test_fresh_host_has_an_official_digest_pinned_audio_image(self):
        self.assertRegex(
            DEFAULT_AUDIO_IMAGE,
            r"^quay\.io/jupyter/datascience-notebook@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "audio"), DEFAULT_AUDIO_IMAGE)

    def test_explicit_audio_pin_remains_supported(self):
        explicit = "quay.io/jupyter/datascience-notebook@sha256:" + ("9" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"audio": explicit}}, "audio"),
            explicit,
        )

    def test_fresh_host_has_an_official_digest_pinned_api_image(self):
        self.assertRegex(
            DEFAULT_API_IMAGE,
            r"^quay\.io/jupyter/datascience-notebook@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "api"), DEFAULT_API_IMAGE)

    def test_explicit_api_pin_remains_supported(self):
        explicit = "quay.io/jupyter/datascience-notebook@sha256:" + ("1" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"api": explicit}}, "api"),
            explicit,
        )

    def test_mobile_image_is_a_real_content_addressed_local_digest(self):
        # Not a registry reference (see the constant's own comment) - still
        # must be a real digest-pinned reference, just under the local-only
        # gpubnb-mobile-workspace repo name rather than a registry host.
        self.assertRegex(
            DEFAULT_MOBILE_IMAGE,
            r"^gpubnb-mobile-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "mobile"), DEFAULT_MOBILE_IMAGE)

    def test_explicit_mobile_pin_remains_supported(self):
        explicit = "gpubnb-mobile-workspace@sha256:" + ("2" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"mobile": explicit}}, "mobile"),
            explicit,
        )

    def test_security_lab_image_is_a_real_content_addressed_local_digest(self):
        self.assertRegex(
            DEFAULT_SECURITY_LAB_IMAGE,
            r"^gpubnb-security-lab-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "security-lab"), DEFAULT_SECURITY_LAB_IMAGE)

    def test_explicit_security_lab_pin_remains_supported(self):
        explicit = "gpubnb-security-lab-workspace@sha256:" + ("5" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"security-lab": explicit}}, "security-lab"),
            explicit,
        )

    # Creator / Cloud Desktop / CAD / Gaming - NOT REAL_WORKING, NOT
    # bookable (not in executableWorkspaceSlugs/GATEWAY_WORKSPACE_SLUGS).
    # These tests only prove the image-selection logic itself is correct
    # and real-digest-pinned, same as every other workspace here - they do
    # not, and cannot, prove GPU desktop rendering works. See
    # docs/SESSION_RESUME.md section 8/9.

    def test_cloud_desktop_image_is_a_real_content_addressed_local_digest(self):
        self.assertRegex(
            DEFAULT_CLOUD_DESKTOP_IMAGE,
            r"^gpubnb-cloud-desktop-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "cloud-desktop"), DEFAULT_CLOUD_DESKTOP_IMAGE)

    def test_explicit_cloud_desktop_pin_remains_supported(self):
        explicit = "gpubnb-cloud-desktop-workspace@sha256:" + ("3" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"cloud-desktop": explicit}}, "cloud-desktop"),
            explicit,
        )

    def test_creator_image_is_a_real_content_addressed_local_digest(self):
        self.assertRegex(
            DEFAULT_CREATOR_IMAGE,
            r"^gpubnb-creator-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "creator"), DEFAULT_CREATOR_IMAGE)

    def test_explicit_creator_pin_remains_supported(self):
        explicit = "gpubnb-creator-workspace@sha256:" + ("4" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"creator": explicit}}, "creator"),
            explicit,
        )

    def test_cad_image_is_a_real_content_addressed_local_digest(self):
        self.assertRegex(
            DEFAULT_CAD_IMAGE,
            r"^gpubnb-cad-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "cad"), DEFAULT_CAD_IMAGE)

    def test_explicit_cad_pin_remains_supported(self):
        explicit = "gpubnb-cad-workspace@sha256:" + ("6" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"cad": explicit}}, "cad"),
            explicit,
        )

    def test_gaming_image_is_a_real_content_addressed_local_digest(self):
        self.assertRegex(
            DEFAULT_GAMING_IMAGE,
            r"^gpubnb-gaming-workspace@sha256:[a-f0-9]{64}$",
        )
        self.assertEqual(workspace_image({}, "gaming"), DEFAULT_GAMING_IMAGE)

    def test_explicit_gaming_pin_remains_supported(self):
        explicit = "gpubnb-gaming-workspace@sha256:" + ("7" * 64)
        self.assertEqual(
            workspace_image({"workspaceImages": {"gaming": explicit}}, "gaming"),
            explicit,
        )


if __name__ == "__main__":
    unittest.main()
