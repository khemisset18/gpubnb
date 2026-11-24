from __future__ import annotations

import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from gpubnb_agent import workspace_gateway_v10 as gateway


def session(**changes):
    s = {
        "id": "sess-1",
        "runtimeBackend": "WINDOWS_NATIVE",
        "workspaceSlug": "gaming",
        "status": "READY",
        "expiresAt": "2099-01-01T00:00:00Z",
        "connectionMetadata": {},
    }
    s.update(changes)
    return s


def supervisor_for(*, desired):
    obj = object.__new__(gateway.GatewaySupervisor)
    obj._native_lock = threading.RLock()
    obj._native_desired_sessions = [desired]
    obj.native_runtimes = {}
    obj._native_blocked = set()
    obj._native_start_tokens = {}
    obj._native_start_backends = {}
    obj._native_revocation_pending = set()
    obj._native_revocation_inflight = set()
    obj.start_retry_at = {}
    obj.start_failures = {}
    obj._report_error = Mock()
    obj._native_stop_and_report = Mock(return_value=True)
    obj._start_native_runtime = Mock(
        return_value=SimpleNamespace(
            session_id="sess-1",
            handle=SimpleNamespace(capture_backend="console-dedicated"),
        )
    )
    obj._native_register_if_needed = Mock()
    obj._report_native_usage = Mock()
    obj._expired = Mock(return_value=False)
    return obj


class ConsoleGatewayTests(unittest.TestCase):
    def test_server_selected_console_passes_explicit_opt_in_to_launch(self):
        obj = supervisor_for(desired=session(
            captureBackend="console-dedicated",
            consoleAgentCommit="f664a07ec500c57bf9a508838f51b7c0305ba92d",
        ))
        with (
            patch.dict(os.environ, {
                "GPUBNB_WINDOWS_NATIVE_EXTENDED_LOCAL_OPT_IN": "true",
                "GPUBNB_PRIVATE_CONSOLE_QUALIFICATION": "true",
            }),
            patch.object(gateway, "selected_capture_backend", return_value="console-dedicated"),
        ):
            obj._reconcile_native_sessions()
        obj._start_native_runtime.assert_called_once_with(
            "sess-1", "gaming", private_console_qualification=True,
        )

    def test_bad_authority_is_not_started(self):
        obj = supervisor_for(desired=session(captureBackend="console-authorization-invalid"))
        with patch.object(
            gateway, "selected_capture_backend",
            side_effect=RuntimeError("native_capture_backend_unsupported"),
        ):
            obj._reconcile_native_sessions()
        obj._start_native_runtime.assert_not_called()
        self.assertEqual(len(obj._report_error.call_args_list), 1)

    def test_local_consent_revocation_stops_only_gaming_runtime_and_start(self):
        obj = object.__new__(gateway.GatewaySupervisor)
        obj._native_lock = threading.RLock()
        obj.native_runtimes = {
            "gaming-active": SimpleNamespace(workspace_slug="gaming"),
            "desktop-active": SimpleNamespace(workspace_slug="cloud-desktop"),
        }
        obj._native_start_workspaces = {
            "gaming-starting": "gaming",
            "creator-starting": "creator",
        }
        obj._native_start_tokens = {
            "gaming-starting": object(),
            "creator-starting": object(),
        }
        obj._native_start_backends = {
            "gaming-starting": gateway.CONSOLE_BACKEND,
            "creator-starting": "iddcx",
        }
        obj._native_blocked = set()
        obj._private_gaming_revocation_retry_at = {}
        obj._close_session_channels = Mock()
        obj._native_stop_and_report = Mock(return_value=True)
        obj._report_error = Mock()

        with patch.object(gateway, "private_gaming_workspace_local_opt_in_enabled", return_value=False):
            obj._revoke_private_gaming_sessions_if_disabled()

        self.assertCountEqual(
            obj._native_stop_and_report.call_args_list,
            [
                call("gaming-active", local_consent_revocation=True),
                call("gaming-starting", local_consent_revocation=True),
            ],
        )
        self.assertEqual(obj._native_blocked, {"gaming-active", "gaming-starting"})
        self.assertCountEqual(
            obj._close_session_channels.call_args_list,
            [call("gaming-active"), call("gaming-starting")],
        )
        self.assertIn("desktop-active", obj.native_runtimes)
        self.assertIn("creator-starting", obj._native_start_workspaces)

    def test_local_consent_revocation_stops_capture_before_server_request(self):
        obj = object.__new__(gateway.GatewaySupervisor)
        obj._native_lock = threading.RLock()
        obj.native_runtimes = {
            "gaming-active": SimpleNamespace(handle=SimpleNamespace(capture_backend=gateway.CONSOLE_BACKEND)),
        }
        obj._native_blocked = set()
        obj._native_start_tokens = {}
        obj._native_start_backends = {}
        obj._native_start_workspaces = {}
        obj._close_session_channels = Mock()
        obj.usage_last_report = {"gaming-active": 1.0}
        events: list[str] = []
        obj._announce_native_revocation_started = Mock(side_effect=lambda _: events.append("server-revoke"))
        obj._release_native_claims = Mock(return_value=True)
        obj._trace = Mock()

        def stop_local(session_id: str) -> None:
            self.assertEqual(session_id, "gaming-active")
            events.append("local-stop")

        with patch.object(gateway, "stop_windows_native_workspace", side_effect=stop_local):
            cleaned = obj._stop_native_runtime(
                "gaming-active",
                local_consent_revocation=True,
            )

        self.assertTrue(cleaned)
        self.assertEqual(events, ["local-stop", "server-revoke"])
        self.assertNotIn("gaming-active", obj.native_runtimes)

    def test_source_change_revokes_active_console_instead_of_switching_in_place(self):
        obj = supervisor_for(desired=session())  # legacy server no longer grants console
        obj.native_runtimes["sess-1"] = SimpleNamespace(
            handle=SimpleNamespace(capture_backend="console-dedicated")
        )
        with patch.object(gateway, "selected_capture_backend", return_value="iddcx"):
            obj._reconcile_native_sessions()
        obj._native_stop_and_report.assert_called_once_with("sess-1")
        obj._start_native_runtime.assert_not_called()
        obj._report_native_usage.assert_not_called()
