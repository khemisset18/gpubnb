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
