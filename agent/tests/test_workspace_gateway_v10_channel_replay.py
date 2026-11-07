"""No services/sockets: execute the real Agent admission with controlled handshakes."""
import base64
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from test_workspace_gateway_v10_reconnect_race import make_supervisor, native_runtime, SESSION
from gpubnb_agent import workspace_gateway_v10 as gateway


class NativeChannelReplayTests(unittest.TestCase):
    def prepared(self):
        obj = make_supervisor()
        obj.native_runtimes[SESSION] = native_runtime()
        obj._console_channel_fenced = MagicMock(return_value=False)
        obj._reconnect_is_paused = MagicMock(return_value=False)
        obj._reject_open = MagicMock()
        obj._trace = MagicMock()
        return obj

    def item(self):
        return {"id": "request", "sessionId": SESSION,
                "channelId": "never-reuse", "path": "/native-stream"}

    def test_failed_handshake_consumes_authorization(self):
        obj = self.prepared()
        with patch.object(gateway, "_connect_native_websocket", side_effect=OSError("network lost")) as connect:
            obj._ws_open(self.item())
            obj._ws_open(self.item())
        self.assertEqual(connect.call_count, 1)
        self.assertEqual(obj._native_channel_sessions["never-reuse"], SESSION)
        self.assertEqual(obj._reject_open.call_args.args[1], "windows_native_channel_authorization_consumed")

    def test_closed_channel_cannot_reopen_or_fall_back_after_stop(self):
        for removed in (False, True):
            obj = self.prepared()
            obj._native_channel_sessions["never-reuse"] = SESSION
            if removed:
                obj.native_runtimes.clear()
            with patch.object(gateway, "_connect_native_websocket") as connect:
                obj._ws_open(self.item())
            connect.assert_not_called()
            obj._reject_open.assert_called_once()

    def test_runtime_replacement_during_handshake_is_rejected(self):
        obj = self.prepared()
        ws = MagicMock()
        def connect(_runtime):
            obj.native_runtimes[SESSION] = native_runtime()
            return ws
        with patch.object(gateway, "_connect_native_websocket", side_effect=connect):
            obj._ws_open(self.item())
        ws.close.assert_called_once()
        self.assertNotIn("never-reuse", obj.channels)
        self.assertIn("never-reuse", obj._native_channel_sessions)

    def test_fresh_channel_can_open_once(self):
        obj = self.prepared()
        ws = MagicMock()
        with patch.object(gateway, "_connect_native_websocket", return_value=ws), patch.object(gateway.threading, "Thread"):
            obj._ws_open(self.item())
        self.assertIs(obj.channels["never-reuse"], ws)
        obj._reject_open.assert_not_called()

    def test_delayed_distinct_open_after_successful_stop_cannot_fall_back(self):
        obj = self.prepared()
        obj._close_session_channels = MagicMock()
        obj._release_native_claims = MagicMock(return_value=True)
        delayed = {**self.item(), "channelId": "different-delayed-channel"}
        with patch.object(gateway, "stop_windows_native_workspace", return_value=None), \
                patch.object(gateway, "_connect_native_websocket") as connect:
            self.assertTrue(obj._stop_native_runtime(SESSION))
            self.assertNotIn(SESSION, obj.native_runtimes)
            self.assertIn(SESSION, obj._native_blocked)
            obj._ws_open(delayed)
        connect.assert_not_called()
        obj._reject_open.assert_called_once_with(delayed, "windows_native_channel_authorization_consumed")

    def test_stop_publishes_api_revocation_before_slow_helper_cleanup(self):
        obj = self.prepared()
        events = []
        obj._close_session_channels = MagicMock(side_effect=lambda _session: events.append("channels-closed"))
        obj._request = MagicMock(side_effect=lambda *args: events.append("api-revoked") or {"ok": True, "revoked": True})
        obj._release_native_claims = MagicMock(return_value=True)
        def stop_helper(_session):
            events.append("helper-stopped")
        with patch.object(gateway, "stop_windows_native_workspace", side_effect=stop_helper):
            self.assertTrue(obj._stop_native_runtime(SESSION))
        self.assertLess(events.index("channels-closed"), events.index("api-revoked"))
        self.assertLess(events.index("api-revoked"), events.index("helper-stopped"))
        self.assertEqual(obj._request.call_args.args[0], f"/agent/workspace-gateway/{SESSION}/revocation-started")

    def test_native_path_after_agent_restart_cannot_fall_back_to_legacy(self):
        obj = self.prepared()
        obj.native_runtimes.clear()
        obj._native_blocked.clear()
        item = self.item()
        with patch.object(gateway.reconnect.GatewaySupervisor, "_ws_open") as fallback:
            obj._ws_open(item)
        fallback.assert_not_called()
        obj._reject_open.assert_called_once_with(item, "windows_native_runtime_not_ready")

    def test_browser_input_send_serializes_with_stop_tombstone(self):
        obj = self.prepared()
        channel_id = "active-channel"
        started = threading.Event()
        release = threading.Event()
        stopped = threading.Event()

        class BlockingSocket:
            def send_binary(self, payload):
                self.payload = payload
                started.set()
                if not release.wait(2):
                    raise TimeoutError("test input send barrier timed out")

            def close(self):
                pass

        socket = BlockingSocket()
        obj.channels[channel_id] = socket
        obj.session_channels[SESSION] = {channel_id}
        obj._native_channel_sessions[channel_id] = SESSION
        obj._close_session_channels = MagicMock()
        obj._release_native_claims = MagicMock(return_value=True)
        item = {
            "kind": "ws_send", "sessionId": SESSION, "channelId": channel_id,
            "binary": True, "dataBase64": base64.b64encode(b"input").decode("ascii"),
        }
        with patch.object(gateway, "stop_windows_native_workspace", return_value=None):
            sender = threading.Thread(target=obj._handle, args=(item,))
            sender.start()
            self.assertTrue(started.wait(2), "input send must reach its barrier")

            def stop():
                obj._stop_native_runtime(SESSION)
                stopped.set()

            stopper = threading.Thread(target=stop)
            stopper.start()
            time.sleep(0.03)
            self.assertFalse(stopped.is_set(), "STOP must wait for the admitted local send commit")
            self.assertNotIn(SESSION, obj._native_blocked)
            release.set()
            sender.join(2)
            stopper.join(2)
        self.assertFalse(sender.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertEqual(socket.payload, b"input")
        self.assertTrue(stopped.is_set())
        self.assertIn(SESSION, obj._native_blocked)

    def test_browser_input_is_refused_after_stop_tombstone(self):
        obj = self.prepared()
        obj._console_channel_fenced = MagicMock(side_effect=lambda _session: SESSION in obj._native_blocked)
        channel_id = "active-channel"
        socket = MagicMock()
        obj.channels[channel_id] = socket
        obj.session_channels[SESSION] = {channel_id}
        obj._native_channel_sessions[channel_id] = SESSION
        obj._close_session_channels = MagicMock()
        obj._release_native_claims = MagicMock(return_value=True)
        item = {
            "kind": "ws_send", "sessionId": SESSION, "channelId": channel_id,
            "binary": True, "dataBase64": base64.b64encode(b"stale").decode("ascii"),
        }
        with patch.object(gateway, "stop_windows_native_workspace", return_value=None):
            self.assertTrue(obj._stop_native_runtime(SESSION))
            obj._handle(item)
        socket.send_binary.assert_not_called()

    def test_start_completed_after_stop_cannot_publish_a_runtime(self):
        obj = self.prepared()
        token = object()
        obj._native_start_tokens[SESSION] = token
        obj._native_start_backends[SESSION] = gateway.CONSOLE_BACKEND
        entered = threading.Event()
        release = threading.Event()
        published = []

        def delayed_publish():
            entered.set()
            if not release.wait(2):
                raise TimeoutError("test native-start barrier timed out")
            published.append(obj._publish_native_runtime_if_current(SESSION, token, native_runtime()))

        with patch.object(gateway, "stop_windows_native_workspace", return_value=None):
            start = threading.Thread(target=delayed_publish)
            start.start()
            self.assertTrue(entered.wait(2), "start must reach its final publication barrier")
            self.assertTrue(obj._stop_native_runtime(SESSION))
            release.set()
            start.join(2)

        self.assertFalse(start.is_alive())
        self.assertEqual(published, [False])
        self.assertNotIn(SESSION, obj.native_runtimes)
        self.assertIn(SESSION, obj._native_blocked)

    def test_console_start_rechecks_wts_after_start_token_publication(self):
        obj = self.prepared()
        token = object()
        obj._native_start_tokens[SESSION] = token
        obj._native_start_backends[SESSION] = gateway.CONSOLE_BACKEND
        obj._native_stop_and_report = MagicMock(return_value=True)
        with patch.object(gateway, "console_session_change_fenced", return_value=True):
            self.assertFalse(obj._native_start_token_is_current(SESSION, token))
        obj._native_stop_and_report.assert_called_once_with(SESSION)


if __name__ == "__main__":
    unittest.main()
