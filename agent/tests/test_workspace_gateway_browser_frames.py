from __future__ import annotations

import base64
import hashlib
import unittest

import websocket

from gpubnb_agent.workspace_gateway_v3 import GatewaySupervisor


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[tuple[str, object, int | None]] = []
        self.closed = False

    def send_binary(self, data: bytes) -> None:
        self.sent.append(("binary", data, websocket.ABNF.OPCODE_BINARY))

    def send(self, data: object, opcode: int | None = None) -> None:
        self.sent.append(("send", data, opcode))

    def close(self) -> None:
        self.closed = True


def _supervisor(ws: _FakeWebSocket) -> tuple[GatewaySupervisor, list[tuple[str, str]]]:
    supervisor = object.__new__(GatewaySupervisor)
    supervisor.channels = {"channel-1": ws}
    supervisor.session_channels = {"session-1": {"channel-1"}}
    supervisor._browser_frame_seen = set()
    traces: list[tuple[str, str]] = []
    supervisor._trace = lambda event, **kwargs: traces.append((event, str(kwargs.get("detail") or "")))  # type: ignore[method-assign]
    supervisor._report_error = lambda error: (_ for _ in ()).throw(AssertionError(str(error)))  # type: ignore[method-assign]
    return supervisor, traces


class BrowserFrameRelayTests(unittest.TestCase):
    def test_live_sized_invalid_utf8_text_metadata_is_promoted_to_binary(self) -> None:
        ws = _FakeWebSocket()
        supervisor, traces = _supervisor(ws)
        payload = bytearray(105)
        payload[:12] = b"management!!"
        payload[12] = 0x9B
        payload[13:] = bytes((index % 251 for index in range(92)))
        raw = bytes(payload)
        digest = hashlib.sha256(raw).hexdigest()[:12]

        supervisor._handle({
            "kind": "ws_send",
            "sessionId": "session-1",
            "channelId": "channel-1",
            "dataBase64": base64.b64encode(raw).decode("ascii"),
            "binary": False,
        })

        self.assertEqual(ws.sent, [("send", raw, websocket.ABNF.OPCODE_BINARY)])
        self.assertFalse(ws.closed)
        self.assertIn(
            ("ws_browser_text_promoted_binary", f"len=105:sha256={digest}"),
            traces,
        )

    def test_valid_text_remains_text(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _ = _supervisor(ws)
        payload = "hello VS Code"

        supervisor._handle({
            "kind": "ws_send",
            "sessionId": "session-1",
            "channelId": "channel-1",
            "dataBase64": base64.b64encode(payload.encode("utf-8")).decode("ascii"),
            "binary": False,
        })

        self.assertEqual(ws.sent, [("send", payload, websocket.ABNF.OPCODE_TEXT)])
        self.assertFalse(ws.closed)

    def test_binary_metadata_stays_binary(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _ = _supervisor(ws)
        payload = b"\x00\x9b\xff"

        supervisor._handle({
            "kind": "ws_send",
            "sessionId": "session-1",
            "channelId": "channel-1",
            "dataBase64": base64.b64encode(payload).decode("ascii"),
            "binary": True,
        })

        self.assertEqual(ws.sent, [("send", payload, websocket.ABNF.OPCODE_BINARY)])
        self.assertFalse(ws.closed)

    def test_invalid_base64_fails_closed(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _ = _supervisor(ws)
        errors: list[str] = []
        supervisor._report_error = lambda error: errors.append(str(error))  # type: ignore[method-assign]

        supervisor._handle({
            "kind": "ws_send",
            "sessionId": "session-1",
            "channelId": "channel-1",
            "dataBase64": "%%%not-base64%%%",
            "binary": True,
        })

        self.assertTrue(ws.closed)
        self.assertNotIn("channel-1", supervisor.channels)
        self.assertEqual(errors, ["ws_browser_frame_invalid_base64"])


if __name__ == "__main__":
    unittest.main()
