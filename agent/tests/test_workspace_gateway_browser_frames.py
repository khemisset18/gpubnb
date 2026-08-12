from __future__ import annotations

import base64
import hashlib
import unittest

import websocket

from gpubnb_agent import workspace_gateway as legacy
from gpubnb_agent.workspace_gateway_v3 import (
    MAX_BROWSER_FRAME_BASE64_BYTES,
    GatewaySupervisor,
)


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[tuple[str, object, int | None]] = []
        self.closed = False

    def send(self, data: object, opcode: int | None = None) -> None:
        self.sent.append(("send", data, opcode))

    def close(self) -> None:
        self.closed = True


def _supervisor(ws: _FakeWebSocket) -> tuple[GatewaySupervisor, list[tuple[str, str]], list[str]]:
    supervisor = object.__new__(GatewaySupervisor)
    supervisor.channels = {"channel-1": ws}
    supervisor.session_channels = {"session-1": {"channel-1"}}
    supervisor._browser_frame_seen = set()
    traces: list[tuple[str, str]] = []
    errors: list[str] = []
    supervisor._trace = lambda event, **kwargs: traces.append((event, str(kwargs.get("detail") or "")))  # type: ignore[method-assign]
    supervisor._report_error = lambda error: errors.append(str(error))  # type: ignore[method-assign]
    return supervisor, traces, errors


def _item(payload: bytes, *, binary: object) -> dict[str, object]:
    return {
        "kind": "ws_send",
        "sessionId": "session-1",
        "channelId": "channel-1",
        "dataBase64": base64.b64encode(payload).decode("ascii"),
        "binary": binary,
    }


class BrowserFrameRelayTests(unittest.TestCase):
    def test_live_sized_invalid_utf8_metadata_is_promoted_and_channel_continues(self) -> None:
        ws = _FakeWebSocket()
        supervisor, traces, errors = _supervisor(ws)
        payload = bytearray(105)
        payload[:12] = b"management!!"
        payload[12] = 0x9B
        payload[13:] = bytes((index % 251 for index in range(92)))
        raw = bytes(payload)
        digest = hashlib.sha256(raw).hexdigest()[:12]

        supervisor._handle(_item(raw, binary=False))
        follow_up = b"next-binary-frame"
        supervisor._handle(_item(follow_up, binary=True))

        self.assertEqual(
            ws.sent,
            [
                ("send", raw, websocket.ABNF.OPCODE_BINARY),
                ("send", follow_up, websocket.ABNF.OPCODE_BINARY),
            ],
        )
        self.assertFalse(ws.closed)
        self.assertEqual(errors, [])
        self.assertIn(
            ("ws_browser_text_promoted_binary", f"len=105:sha256={digest}"),
            traces,
        )
        first_relay_traces = [event for event, _ in traces if event == "ws_first_browser_frame_relayed"]
        self.assertEqual(first_relay_traces, ["ws_first_browser_frame_relayed"])

    def test_valid_text_remains_text(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _, errors = _supervisor(ws)
        payload = "hello VS Code"

        supervisor._handle(_item(payload.encode("utf-8"), binary=False))

        self.assertEqual(ws.sent, [("send", payload, websocket.ABNF.OPCODE_TEXT)])
        self.assertFalse(ws.closed)
        self.assertEqual(errors, [])

    def test_binary_metadata_stays_binary(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _, errors = _supervisor(ws)
        payload = b"\x00\x9b\xff"

        supervisor._handle(_item(payload, binary=True))

        self.assertEqual(ws.sent, [("send", payload, websocket.ABNF.OPCODE_BINARY)])
        self.assertFalse(ws.closed)
        self.assertEqual(errors, [])

    def test_invalid_base64_fails_closed(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _, errors = _supervisor(ws)
        item = _item(b"ok", binary=True)
        item["dataBase64"] = "%%%not-base64%%%"

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertNotIn("channel-1", supervisor.channels)
        self.assertEqual(errors, ["ws_browser_frame_invalid_base64"])

    def test_missing_binary_metadata_fails_closed(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _, errors = _supervisor(ws)
        item = _item(b"payload", binary=True)
        item.pop("binary")

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertEqual(errors, ["ws_browser_frame_invalid_binary_metadata"])

    def test_encoded_payload_is_bounded_before_decode(self) -> None:
        ws = _FakeWebSocket()
        supervisor, _, errors = _supervisor(ws)
        item = _item(b"payload", binary=True)
        item["dataBase64"] = "A" * (MAX_BROWSER_FRAME_BASE64_BYTES + 1)

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertEqual(
            errors,
            [f"ws_browser_frame_encoded_too_large:max={MAX_BROWSER_FRAME_BASE64_BYTES}"],
        )

    def test_decoded_frame_cannot_exceed_protocol_limit(self) -> None:
        # Base64 for max+1 bytes can be the same encoded length as the rounded
        # maximum, so the decoded-size guard must remain in addition to the early
        # encoded-size guard.
        raw = b"x" * (legacy.WS_MAX_FRAME_BYTES + 1)
        encoded = base64.b64encode(raw).decode("ascii")
        if len(encoded) > MAX_BROWSER_FRAME_BASE64_BYTES:
            self.skipTest("encoded length exceeded early guard on this boundary")
        ws = _FakeWebSocket()
        supervisor, _, errors = _supervisor(ws)
        item = {
            "kind": "ws_send",
            "sessionId": "session-1",
            "channelId": "channel-1",
            "dataBase64": encoded,
            "binary": True,
        }

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertEqual(
            errors,
            [f"ws_browser_frame_too_large:len={len(raw)}:max={legacy.WS_MAX_FRAME_BYTES}"],
        )


if __name__ == "__main__":
    unittest.main()
