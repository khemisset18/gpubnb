from __future__ import annotations

import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gpubnb_agent import windows_native_runtime as runtime
from gpubnb_agent.windows_native_workspace import NativeDesktopPreflight


class WindowsNativeRuntimeTests(unittest.TestCase):
    def _start_report(self, **overrides):
        report = {
            "schemaVersion": 1,
            "sessionId": "sess-1",
            "workspaceSlug": "cloud-desktop",
            "gpuUuid": "GPU-EXACT",
            "helperVersion": "0.2-test",
            "isolatedSession": True,
            "captureReady": True,
            "hardwareEncoder": "nvenc",
            "mediaReady": True,
            "inputIsolation": True,
            "audioReady": True,
            "controllerReady": True,
            "mediaUrl": "http://127.0.0.1:43123/session/sess-1",
        }
        report.update(overrides)
        return SimpleNamespace(returncode=0, stdout=json.dumps(report), stderr="")

    def _stop_report(self, *, stopped=True, session_id="sess-1"):
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"stopped": stopped, "sessionId": session_id}),
            stderr="",
        )

    def _preflight(self, gpu_uuid="GPU-EXACT", audio=True):
        return NativeDesktopPreflight(
            True,
            "ready",
            gpu_uuid,
            "nvenc",
            "0.2-test",
            audio,
        )

    def test_cloud_desktop_launch_binds_exact_gpu_and_runs_preflight_once(self):
        with (
            patch.object(runtime, "find_stream_helper", return_value=r"C:\GPUbnb\helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()) as preflight,
            patch.object(runtime, "discover_native_application", return_value=None),
            patch.object(runtime, "run_command", return_value=self._start_report()) as run_command,
        ):
            handle = runtime.launch_windows_native_workspace(
                "sess-1", "cloud-desktop", "GPU-EXACT"
            )

        self.assertEqual(preflight.call_count, 1)
        self.assertEqual(handle.session_id, "sess-1")
        self.assertEqual(handle.workspace_slug, "cloud-desktop")
        self.assertEqual(handle.gpu_uuid, "GPU-EXACT")
        self.assertTrue(handle.media_url.startswith("http://127.0.0.1:"))
        command = run_command.call_args.args[0]
        self.assertIn("--gpu-uuid", command)
        self.assertIn("GPU-EXACT", command)
        self.assertNotIn("--application", command)

    def test_launch_rejects_different_preflight_gpu_before_start(self):
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight("GPU-OTHER")),
            patch.object(runtime, "run_command") as run_command,
        ):
            with self.assertRaisesRegex(RuntimeError, "native_stream_leased_gpu_mismatch"):
                runtime.launch_windows_native_workspace("sess-1", "cloud-desktop", "GPU-EXACT")
        run_command.assert_not_called()

    def test_launch_rejects_public_media_listener_and_cleans_started_session(self):
        start = self._start_report(mediaUrl="https://203.0.113.7:443/session/sess-1")
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
            patch.object(runtime, "discover_native_application", return_value=None),
            patch.object(runtime, "run_command", side_effect=[start, self._stop_report()]) as run_command,
        ):
            with self.assertRaisesRegex(RuntimeError, "native_workspace_start_loopback_media_required"):
                runtime.launch_windows_native_workspace("sess-1", "cloud-desktop", "GPU-EXACT")
        self.assertEqual(run_command.call_count, 2)
        self.assertEqual(run_command.call_args_list[1].args[0][-2:], ["--session-id", "sess-1"])

    def test_launch_requires_explicit_loopback_media_port(self):
        start = self._start_report(mediaUrl="http://127.0.0.1/session/sess-1")
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
            patch.object(runtime, "discover_native_application", return_value=None),
            patch.object(runtime, "run_command", side_effect=[start, self._stop_report()]),
        ):
            with self.assertRaisesRegex(RuntimeError, "native_workspace_start_loopback_media_required"):
                runtime.launch_windows_native_workspace("sess-1", "cloud-desktop", "GPU-EXACT")

    def test_launch_requires_isolated_session_and_input_boundary(self):
        for field in ("isolatedSession", "captureReady", "mediaReady", "inputIsolation"):
            with self.subTest(field=field):
                with (
                    patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
                    patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
                    patch.object(runtime, "discover_native_application", return_value=None),
                    patch.object(
                        runtime,
                        "run_command",
                        side_effect=[self._start_report(**{field: False}), self._stop_report()],
                    ),
                ):
                    with self.assertRaisesRegex(RuntimeError, field):
                        runtime.launch_windows_native_workspace("sess-1", "cloud-desktop", "GPU-EXACT")

    def test_validation_failure_surfaces_unverified_cleanup(self):
        start = self._start_report(inputIsolation=False)
        failed_stop = SimpleNamespace(returncode=1, stdout="", stderr="failed")
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
            patch.object(runtime, "discover_native_application", return_value=None),
            patch.object(runtime, "run_command", side_effect=[start, failed_stop]),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "native_workspace_start_missing_inputIsolation_cleanup_unverified",
            ):
                runtime.launch_windows_native_workspace("sess-1", "cloud-desktop", "GPU-EXACT")

    def test_creator_launch_passes_discovered_blender_path(self):
        report = self._start_report(workspaceSlug="creator")
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
            patch.object(runtime, "discover_native_application", return_value=r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe"),
            patch.object(runtime, "run_command", return_value=report) as run_command,
        ):
            handle = runtime.launch_windows_native_workspace("sess-1", "creator", "GPU-EXACT")
        self.assertIn("Blender", handle.application_path or "")
        self.assertIn("--application", run_command.call_args.args[0])

    def test_creator_missing_application_is_rejected_before_start(self):
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
            patch.object(runtime, "discover_native_application", return_value=None),
            patch.object(runtime, "run_command") as run_command,
        ):
            with self.assertRaisesRegex(RuntimeError, "creator_application_missing"):
                runtime.launch_windows_native_workspace("sess-1", "creator", "GPU-EXACT")
        run_command.assert_not_called()

    def test_gaming_requires_preflight_audio_before_start(self):
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight(audio=False)),
            patch.object(runtime, "run_command") as run_command,
        ):
            with self.assertRaisesRegex(RuntimeError, "workspace_audio_required"):
                runtime.launch_windows_native_workspace("sess-1", "gaming", "GPU-EXACT")
        run_command.assert_not_called()

    def test_gaming_requires_runtime_audio_and_controller(self):
        for field, error in (
            ("audioReady", "native_workspace_start_audio_required"),
            ("controllerReady", "native_workspace_start_controller_required"),
        ):
            report = self._start_report(workspaceSlug="gaming", **{field: False})
            with self.subTest(field=field):
                with (
                    patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
                    patch.object(runtime, "windows_native_desktop_preflight", return_value=self._preflight()),
                    patch.object(runtime, "discover_native_application", return_value=r"C:\Steam\steam.exe"),
                    patch.object(runtime, "run_command", side_effect=[report, self._stop_report()]),
                ):
                    with self.assertRaisesRegex(RuntimeError, error):
                        runtime.launch_windows_native_workspace("sess-1", "gaming", "GPU-EXACT")

    def test_stop_requires_helper_confirmation_for_exact_session(self):
        with (
            patch.object(runtime, "find_stream_helper", return_value="helper.exe"),
            patch.object(runtime, "run_command", return_value=self._stop_report()) as run_command,
        ):
            runtime.stop_windows_native_workspace("sess-1")
        self.assertEqual(run_command.call_args.args[0][-1], "sess-1")

    def test_session_id_is_restricted_before_helper_execution(self):
        with patch.object(runtime, "run_command") as run_command:
            with self.assertRaisesRegex(RuntimeError, "invalid_native_session_id"):
                runtime.launch_windows_native_workspace("../provider", "cloud-desktop", "GPU-EXACT", helper_path="helper.exe")
        run_command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
