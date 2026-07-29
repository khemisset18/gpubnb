import os
import unittest
from unittest.mock import patch

from gpubnb_agent import windows_service


class WindowsServiceTests(unittest.TestCase):
    def test_service_management_fails_closed_off_windows(self) -> None:
        if os.name == "nt":
            self.skipTest("non-Windows contract test")
        with self.assertRaisesRegex(RuntimeError, "not_supported"):
            windows_service.manage_service("install")

    def test_service_identity_is_stable(self) -> None:
        self.assertEqual(windows_service.SERVICE_NAME, "GPUbnbAgent")
        self.assertNotIn(" ", windows_service.SERVICE_NAME)

    def test_missing_runtime_is_not_reported_as_success(self) -> None:
        with (
            patch.object(windows_service.os, "name", "nt"),
            patch.dict("sys.modules", {"servicemanager": None}),
        ):
            with self.assertRaisesRegex(RuntimeError, "runtime_missing"):
                windows_service._require_windows()


if __name__ == "__main__":
    unittest.main()
