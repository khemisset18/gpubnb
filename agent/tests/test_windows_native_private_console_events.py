from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from gpubnb_agent import windows_native_private_console as policy
from gpubnb_agent import workspace_gateway_v10 as gateway


SHA = "f664a07ec500c57bf9a508838f51b7c0305ba92d"


class WindowsSessionChangeFenceTests(unittest.TestCase):
    def test_console_authority_is_revoked_and_cannot_rearm_on_unlock(self):
        session = {
            "runtimeBackend": "WINDOWS_NATIVE",
            "workspaceSlug": "cloud-desktop",
            "captureBackend": "console-dedicated",
            "consoleAgentCommit": SHA,
        }
        with patch.object(policy, "_SESSION_CHANGE_FENCE", threading.Event()):
            self.assertEqual(
                policy.selected_capture_backend(session, local_opt_in=True, build_commit=SHA),
                "console-dedicated",
            )
            policy.fence_console_on_session_change()
            with self.assertRaisesRegex(RuntimeError, "native_console_session_change_fenced"):
                policy.selected_capture_backend(session, local_opt_in=True, build_commit=SHA)
            self.assertTrue(policy.console_session_change_fenced())

    def test_legacy_iddcx_does_not_switch_to_console_after_wts_transition(self):
        with patch.object(policy, "_SESSION_CHANGE_FENCE", threading.Event()):
            policy.fence_console_on_session_change()
            self.assertEqual(policy.selected_capture_backend(
                {"runtimeBackend": "WINDOWS_NATIVE", "workspaceSlug": "cloud-desktop"},
                local_opt_in=True, build_commit=SHA,
            ), "iddcx")

    def test_gateway_fails_closed_before_opening_loopback_media(self):
        supervisor = object.__new__(gateway.GatewaySupervisor)
        supervisor._native_lock = threading.RLock()
        supervisor._native_blocked = set()
        supervisor.native_runtimes = {
            "sess-1": SimpleNamespace(handle=SimpleNamespace(capture_backend="console-dedicated"))
        }
        with patch.object(gateway, "console_session_change_fenced", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "native_console_session_change_fenced"):
                supervisor._native_runtime("sess-1")

    def test_usage_reports_stop_and_does_not_count_fenced_console_time(self):
        supervisor = object.__new__(gateway.GatewaySupervisor)
        supervisor._report_error = Mock()
        supervisor._native_stop_and_report = Mock(return_value=True)
        record = SimpleNamespace(
            session_id="sess-1", handle=SimpleNamespace(capture_backend="console-dedicated")
        )
        with patch.object(gateway, "console_session_change_fenced", return_value=True):
            supervisor._report_native_usage(record)
        supervisor._native_stop_and_report.assert_called_once_with("sess-1")
        supervisor._report_error.assert_called_once()
