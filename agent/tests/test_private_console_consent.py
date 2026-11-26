from __future__ import annotations

import json
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from gpubnb_agent.private_console_consent import (
    consent_path,
    private_console_local_opt_in_enabled,
    private_console_environment_opt_in_enabled,
    private_console_proof_scope,
    private_gaming_consent_status,
    private_gaming_workspace_local_opt_in_enabled,
    read_private_gaming_consent,
    set_private_gaming_consent,
)


class PrivateGamingConsentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="gpubnb-gaming-consent-")
        self.environment = patch.dict(os.environ, {
            "GPUBNB_CONFIG_DIR": self.directory.name,
        }, clear=False)
        self.environment.start()
        os.environ.pop("GPUBNB_PRIVATE_CONSOLE_QUALIFICATION", None)
        os.environ.pop("GPUBNB_WINDOWS_NATIVE_EXTENDED_LOCAL_OPT_IN", None)

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_missing_or_malformed_consent_fails_closed(self):
        self.assertEqual(read_private_gaming_consent(), {"enabled": False, "consentedAt": None})
        consent_path().write_text("{broken", encoding="utf-8")
        self.assertFalse(private_console_local_opt_in_enabled())
        consent_path().write_text(json.dumps({
            "schemaVersion": 1,
            "workspaceSlug": "creator",
            "enabled": True,
            "consentedAt": "2026-11-23T00:00:00Z",
        }), encoding="utf-8")
        self.assertFalse(private_console_local_opt_in_enabled())

    def test_enable_requires_confirmation_and_persists_a_gaming_only_decision(self):
        with self.assertRaisesRegex(RuntimeError, "private_gaming_owner_consent_required"):
            set_private_gaming_consent(True)
        self.assertFalse(consent_path().exists())

        result = set_private_gaming_consent(True, confirmed=True)
        self.assertTrue(result["enabled"])
        self.assertTrue(result["consentedAt"].endswith("Z"))
        self.assertEqual(read_private_gaming_consent(), result)
        self.assertTrue(private_console_local_opt_in_enabled())

    def test_explicit_environment_deny_overrides_saved_consent(self):
        set_private_gaming_consent(True, confirmed=True)
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "false"}):
            self.assertFalse(private_console_local_opt_in_enabled())
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true"}):
            self.assertTrue(private_console_local_opt_in_enabled())

    def test_signed_heartbeat_proof_scope_is_separate_for_gaming_and_legacy_desktop(self):
        self.assertIsNone(private_console_proof_scope())
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true"}):
            self.assertEqual(private_console_proof_scope(), {"schemaVersion": 1})
            self.assertTrue(private_console_environment_opt_in_enabled())

            set_private_gaming_consent(True, confirmed=True)
            self.assertEqual(private_console_proof_scope(), {
                "schemaVersion": 2,
                "workspaceSlug": "gaming",
            })
            self.assertFalse(private_console_environment_opt_in_enabled())

            set_private_gaming_consent(False)
            self.assertIsNone(private_console_proof_scope())
            self.assertFalse(private_console_environment_opt_in_enabled())

    def test_legacy_opt_in_never_authorizes_gaming_or_reports_owner_consent(self):
        from gpubnb_agent.windows_native_private_console import selected_capture_backend
        from gpubnb_agent.workspace_gateway_v10 import windows_native_active_workspace_slugs

        commit = "f664a07ec500c57bf9a508838f51b7c0305ba92d"
        gaming = {
            "runtimeBackend": "WINDOWS_NATIVE",
            "workspaceSlug": "gaming",
            "captureBackend": "console-dedicated",
            "consoleAgentCommit": commit,
        }
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true"}):
            self.assertTrue(private_console_local_opt_in_enabled())
            self.assertFalse(private_gaming_workspace_local_opt_in_enabled())
            self.assertFalse(private_gaming_consent_status()["enabled"])
            self.assertNotIn("gaming", windows_native_active_workspace_slugs())
            with self.assertRaisesRegex(RuntimeError, "native_console_local_opt_in_required"):
                selected_capture_backend(gaming, build_commit=commit)

            set_private_gaming_consent(True, confirmed=True)
            self.assertTrue(private_gaming_workspace_local_opt_in_enabled())
            self.assertTrue(private_gaming_consent_status()["enabled"])
            self.assertIn("gaming", windows_native_active_workspace_slugs())
            self.assertEqual(selected_capture_backend(gaming, build_commit=commit), "console-dedicated")

    def test_environment_deny_rejects_enable_without_persisting_permission(self):
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "false"}):
            with self.assertRaisesRegex(RuntimeError, "private_gaming_environment_blocked"):
                set_private_gaming_consent(True, confirmed=True)
            self.assertFalse(consent_path().exists())
            self.assertFalse(private_gaming_consent_status()["enabled"])
            self.assertTrue(private_gaming_consent_status()["environmentBlocked"])
            self.assertFalse(set_private_gaming_consent(False)["enabled"])
        self.assertFalse(private_gaming_workspace_local_opt_in_enabled())

    def test_disable_persists_revocation_and_disables_local_console_authority(self):
        set_private_gaming_consent(True, confirmed=True)
        result = set_private_gaming_consent(False)
        self.assertFalse(result["enabled"])
        self.assertIsNone(result["consentedAt"])
        self.assertTrue(consent_path().exists())
        self.assertFalse(read_private_gaming_consent()["enabled"])
        self.assertFalse(private_console_local_opt_in_enabled())
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true"}):
            self.assertFalse(private_console_local_opt_in_enabled())

    def test_workspace_activation_is_gaming_only(self):
        from gpubnb_agent.workspace_gateway_v10 import windows_native_active_workspace_slugs

        with patch.dict(os.environ, {"GPUBNB_WINDOWS_NATIVE_EXTENDED_LOCAL_OPT_IN": "true"}):
            extended = windows_native_active_workspace_slugs()
        self.assertIn("creator", extended)
        self.assertIn("cad", extended)
        self.assertNotIn("gaming", extended)

        with patch.dict(os.environ, {"GPUBNB_WINDOWS_NATIVE_EXTENDED_LOCAL_OPT_IN": "false"}):
            self.assertNotIn("gaming", windows_native_active_workspace_slugs())
            set_private_gaming_consent(True, confirmed=True)
            active = windows_native_active_workspace_slugs()
        self.assertIn("gaming", active)
        self.assertNotIn("creator", active)
        self.assertNotIn("cad", active)

    def test_saved_gaming_consent_does_not_authorize_cloud_desktop_console(self):
        from gpubnb_agent.windows_native_private_console import selected_capture_backend

        commit = "f664a07ec500c57bf9a508838f51b7c0305ba92d"
        gaming_session = {
            "runtimeBackend": "WINDOWS_NATIVE",
            "workspaceSlug": "gaming",
            "captureBackend": "console-dedicated",
            "consoleAgentCommit": commit,
        }
        desktop_session = {**gaming_session, "workspaceSlug": "cloud-desktop"}
        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true"}):
            self.assertEqual(
                selected_capture_backend(desktop_session, build_commit=commit),
                "console-dedicated",
            )
        set_private_gaming_consent(True, confirmed=True)

        self.assertEqual(
            selected_capture_backend(gaming_session, build_commit=commit),
            "console-dedicated",
        )
        with self.assertRaisesRegex(RuntimeError, "native_console_local_opt_in_required"):
            selected_capture_backend(desktop_session, build_commit=commit)

        with patch.dict(os.environ, {"GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true"}):
            with self.assertRaisesRegex(RuntimeError, "native_console_local_opt_in_required"):
                selected_capture_backend(desktop_session, build_commit=commit)

    def test_installation_inventory_is_read_only_and_ignores_dev_helper(self):
        from pathlib import Path
        from gpubnb_agent import windows_native_workspace as workspace

        root = Path(self.directory.name)
        helper = root / "gpubnb-windows-stream.exe"
        with patch.object(workspace.platform, "system", return_value="Windows"), \
             patch.object(workspace.platform, "machine", return_value="AMD64"), \
             patch.object(workspace, "WINDOWS_STREAM_HELPER_INSTALL_PATH", str(helper)), \
             patch.object(workspace, "discover_native_application", return_value=None), \
             patch.object(workspace, "run_command", side_effect=AssertionError("no executable")):
            with patch.dict(os.environ, {
                workspace.WINDOWS_STREAM_HELPER_DEV_ALLOW_ENV: "1",
                workspace.WINDOWS_STREAM_HELPER_DEV_PATH_ENV: str(root / "dev.exe"),
            }):
                (root / "dev.exe").write_bytes(b"not an executable")
                result = workspace.private_gaming_installation_inventory()
                self.assertTrue(result["supportedPlatform"])
                self.assertFalse(result["streamHelperPresent"])
                self.assertFalse(result["steamPresent"])
                helper.write_bytes(b"presence only")
                (root / "gpubnb-windows-worker.exe").write_bytes(b"presence only")
                result = workspace.private_gaming_installation_inventory()
                self.assertTrue(result["streamHelperPresent"])
                self.assertTrue(result["workerPresent"])
                self.assertFalse(result["mediaLibraryPresent"])
                self.assertFalse(consent_path().exists())
                self.assertIsNone(private_console_proof_scope())

    def test_installation_inventory_unsupported_platform_does_not_discover_steam(self):
        from gpubnb_agent import windows_native_workspace as workspace

        for system, machine in [("Linux", "x86_64"), ("Windows", "ARM64")]:
            with patch.object(workspace.platform, "system", return_value=system), \
                 patch.object(workspace.platform, "machine", return_value=machine), \
                 patch.object(workspace, "discover_native_application", side_effect=AssertionError("no discovery")):
                self.assertTrue(all(value is False for value in workspace.private_gaming_installation_inventory().values()))

    def test_cli_status_includes_inventory_without_mutating_consent(self):
        from gpubnb_agent.cli import parser
        from gpubnb_agent import windows_native_workspace as workspace

        command = parser().parse_args(["private-gaming-consent", "status"])
        inventory = {
            "supportedPlatform": True, "streamHelperPresent": True,
            "workerPresent": True, "mediaLibraryPresent": True,
            "steamPresent": False,
        }
        output = io.StringIO()
        with patch.object(workspace, "private_gaming_installation_inventory", return_value=inventory), redirect_stdout(output):
            self.assertEqual(command.handler(command), 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report["installationInventory"], inventory)
        self.assertFalse(report["enabled"])
        self.assertFalse(consent_path().exists())

    def test_cli_requires_owner_confirmation_to_enable(self):
        from gpubnb_agent.cli import parser

        command = parser().parse_args(["private-gaming-consent", "enable"])
        with self.assertRaisesRegex(RuntimeError, "private_gaming_owner_consent_required"):
            command.handler(command)

        command = parser().parse_args([
            "private-gaming-consent", "enable", "--confirmed",
        ])
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(command.handler(command), 0)
        self.assertTrue(json.loads(output.getvalue())["enabled"])


if __name__ == "__main__":
    unittest.main()
