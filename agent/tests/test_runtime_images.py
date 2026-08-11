import unittest

from gpubnb_agent.runtime_images import DEFAULT_DEVELOPER_IMAGE, workspace_image


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

    def test_compute_keeps_using_the_configured_diagnostic_image(self):
        diagnostic = "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("b" * 64)
        self.assertEqual(workspace_image({"diagnosticImage": diagnostic}, "compute"), diagnostic)


if __name__ == "__main__":
    unittest.main()
