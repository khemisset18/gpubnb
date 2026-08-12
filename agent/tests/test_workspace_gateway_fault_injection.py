from __future__ import annotations

import base64
import threading
import unittest
from unittest.mock import MagicMock, patch

from gpubnb_agent import workspace_gateway_v2 as transport
from gpubnb_agent.workspace_gateway_v3 import (
    GatewaySupervisor as BackpressureSupervisor,
    WS_BACKPRESSURE_RETRY_DELAYS_SECONDS,
)
from gpubnb_agent.workspace_gateway_v4 import (
    GatewaySupervisor,
    HTTP_RELAY_MAX_REQUEST_BASE64_BYTES,
)


class HttpControlPlaneFaultInjectionTests(unittest.TestCase):
    def _supervisor(self) -> GatewaySupervisor:
        supervisor = object.__new__(GatewaySupervisor)
        supervisor.machine_id = "machine-1"
        supervisor._trace = MagicMock()  # type: ignore[method-assign]
        supervisor._report_error = MagicMock()  # type: ignore[method-assign]
        supervisor._request = MagicMock(return_value={"ok": True})  # type: ignore[method-assign]
        return supervisor

    def test_invalid_base64_is_rejected_before_http_worker_queue(self) -> None:
        supervisor = self._supervisor()
        item = {
            "id": "request-1",
            "kind": "http",
            "sessionId": "session-1",
            "bodyBase64": "%%%corrupt%%%",
        }

        with patch.object(transport.GatewaySupervisor, "_dispatch_http") as parent_dispatch:
            supervisor._dispatch_http(item)

        parent_dispatch.assert_not_called()
        supervisor._request.assert_called_once()  # type: ignore[attr-defined]
        body = supervisor._request.call_args.args[2]  # type: ignore[attr-defined]
        self.assertEqual(body["status"], 502)
        self.assertEqual(body["error"], "workspace_http_request_invalid_base64")

    def test_oversized_encoded_body_is_rejected_before_decode(self) -> None:
        supervisor = self._supervisor()
        item = {
            "id": "request-2",
            "kind": "http",
            "sessionId": "session-1",
            "bodyBase64": "A" * (HTTP_RELAY_MAX_REQUEST_BASE64_BYTES + 1),
        }

        with patch.object(transport.GatewaySupervisor, "_dispatch_http") as parent_dispatch:
            supervisor._dispatch_http(item)

        parent_dispatch.assert_not_called()
        body = supervisor._request.call_args.args[2]  # type: ignore[attr-defined]
        self.assertEqual(body["status"], 502)
        self.assertIn("workspace_http_request_encoded_too_large", body["error"])

    def test_valid_body_reaches_existing_bounded_http_pipeline_unchanged(self) -> None:
        supervisor = self._supervisor()
        raw = b"binary-http-body\x00\xff"
        item = {
            "id": "request-3",
            "kind": "http",
            "sessionId": "session-1",
            "bodyBase64": base64.b64encode(raw).decode("ascii"),
        }

        with patch.object(transport.GatewaySupervisor, "_dispatch_http") as parent_dispatch:
            supervisor._dispatch_http(item)

        parent_dispatch.assert_called_once_with(item)
        supervisor._request.assert_not_called()  # type: ignore[attr-defined]


class BackpressureFaultInjectionTests(unittest.TestCase):
    def _supervisor(self) -> BackpressureSupervisor:
        supervisor = object.__new__(BackpressureSupervisor)
        supervisor.stop_event = threading.Event()
        supervisor._supports_ws_frame_batch = True
        supervisor._trace = MagicMock()  # type: ignore[method-assign]
        return supervisor

    def test_repeated_429_is_bounded_and_never_changes_frame_identity(self) -> None:
        supervisor = self._supervisor()
        frames = [{
            "frameId": "11111111-1111-4111-8111-111111111111",
            "channelId": "22222222-2222-4222-8222-222222222222",
            "dataBase64": "YQ==",
            "binary": True,
        }]
        seen: list[list[dict[str, object]]] = []

        def always_backpressure(_self: object, posted: list[dict[str, object]]) -> None:
            seen.append(posted)
            raise RuntimeError("API HTTP 429: workspace_ws_browser_backpressure")

        with patch.object(transport.GatewaySupervisor, "_post_ws_frames", new=always_backpressure):
            with patch.object(supervisor.stop_event, "wait", return_value=False) as wait:
                with self.assertRaisesRegex(RuntimeError, "API HTTP 429"):
                    supervisor._post_ws_frames(frames)

        self.assertEqual(len(seen), len(WS_BACKPRESSURE_RETRY_DELAYS_SECONDS))
        self.assertTrue(all(call[0]["frameId"] == frames[0]["frameId"] for call in seen))
        self.assertEqual(
            [call.args[0] for call in wait.call_args_list],
            list(WS_BACKPRESSURE_RETRY_DELAYS_SECONDS[:-1]),
        )

    def test_shutdown_interrupts_backpressure_retry_immediately(self) -> None:
        supervisor = self._supervisor()
        frames = [{"frameId": "frame-1", "channelId": "channel-1"}]

        with patch.object(
            transport.GatewaySupervisor,
            "_post_ws_frames",
            side_effect=RuntimeError("API HTTP 429: workspace_ws_browser_backpressure"),
        ) as post:
            with patch.object(supervisor.stop_event, "wait", return_value=True):
                with self.assertRaisesRegex(RuntimeError, "ws_backpressure_retry_interrupted"):
                    supervisor._post_ws_frames(frames)

        self.assertEqual(post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
