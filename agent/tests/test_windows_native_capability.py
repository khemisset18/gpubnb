from __future__ import annotations

import unittest
from unittest.mock import patch

from gpubnb_agent import windows_native_capability as capability
from gpubnb_agent.windows_native_workspace import NativeDesktopPreflight


class WindowsNativeCapabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        capability.invalidate_native_desktop_capability_cache()

    def tearDown(self) -> None:
        capability.invalidate_native_desktop_capability_cache()

    def test_non_windows_is_immediately_unavailable_without_helper_probe(self):
        with (
            patch.object(capability.platform, "system", return_value="Linux"),
            patch.object(capability, "find_stream_helper") as find_helper,
            patch.object(capability, "windows_native_desktop_preflight") as preflight,
        ):
            snapshot = capability.probe_native_desktop_capability(clock=lambda: 10.0)
        self.assertFalse(snapshot.available)
        self.assertEqual(snapshot.reason, "windows_required")
        find_helper.assert_not_called()
        preflight.assert_not_called()

    def test_positive_proof_is_cached_for_short_ttl(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            first = capability.probe_native_desktop_capability(clock=lambda: 10.0)
            second = capability.probe_native_desktop_capability(clock=lambda: 20.0)
        self.assertTrue(first.available)
        self.assertIs(first, second)
        self.assertEqual(preflight.call_count, 1)

    def test_positive_proof_expires_and_is_remeasured(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(
                clock=lambda: 10.0 + capability.POSITIVE_TTL_SECONDS
            )
        self.assertEqual(preflight.call_count, 2)

    def test_negative_proof_uses_shorter_ttl(self):
        missing = NativeDesktopPreflight(False, "native_stream_helper_missing")
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value=None),
            patch.object(capability, "_helper_identity", return_value=(None, None, None)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=missing) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(clock=lambda: 20.0)
            capability.probe_native_desktop_capability(
                clock=lambda: 10.0 + capability.NEGATIVE_TTL_SECONDS
            )
        self.assertEqual(preflight.call_count, 2)

    def test_helper_identity_change_invalidates_cache_immediately(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        identities = [("helper.exe", 1, 100), ("helper.exe", 2, 101)]
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", side_effect=identities),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(clock=lambda: 11.0)
        self.assertEqual(preflight.call_count, 2)

    def test_force_bypasses_fresh_cache(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(force=True, clock=lambda: 11.0)
        self.assertEqual(preflight.call_count, 2)

    def test_unexpected_probe_exception_fails_closed_and_is_cacheable(self):
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", side_effect=RuntimeError("boom")) as preflight,
        ):
            first = capability.probe_native_desktop_capability(clock=lambda: 10.0)
            second = capability.probe_native_desktop_capability(clock=lambda: 11.0)
        self.assertFalse(first.available)
        self.assertEqual(first.reason, "native_stream_probe_error:RuntimeError")
        self.assertIs(first, second)
        self.assertEqual(preflight.call_count, 1)


if __name__ == "__main__":
    unittest.main()
