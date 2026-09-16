from __future__ import annotations

import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gpubnb_agent import windows_native_workspace as native


class WindowsNativeWorkspaceTests(unittest.TestCase):
    def _passing_report(self, **overrides):
        report = {
            "schemaVersion": 1,
            "platform": "windows",
            "helperVersion": "0.1-test",
            "gpuUuid": "GPU-EXACT",
            "isolatedSession": True,
            "captureFrame": True,
            "hardwareEncoder": "nvenc",
            "mediaLoopback": True,
            "inputIsolation": True,
            "audioAvailable": True,
        }
        report.update(overrides)
        return SimpleNamespace(returncode=0, stdout=json.dumps(report), stderr="")

    def test_exact_four_windows_native_workspace_profiles(self):
        self.assertEqual(
            native.WINDOWS_NATIVE_WORKSPACE_SLUGS,
            frozenset({"cloud-desktop", "creator", "cad", "gaming"}),
        )
        self.assertEqual(set(native.WINDOWS_NATIVE_WORKSPACE_PROFILES), native.WINDOWS_NATIVE_WORKSPACE_SLUGS)
        self.assertIsNone(native.profile_for_slug("cloud-desktop").application)
        self.assertEqual(native.profile_for_slug("creator").application, "Blender")
        self.assertEqual(native.profile_for_slug("cad").application, "FreeCAD")
        gaming = native.profile_for_slug("gaming")
        self.assertEqual(gaming.application, "Steam")
        self.assertTrue(gaming.requires_audio)
        self.assertTrue(gaming.requires_controller)
        self.assertTrue(gaming.allows_outbound_network)

    def test_non_windows_fails_closed_without_running_helper(self):
        with (
            patch.object(native.platform, "system", return_value="Linux"),
            patch.object(native, "run_command") as run_command,
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "windows_required")
        run_command.assert_not_called()

    def test_missing_helper_fails_closed(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "find_stream_helper", return_value=None),
        ):
            result = native.windows_native_desktop_preflight()
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_helper_missing")

    def test_cuda_or_gpu_presence_cannot_replace_real_self_test(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=SimpleNamespace(returncode=1, stdout="", stderr="failed")),
            patch.object(native, "gpu_inventory", return_value=[{
                "gpuVendor": "NVIDIA",
                "gpuUuid": "GPU-EXACT",
                "vramMiB": 24576,
                "cudaVersion": "12.8",
            }]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_self_test_failed")

    def test_self_test_requires_isolated_session_capture_media_and_input(self):
        for field in ("isolatedSession", "captureFrame", "mediaLoopback", "inputIsolation"):
            with self.subTest(field=field):
                with (
                    patch.object(native.platform, "system", return_value="Windows"),
                    patch.object(native, "run_command", return_value=self._passing_report(**{field: False})),
                    patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-EXACT"}]),
                ):
                    result = native.windows_native_desktop_preflight("helper.exe")
                    self.assertFalse(result.available)
                    self.assertIn(field, result.reason)

    def test_self_test_requires_nvenc(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=self._passing_report(hardwareEncoder="software")),
            patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-EXACT"}]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_nvenc_required")

    def test_helper_gpu_must_match_real_local_nvidia_gpu(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=self._passing_report(gpuUuid="GPU-OTHER")),
            patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-EXACT"}]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_gpu_uuid_not_local")

    def test_passing_real_contract_returns_available(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=self._passing_report()),
            patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-EXACT"}]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertTrue(result.available)
        self.assertEqual(result.reason, "ready")
        self.assertEqual(result.gpu_uuid, "GPU-EXACT")
        self.assertEqual(result.hardware_encoder, "nvenc")
        self.assertTrue(result.audio_available)

    def test_gaming_requires_audio_even_when_stream_preflight_passes(self):
        with (
            patch.object(native, "windows_native_desktop_preflight", return_value=native.NativeDesktopPreflight(
                True, "ready", "GPU-EXACT", "nvenc", "0.1", False,
            )),
            patch.object(native, "discover_native_application", return_value=r"C:\Steam\steam.exe"),
        ):
            ready, reason = native.workspace_native_ready("gaming", "helper.exe")
        self.assertFalse(ready)
        self.assertEqual(reason, "workspace_audio_required")

    def test_creator_requires_native_application_after_stream_preflight(self):
        with (
            patch.object(native, "windows_native_desktop_preflight", return_value=native.NativeDesktopPreflight(
                True, "ready", "GPU-EXACT", "nvenc", "0.1", True,
            )),
            patch.object(native, "discover_native_application", return_value=None),
        ):
            ready, reason = native.workspace_native_ready("creator", "helper.exe")
        self.assertFalse(ready)
        self.assertEqual(reason, "creator_application_missing")

    def test_unknown_slug_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported_windows_native_workspace"):
            native.profile_for_slug("developer")


if __name__ == "__main__":
    unittest.main()
