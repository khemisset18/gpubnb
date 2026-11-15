"""Lab gating only: no Docker execution, no GPU, no production changes."""
import unittest

from gpubnb_agent.desktop_workspace_preview import (
    DESKTOP_WORKSPACE_SLUGS,
    desktop_workspace_preview_enabled,
)


class DesktopWorkspacePreviewTests(unittest.TestCase):
    def test_four_explicit_slugs(self):
        self.assertEqual(
            DESKTOP_WORKSPACE_SLUGS,
            {"creator", "cloud-desktop", "cad", "gaming"},
        )

    def test_fail_closed_by_default_and_in_production(self):
        self.assertFalse(desktop_workspace_preview_enabled({}, platform_name="linux", kernel_release="6.1"))
        self.assertFalse(desktop_workspace_preview_enabled(
            {"NODE_ENV": "production", "GPUBNB_DESKTOP_WORKSPACE_PREVIEW": "true"},
            platform_name="linux", kernel_release="6.1",
        ))

    def test_windows_and_wsl_always_refused(self):
        env = {"NODE_ENV": "test", "GPUBNB_DESKTOP_WORKSPACE_PREVIEW": "true"}
        self.assertFalse(desktop_workspace_preview_enabled(env, platform_name="win32", kernel_release="10.0"))
        self.assertFalse(desktop_workspace_preview_enabled(env, platform_name="linux", kernel_release="5.15-microsoft-standard-WSL2"))

    def test_explicit_non_wsl_linux_test_only(self):
        env = {"NODE_ENV": "test", "GPUBNB_DESKTOP_WORKSPACE_PREVIEW": "true"}
        self.assertTrue(desktop_workspace_preview_enabled(env, platform_name="linux", kernel_release="6.8.0-generic"))
        self.assertFalse(desktop_workspace_preview_enabled(
            {"NODE_ENV": "test", "GPUBNB_DESKTOP_WORKSPACE_PREVIEW": "TRUE"},
            platform_name="linux", kernel_release="6.8.0-generic",
        ))


if __name__ == "__main__":
    unittest.main()
