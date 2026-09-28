from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

from gpubnb_agent import windows_native_workspace as native


class WindowsNativeWorkspaceTests(unittest.TestCase):
    def _passing_report(self, **overrides):
        report = {
            "schemaVersion": 1,
            "platform": "windows",
            "helperVersion": "0.1-test",
            "gpuUuid": "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            "isolatedSession": True,
            "separateRenterIdentity": True,
            "renterSessionActive": True,
            "providerSessionInactive": True,
            "virtualDisplay": True,
            "providerDesktopExcluded": True,
            "captureFrame": True,
            "exactGpuBound": True,
            "nvencReady": True,
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

    def test_native_application_discovery_never_accepts_path_only_executables(self):
        with patch.object(native.Path, "is_file", return_value=False):
            self.assertIsNone(native.discover_native_application("creator"))
            self.assertIsNone(native.discover_native_application("cad"))
            self.assertIsNone(native.discover_native_application("gaming"))
        for slug in ("creator", "cad", "gaming"):
            self.assertTrue(
                all(
                    native.PureWindowsPath(candidate).is_absolute()
                    for candidate in native.profile_for_slug(slug).executable_candidates
                )
            )

    def test_helper_discovery_never_uses_path_lookup(self):
        with (
            patch.object(native, "_find_absolute_windows_file", return_value=None) as absolute_file,
            patch.dict(native.os.environ, {}, clear=True),
        ):
            self.assertIsNone(native.find_stream_helper())
        absolute_file.assert_called_once_with(native.WINDOWS_STREAM_HELPER_INSTALL_PATH)

    def test_dev_helper_requires_explicit_opt_in(self):
        dev = r"C:\\dev\\gpubnb-windows-stream.exe"
        with (
            patch.object(native, "_find_absolute_windows_file", side_effect=[None, dev]) as absolute_file,
            patch.dict(
                native.os.environ,
                {
                    native.WINDOWS_STREAM_HELPER_DEV_ALLOW_ENV: "1",
                    native.WINDOWS_STREAM_HELPER_DEV_PATH_ENV: dev,
                },
                clear=True,
            ),
        ):
            self.assertEqual(native.find_stream_helper(), dev)
        self.assertEqual(
            absolute_file.call_args_list,
            [call(native.WINDOWS_STREAM_HELPER_INSTALL_PATH), call(dev)],
        )

    def test_self_test_process_failures_are_stable_and_fail_closed(self):
        for failure in (OSError("secret"), subprocess.TimeoutExpired("secret", 30), UnicodeError("secret")):
            with (
                self.subTest(failure=type(failure).__name__),
                patch.object(native.platform, "system", return_value="Windows"),
                patch.object(native, "run_command", side_effect=failure),
            ):
                result = native.windows_native_desktop_preflight("helper.exe")
            self.assertFalse(result.available)
            self.assertEqual(result.reason, "native_stream_self_test_failed")

    def test_cuda_or_gpu_presence_cannot_replace_real_self_test(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=SimpleNamespace(returncode=1, stdout="", stderr="failed")),
            patch.object(native, "gpu_inventory", return_value=[{
                "gpuVendor": "NVIDIA",
                "gpuUuid": "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
                "vramMiB": 24576,
                "cudaVersion": "12.8",
            }]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_self_test_failed")

    def test_self_test_requires_isolated_session_capture_media_and_input(self):
        for field in (
            "isolatedSession",
            "separateRenterIdentity",
            "renterSessionActive",
            "providerSessionInactive",
            "virtualDisplay",
            "providerDesktopExcluded",
            "captureFrame",
            "exactGpuBound",
            "nvencReady",
            "mediaLoopback",
            "inputIsolation",
        ):
            with self.subTest(field=field):
                with (
                    patch.object(native.platform, "system", return_value="Windows"),
                    patch.object(native, "run_command", return_value=self._passing_report(**{field: False})),
                    patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"}]),
                ):
                    result = native.windows_native_desktop_preflight("helper.exe")
                    self.assertFalse(result.available)
                    self.assertIn(field, result.reason)

    def test_self_test_requires_nvenc(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=self._passing_report(hardwareEncoder="software")),
            patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"}]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_nvenc_required")

    def test_helper_gpu_must_match_real_local_nvidia_gpu(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=self._passing_report(gpuUuid="GPU-11111111-2222-3333-4444-555555555555")),
            patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"}]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "native_stream_gpu_uuid_not_local")

    def test_passing_real_contract_returns_available(self):
        with (
            patch.object(native.platform, "system", return_value="Windows"),
            patch.object(native, "run_command", return_value=self._passing_report()),
            patch.object(native, "gpu_inventory", return_value=[{"gpuVendor": "NVIDIA", "gpuUuid": "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"}]),
        ):
            result = native.windows_native_desktop_preflight("helper.exe")
        self.assertTrue(result.available)
        self.assertEqual(result.reason, "ready")
        self.assertEqual(result.gpu_uuid, "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a")
        self.assertEqual(result.hardware_encoder, "nvenc")
        self.assertTrue(result.audio_available)

    def test_gaming_requires_audio_even_when_stream_preflight_passes(self):
        with (
            patch.object(native, "windows_native_desktop_preflight", return_value=native.NativeDesktopPreflight(
                True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.1", False,
            )),
            patch.object(native, "discover_native_application", return_value=r"C:\Steam\steam.exe"),
        ):
            ready, reason = native.workspace_native_ready("gaming", "helper.exe")
        self.assertFalse(ready)
        self.assertEqual(reason, "workspace_audio_required")

    def test_creator_requires_native_application_after_stream_preflight(self):
        with (
            patch.object(native, "windows_native_desktop_preflight", return_value=native.NativeDesktopPreflight(
                True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.1", True,
            )),
            patch.object(native, "discover_native_application", return_value=None),
        ):
            ready, reason = native.workspace_native_ready("creator", "helper.exe")
        self.assertFalse(ready)
        self.assertEqual(reason, "creator_application_missing")

    def test_invalid_uuid_and_noninteger_schema_cannot_pass_matching_inventory(self):
        for changes in (
            {"gpuUuid": "GPU-INVALID"}, {"gpuUuid": 123},
            {"schemaVersion": True}, {"schemaVersion": 1.0},
        ):
            with (
                self.subTest(changes=changes),
                patch.object(native.platform, "system", return_value="Windows"),
                patch.object(native, "run_command", return_value=self._passing_report(**changes)),
                patch.object(native, "gpu_inventory", return_value=[{
                    "gpuVendor": "NVIDIA", "gpuUuid": changes.get("gpuUuid"),
                }]),
            ):
                self.assertFalse(native.windows_native_desktop_preflight("helper.exe").available)

    def test_amd_absent_and_other_gpu_do_not_prove_selected_nvidia(self):
        selected = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
        other = "GPU-11111111-2222-3333-4444-555555555555"
        for inventory in (
            [], [{"gpuVendor": "AMD", "gpuUuid": selected}],
            [{"gpuVendor": "NVIDIA", "gpuUuid": other}],
            [{"gpuVendor": "NVIDIA", "gpuUuid": other}, {"gpuVendor": "AMD", "gpuUuid": selected}],
        ):
            with (
                self.subTest(inventory=inventory),
                patch.object(native.platform, "system", return_value="Windows"),
                patch.object(native, "run_command", return_value=self._passing_report()),
                patch.object(native, "gpu_inventory", return_value=inventory),
            ):
                self.assertFalse(native.windows_native_desktop_preflight("helper.exe").available)

    def test_unknown_slug_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported_windows_native_workspace"):
            native.profile_for_slug("developer")


if __name__ == "__main__":
    unittest.main()
