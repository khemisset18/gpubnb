"""No services/sockets: execute the real Agent admission with controlled handshakes."""
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


if __name__ == "__main__":
    unittest.main()
