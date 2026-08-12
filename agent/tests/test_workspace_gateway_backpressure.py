from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from gpubnb_agent import workspace_gateway_v2 as transport
from gpubnb_agent.workspace_gateway_v3 import GatewaySupervisor


class WorkspaceGatewayBackpressureTests(unittest.TestCase):
    def _supervisor(self) -> GatewaySupervisor:
        supervisor = object.__new__(GatewaySupervisor)
        supervisor.stop_event = threading.Event()
        supervisor._supports_ws_frame_batch = True
        supervisor._trace = lambda *args, **kwargs: None  # type: ignore[method-assign]
        return supervisor

    def test_batched_frames_retry_429_with_same_frame_ids(self) -> None:
        supervisor = self._supervisor()
        frames = [
            {
                "frameId": "11111111-1111-4111-8111-111111111111",
                "channelId": "22222222-2222-4222-8222-222222222222",
                "dataBase64": "YQ==",
                "binary": True,
            }
        ]
        calls: list[list[dict[str, object]]] = []

        def fake_post(_self: object, posted: list[dict[str, object]]) -> None:
            calls.append(posted)
            if len(calls) == 1:
                raise RuntimeError("API HTTP 429: workspace_ws_browser_backpressure")

        with patch.object(transport.GatewaySupervisor, "_post_ws_frames", new=fake_post):
            with patch.object(supervisor.stop_event, "wait", return_value=False) as wait:
                supervisor._post_ws_frames(frames)

        self.assertEqual(calls, [frames, frames])
        wait.assert_called_once_with(0.05)
        self.assertEqual(calls[0][0]["frameId"], calls[1][0]["frameId"])

    def test_non_backpressure_error_is_not_retried(self) -> None:
        supervisor = self._supervisor()
        frames = [{"frameId": "frame-1", "channelId": "channel-1"}]

        with patch.object(
            transport.GatewaySupervisor,
            "_post_ws_frames",
            side_effect=RuntimeError("API HTTP 500: internal_error"),
        ) as post:
            with self.assertRaisesRegex(RuntimeError, "API HTTP 500"):
                supervisor._post_ws_frames(frames)

        self.assertEqual(post.call_count, 1)

    def test_legacy_single_frame_path_does_not_retry_429(self) -> None:
        supervisor = self._supervisor()
        supervisor._supports_ws_frame_batch = False
        frames = [{"frameId": "frame-1", "channelId": "channel-1"}]

        with patch.object(
            transport.GatewaySupervisor,
            "_post_ws_frames",
            side_effect=RuntimeError("API HTTP 429: workspace_ws_browser_backpressure"),
        ) as post:
            with self.assertRaisesRegex(RuntimeError, "API HTTP 429"):
                supervisor._post_ws_frames(frames)

        self.assertEqual(post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
