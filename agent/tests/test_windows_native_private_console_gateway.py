from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from gpubnb_agent import workspace_gateway_v10 as gateway


def session(**changes):
    s = {
        "id": "sess-1",
        "runtimeBackend": "WINDOWS_NATIVE",
        "workspaceSlug": "cloud-desktop",
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
        with patch.object(gateway, "selected_capture_backend", return_value="console-dedicated"):
            obj._reconcile_native_sessions()
        obj._start_native_runtime.assert_called_once_with(
            "sess-1", "cloud-desktop", private_console_qualification=True,
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
