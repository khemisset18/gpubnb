from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from gpubnb_agent.windows_native_workspace import NativeDesktopPreflight


TOOL_PATH = Path(__file__).resolve().parents[1] / "tools" / "windows_native_qualify.py"
SPEC = importlib.util.spec_from_file_location("windows_native_qualify_tool", TOOL_PATH)
assert SPEC is not None and SPEC.loader is not None
qualify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualify)


class WindowsNativeQualifyToolTests(unittest.TestCase):
    def test_report_runs_expensive_preflight_once_and_never_leaks_app_paths(self):
        apps = {
            "cloud-desktop": None,
            "creator": r"C:\Users\Provider\Apps\blender.exe",
            "cad": r"C:\Users\Provider\Apps\FreeCAD.exe",
            "gaming": r"C:\Users\Provider\Apps\steam.exe",
        }
        with (
            patch.object(qualify, "find_stream_helper", return_value=r"C:\Program Files\GPUbnb\helper.exe"),
            patch.object(
                qualify,
                "windows_native_desktop_preflight",
                return_value=NativeDesktopPreflight(
                    True, "ready", "GPU-EXACT", "nvenc", "0.2", True
                ),
            ) as preflight,
            patch.object(qualify, "discover_native_application", side_effect=lambda slug: apps[slug]),
            patch.object(qualify.platform, "system", return_value="Windows"),
        ):
            report = qualify.build_report()

        self.assertEqual(preflight.call_count, 1)
        self.assertTrue(report["qualified"])
        self.assertTrue(report["nativeDesktopStreamingAvailable"])
        self.assertTrue(report["workspaces"]["gaming"]["runtimeControllerProofRequired"])
        encoded = json.dumps(report)
        self.assertNotIn("Provider", encoded)
        self.assertNotIn("blender.exe", encoded)
        self.assertNotIn("FreeCAD.exe", encoded)
        self.assertNotIn("steam.exe", encoded)

    def test_failed_stream_preflight_keeps_every_selected_workspace_unqualified(self):
        with (
            patch.object(qualify, "find_stream_helper", return_value=None),
            patch.object(
                qualify,
                "windows_native_desktop_preflight",
                return_value=NativeDesktopPreflight(False, "native_stream_helper_missing"),
            ),
            patch.object(qualify, "discover_native_application", return_value=None),
        ):
            report = qualify.build_report("cloud-desktop")

        self.assertFalse(report["qualified"])
        self.assertFalse(report["nativeDesktopStreamingAvailable"])
        self.assertEqual(
            report["workspaces"]["cloud-desktop"]["reason"],
            "native_stream_helper_missing",
        )

    def test_creator_requires_application_even_after_stream_preflight(self):
        with (
            patch.object(qualify, "find_stream_helper", return_value="helper.exe"),
            patch.object(
                qualify,
                "windows_native_desktop_preflight",
                return_value=NativeDesktopPreflight(
                    True, "ready", "GPU-EXACT", "nvenc", "0.2", True
                ),
            ),
            patch.object(qualify, "discover_native_application", return_value=None),
        ):
            report = qualify.build_report("creator")

        self.assertFalse(report["qualified"])
        self.assertEqual(report["workspaces"]["creator"]["reason"], "creator_application_missing")

    def test_require_ready_returns_two_for_unqualified_report(self):
        with patch.object(
            qualify,
            "build_report",
            return_value={"schemaVersion": 1, "qualified": False},
        ):
            with patch("builtins.print"):
                self.assertEqual(qualify.main(["--require-ready"]), 2)


if __name__ == "__main__":
    unittest.main()
