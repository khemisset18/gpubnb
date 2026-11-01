from __future__ import annotations

import unittest
from unittest.mock import patch

from gpubnb_agent import windows_native_capability as capability
from gpubnb_agent.windows_native_workspace import NativeDesktopPreflight


class PrivateConsoleProbeTests(unittest.TestCase):
    def test_off_by_default_never_opens_helper_or_mutates_iddcx_cache(self):
        with patch.object(capability, "find_stream_helper") as helper:
            before = capability.cached_native_desktop_capability_snapshot()
            result = capability.probe_private_console_capability(enabled=False)
            after = capability.cached_native_desktop_capability_snapshot()
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "private_console_disabled")
        self.assertIs(before, after)
        helper.assert_not_called()

    def test_console_proof_is_separate_and_uses_console_abi(self):
        ready = NativeDesktopPreflight(
            True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            "nvenc", "private-test", False
        )
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "_FENCED_NATIVE_RENTALS", set()),
            patch.object(capability, "_persisted_physical_probe_block_reason", return_value=None),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as probe,
        ):
            result = capability.probe_private_console_capability(enabled=True)
        self.assertTrue(result.available)
        probe.assert_called_once_with("helper.exe", capture_backend="console-dedicated")

    def test_persisted_claim_blocks_capture_before_helper(self):
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "_FENCED_NATIVE_RENTALS", set()),
            patch.object(capability, "_persisted_physical_probe_block_reason", return_value="native_gpu_runtime_fenced"),
            patch.object(capability, "find_stream_helper") as helper,
        ):
            result = capability.probe_private_console_capability(enabled=True)
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_gpu_runtime_fenced")
        helper.assert_not_called()

    def test_unknown_probe_error_refuses_without_leaking_exception(self):
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "_FENCED_NATIVE_RENTALS", set()),
            patch.object(capability, "_persisted_physical_probe_block_reason", return_value=None),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "windows_native_desktop_preflight", side_effect=RuntimeError("PRIVATE-HOST-SECRET")),
        ):
            result = capability.probe_private_console_capability(enabled=True)
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_console_probe_failed")


if __name__ == "__main__":
    unittest.main()
