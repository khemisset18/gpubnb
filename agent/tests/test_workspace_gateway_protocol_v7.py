from __future__ import annotations

import base64
import threading
import unittest

import websocket

from gpubnb_agent.workspace_gateway_v7 import (
    WORKSPACE_GATEWAY_PROTOCOL_VERSION,
    GatewaySupervisor,
)


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[tuple[object, int | None]] = []
        self.closed = False

    def send(self, data: object, opcode: int | None = None) -> None:
        self.sent.append((data, opcode))

    def close(self) -> None:
        self.closed = True


def _supervisor(path: str = "/stable-197ef3e8da8ee99ed6ca8f1a630157527e6d448f?reconnectionToken=test"):
    ws = _FakeWebSocket()
    supervisor = object.__new__(GatewaySupervisor)
    supervisor.channels = {"channel-1": ws}
    supervisor.session_channels = {"session-1": {"channel-1"}}
    supervisor._browser_frame_seen = set()
    supervisor._ws_open_state_lock = threading.Lock()
    supervisor._ws_open_pending = {}
    supervisor._ws_open_pending_bytes = {}
    supervisor._ws_open_cancelled = set()
    supervisor._ws_protocol_lock = threading.Lock()
    supervisor._ws_channel_paths = {"channel-1": path}
    traces: list[tuple[str, str]] = []
    errors: list[str] = []
    supervisor._trace = lambda event, **kwargs: traces.append((event, str(kwargs.get("detail") or "")))  # type: ignore[method-assign]
    supervisor._report_error = lambda error: errors.append(str(error))  # type: ignore[method-assign]
    return supervisor, ws, traces, errors


def _item(payload: bytes = b"management-frame") -> dict[str, object]:
    return {
        "kind": "ws_send",
        "sessionId": "session-1",
        "channelId": "channel-1",
        "dataBase64": base64.b64encode(payload).decode("ascii"),
    }


class WorkspaceGatewayProtocolV7Tests(unittest.TestCase):
    def test_legacy_missing_binary_metadata_is_binary_only_on_code_server_stable_path(self) -> None:
        supervisor, ws, traces, errors = _supervisor()
        item = _item()

        supervisor._handle(item)

        self.assertEqual(ws.sent, [(b"management-frame", websocket.ABNF.OPCODE_BINARY)])
        self.assertFalse(ws.closed)
        self.assertEqual(errors, [])
        self.assertEqual(
            [event for event, _ in traces if event == "ws_browser_binary_metadata_legacy_compat"],
            ["ws_browser_binary_metadata_legacy_compat"],
        )

    def test_legacy_missing_binary_is_normalized_before_v6_pending_buffer(self) -> None:
        supervisor, ws, traces, errors = _supervisor()
        supervisor.channels = {}
        supervisor._ws_open_pending = {"channel-1": []}
        supervisor._ws_open_pending_bytes = {"channel-1": 0}

        supervisor._handle(_item())

        self.assertEqual(ws.sent, [])
        self.assertEqual(errors, [])
        self.assertEqual(len(supervisor._ws_open_pending["channel-1"]), 1)
        buffered = supervisor._ws_open_pending["channel-1"][0]
        self.assertIs(buffered.get("binary"), True)
        self.assertEqual(
            [event for event, _ in traces if event == "ws_first_browser_frame_buffered"],
            ["ws_first_browser_frame_buffered"],
        )

    def test_legacy_missing_binary_metadata_fails_closed_on_unrelated_path(self) -> None:
        supervisor, ws, _, errors = _supervisor("/socket")

        supervisor._handle(_item())

        self.assertTrue(ws.closed)
        self.assertNotIn("channel-1", supervisor.channels)
        self.assertEqual(errors, ["ws_browser_frame_invalid_binary_metadata"])

    def test_modern_protocol_requires_explicit_binary_metadata(self) -> None:
        supervisor, ws, _, errors = _supervisor()
        item = _item()
        item["protocolVersion"] = WORKSPACE_GATEWAY_PROTOCOL_VERSION

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertEqual(errors, ["workspace_protocol_binary_metadata_required"])

    def test_modern_protocol_preserves_explicit_text_metadata(self) -> None:
        supervisor, ws, _, errors = _supervisor()
        item = _item(b"hello")
        item["protocolVersion"] = WORKSPACE_GATEWAY_PROTOCOL_VERSION
        item["binary"] = False

        supervisor._handle(item)

        self.assertEqual(ws.sent, [("hello", websocket.ABNF.OPCODE_TEXT)])
        self.assertFalse(ws.closed)
        self.assertEqual(errors, [])

    def test_modern_protocol_preserves_explicit_binary_metadata(self) -> None:
        supervisor, ws, _, errors = _supervisor()
        item = _item(b"\x00\xff")
        item["protocolVersion"] = WORKSPACE_GATEWAY_PROTOCOL_VERSION
        item["binary"] = True

        supervisor._handle(item)

        self.assertEqual(ws.sent, [(b"\x00\xff", websocket.ABNF.OPCODE_BINARY)])
        self.assertFalse(ws.closed)
        self.assertEqual(errors, [])

    def test_non_boolean_legacy_metadata_is_not_coerced(self) -> None:
        supervisor, ws, _, errors = _supervisor()
        item = _item()
        item["binary"] = "true"

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertEqual(errors, ["ws_browser_frame_invalid_binary_metadata"])

    def test_unknown_protocol_version_fails_with_precise_error(self) -> None:
        supervisor, ws, _, errors = _supervisor()
        item = _item()
        item["protocolVersion"] = WORKSPACE_GATEWAY_PROTOCOL_VERSION + 1
        item["binary"] = True

        supervisor._handle(item)

        self.assertTrue(ws.closed)
        self.assertEqual(
            errors,
            [
                "workspace_protocol_version_mismatch:"
                f"expected={WORKSPACE_GATEWAY_PROTOCOL_VERSION}:"
                f"received={WORKSPACE_GATEWAY_PROTOCOL_VERSION + 1}"
            ],
        )


if __name__ == "__main__":
    unittest.main()
