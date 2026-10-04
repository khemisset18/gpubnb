from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from gpubnb_agent.windows_native_runtime import NativeRuntimeHandle
from gpubnb_agent.workspace_gateway_v10 import (
    NativeGatewayRuntime,
    _connect_native_websocket,
)


SESSION = "session_loopback_1"
GPU = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
TOKEN = "a" * 64
PORT = 43123


def runtime(url: str = f"ws://127.0.0.1:{PORT}/session/{SESSION}") -> NativeGatewayRuntime:
    handle = NativeRuntimeHandle(
        session_id=SESSION,
        workspace_slug="cloud-desktop",
        gpu_uuid=GPU,
        helper_version="0.1.0",
        media_url=url.replace("ws://", "http://", 1),
        media_token=TOKEN,
        application_path=None,
        audio_ready=False,
        controller_ready=False,
    )
    return NativeGatewayRuntime(
        session_id=SESSION,
        runtime_id="gpubnb-native-test",
        port=PORT,
        websocket_url=url,
        handle=handle,
    )


class WindowsNativeDirectLoopbackTests(unittest.TestCase):
    def test_websocket_handshake_uses_preconnected_loopback_socket(self) -> None:
        raw = MagicMock()
        ws = MagicMock()

        with patch(
            "gpubnb_agent.workspace_gateway_v10.socket.create_connection",
            return_value=raw,
        ) as connect, patch(
            "gpubnb_agent.workspace_gateway_v10.websocket.create_connection",
            return_value=ws,
        ) as create_ws:
            result = _connect_native_websocket(runtime())

        self.assertIs(result, ws)
        connect.assert_called_once_with(("127.0.0.1", PORT), timeout=10.0)
        kwargs = create_ws.call_args.kwargs
        self.assertIs(kwargs["socket"], raw)
        self.assertEqual(
            kwargs["header"],
            [f"X-GPUbnb-Media-Token: {TOKEN}"],
        )
        self.assertEqual(kwargs["origin"], f"http://127.0.0.1:{PORT}")
        raw.close.assert_not_called()

    def test_failed_handshake_closes_preconnected_socket(self) -> None:
        raw = MagicMock()

        with patch(
            "gpubnb_agent.workspace_gateway_v10.socket.create_connection",
            return_value=raw,
        ), patch(
            "gpubnb_agent.workspace_gateway_v10.websocket.create_connection",
            side_effect=ConnectionAbortedError("simulated"),
        ):
            with self.assertRaises(ConnectionAbortedError):
                _connect_native_websocket(runtime())

        raw.close.assert_called_once_with()

    def test_non_plain_loopback_websocket_target_fails_closed(self) -> None:
        with patch(
            "gpubnb_agent.workspace_gateway_v10.socket.create_connection",
        ) as connect:
            with self.assertRaisesRegex(
                RuntimeError,
                "windows_native_media_endpoint_invalid",
            ):
                _connect_native_websocket(
                    runtime(f"wss://127.0.0.1:{PORT}/session/{SESSION}")
                )

        connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
