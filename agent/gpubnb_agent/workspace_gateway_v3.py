"""Browser-frame compatibility layer for the Developer Workspace tunnel.

VS Code normally marks its binary protocol frames correctly, but production logs
showed browser payloads containing non-UTF-8 bytes reaching the Agent with the
text/binary flag cleared. The legacy handler decoded every non-binary payload as
UTF-8 before handing it to websocket-client, which raised UnicodeDecodeError and
closed an otherwise healthy Management channel.

This layer preserves the v2 transport and lifecycle behavior and only replaces
browser -> local code-server frame forwarding. Valid text remains text. Invalid
UTF-8 that was mislabeled as text is promoted to a standards-compliant binary
WebSocket frame instead of terminating the channel.
"""
from __future__ import annotations

import base64
from typing import Any

import websocket

from . import workspace_gateway as legacy
from . import workspace_gateway_v2 as transport


class GatewaySupervisor(transport.GatewaySupervisor):
    """v2 supervisor with lossless browser-frame forwarding."""

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")
        if kind != "ws_send":
            return super()._handle(item)

        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        if channel_id and channel_id not in self._browser_frame_seen:
            self._browser_frame_seen.add(channel_id)
            self._trace(
                "ws_first_browser_frame",
                session_id=session_id,
                channel_id=channel_id,
                detail=(
                    f"base64={len(str(item.get('dataBase64') or ''))}:"
                    f"binary={item.get('binary') is True}"
                ),
            )

        ws = self.channels.get(channel_id)
        if ws is None:
            return

        try:
            data = base64.b64decode(str(item.get("dataBase64") or ""), validate=False)
            if len(data) > legacy.WS_MAX_FRAME_BYTES:
                raise RuntimeError(
                    f"ws_browser_frame_too_large:channel={channel_id[:8]}:"
                    f"len={len(data)}:max={legacy.WS_MAX_FRAME_BYTES}"
                )

            if item.get("binary") is True:
                ws.send_binary(data)
                return

            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                # A WebSocket text frame must be valid UTF-8. If upstream metadata
                # says "text" but the bytes cannot be UTF-8, preserving the bytes
                # as a binary frame is the only standards-compliant, lossless path.
                self._trace(
                    "ws_browser_text_promoted_binary",
                    session_id=session_id,
                    channel_id=channel_id,
                    detail=f"len={len(data)}",
                )
                ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
                return

            ws.send(text, opcode=websocket.ABNF.OPCODE_TEXT)
        except Exception as exc:
            self._report_error(exc)
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            self._browser_frame_seen.discard(channel_id)
            try:
                ws.close()
            except Exception:
                pass


def install() -> None:
    """Install the compatibility supervisor after the v2 transport."""
    legacy.GatewaySupervisor = GatewaySupervisor
