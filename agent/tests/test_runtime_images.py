import unittest

from gpubnb_agent.runtime_images import (
    DEFAULT_COMPUTE_IMAGE,
    DEFAULT_DATA_IMAGE,
    DEFAULT_DEVELOPER_IMAGE,
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


if __name__ == "__main__":
    unittest.main()
