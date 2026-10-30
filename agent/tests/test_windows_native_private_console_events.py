from __future__ import annotations

import threading
import weakref
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

    def test_wts_event_wakes_guardians_without_rearming(self):
        with (
            patch.object(policy, "_SESSION_CHANGE_FENCE", threading.Event()),
            patch.object(policy, "_FENCE_WAKEUPS", weakref.WeakSet()),
        ):
            first = threading.Event()
            second = threading.Event()
            policy.register_console_fence_wakeup(first)
            self.assertFalse(first.is_set())
            policy.fence_console_on_session_change()
            self.assertTrue(first.is_set())
            policy.register_console_fence_wakeup(second)
            self.assertTrue(second.is_set())
            self.assertTrue(policy.console_session_change_fenced())

    def test_wts_guardian_closes_channels_and_reports_physical_stop(self):
        obj = object.__new__(gateway.GatewaySupervisor)
        obj._native_lock = threading.RLock()
        obj._native_blocked = set()
        obj._console_fence_wakeup = threading.Event()
        obj._console_fence_wakeup.set()
        obj.stop_event = threading.Event()
        obj.native_runtimes = {
            "console": SimpleNamespace(handle=SimpleNamespace(capture_backend="console-dedicated")),
            "iddcx": SimpleNamespace(handle=SimpleNamespace(capture_backend="iddcx")),
        }
        obj._close_session_channels = Mock()
        obj._native_stop_and_report = Mock(return_value=True)
        obj._report_error = Mock()
        obj._watch_console_session_fence()
        self.assertIn("console", obj._native_blocked)
        self.assertNotIn("iddcx", obj._native_blocked)
        obj._close_session_channels.assert_called_once_with("console")
        obj._native_stop_and_report.assert_called_once_with("console")

    def test_buffered_native_frame_is_dropped_after_wts_transition(self):
        obj = object.__new__(gateway.GatewaySupervisor)
        obj._native_lock = threading.RLock()
        obj._native_blocked = set()
        obj.native_runtimes = {
            "console": SimpleNamespace(handle=SimpleNamespace(capture_backend="console-dedicated"))
        }
        obj._native_channel_sessions = {"channel": "console"}
        obj.stop_event = threading.Event()
        obj.channels = {"channel": Mock()}
        obj.session_channels = {"console": {"channel"}}
        obj.machine_id = "machine-1"
        obj._request = Mock()
        obj._report_error = Mock()
        obj._begin_reconnect_grace = Mock()
        sock = Mock()
        def receive():
            policy.fence_console_on_session_change()
            return gateway.websocket.ABNF.OPCODE_BINARY, b"BUFFERED_PROVIDER_FRAME"
        sock.recv_data.side_effect = receive
        with (
            patch.object(policy, "_SESSION_CHANGE_FENCE", threading.Event()),
            patch.object(policy, "_FENCE_WAKEUPS", weakref.WeakSet()),
        ):
            obj._ws_reader("console", "channel", sock)
        calls = obj._request.call_args_list
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[2].get("close"), True)
        self.assertNotIn("dataBase64", calls[0].args[2])
        self.assertNotIn("channel", obj.channels)
        obj._begin_reconnect_grace.assert_not_called()
        sock.close.assert_called_once()

    def test_fenced_browser_input_is_never_forwarded_to_loopback(self):
        obj = object.__new__(gateway.GatewaySupervisor)
        obj._native_lock = threading.RLock()
        obj._native_blocked = set()
        obj.native_runtimes = {
            "console": SimpleNamespace(handle=SimpleNamespace(capture_backend="console-dedicated"))
        }
        obj._native_channel_sessions = {"channel": "console"}
        obj._close_session_channels = Mock()
        # Deliberately lie about sessionId: only the previously authorized
        # channel mapping is allowed to control the actual console fence.
        item = {
            "kind": "ws_send", "channelId": "channel", "sessionId": "another-session",
            "dataBase64": "AAECAw==", "binary": True,
        }
        with patch.object(gateway, "console_session_change_fenced", return_value=True):
            obj._handle(item)
        obj._close_session_channels.assert_called_once_with("console")

    def test_racing_loopback_connect_does_not_register_fenced_channel(self):
        obj = object.__new__(gateway.GatewaySupervisor)
        obj._native_lock = threading.RLock()
        obj._native_blocked = set()
        obj.native_runtimes = {
            "console": SimpleNamespace(handle=SimpleNamespace(capture_backend="console-dedicated"))
        }
        obj._native_channel_sessions = {}
        obj.channels = {}
        obj.session_channels = {}
        obj._reconnect_is_paused = Mock(return_value=False)
        obj._native_runtime = Mock(return_value=obj.native_runtimes["console"])
        obj._trace = Mock()
        obj._reject_open = Mock()
        sock = Mock()
        with (
            patch.object(gateway, "_connect_native_websocket", return_value=sock),
            patch.object(gateway, "console_session_change_fenced", return_value=True),
        ):
            obj._ws_open({
                "kind": "ws_open", "sessionId": "console",
                "channelId": "channel", "path": "/native-stream", "id": "open-1",
            })
        obj._reject_open.assert_called_once()
        self.assertFalse(obj.channels)
        self.assertFalse(obj._native_channel_sessions)
        sock.close.assert_called_once()
