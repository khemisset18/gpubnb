"""Browser-frame compatibility layer for the Developer Workspace tunnel.

Production traces show the Management channel successfully exchanging binary
code-server messages before a later browser->host command triggers a UTF-8
decode failure. RFC 6455 requires text messages to contain valid UTF-8, so a
non-UTF-8 payload marked as text is transport metadata corruption, not valid
application text.

This layer preserves the v2 transport and lifecycle behavior while making the
browser->local relay lossless and observable. Valid text stays text, declared
binary stays binary, and impossible non-UTF-8 "text" is promoted to binary so a
single metadata mismatch cannot tear down the VS Code Management channel.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Any

import websocket

from . import workspace_gateway as legacy
from . import workspace_gateway_v2 as transport


class GatewaySupervisor(transport.GatewaySupervisor):
    """v2 supervisor with lossless, bounded browser-frame forwarding."""

    @staticmethod
    def _decode_browser_payload(item: dict[str, Any]) -> bytes:
        encoded = str(item.get("dataBase64") or "")
        try:
            return base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("ws_browser_frame_invalid_base64") from exc

    @staticmethod
    def _fingerprint(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()[:12]

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")
        if kind != "ws_send":
            return super()._handle(item)

        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        ws = self.channels.get(channel_id)
        if ws is None:
            return

        try:
            data = self._decode_browser_payload(item)
            if len(data) > legacy.WS_MAX_FRAME_BYTES:
                raise RuntimeError(
                    f"ws_browser_frame_too_large:channel={channel_id[:8]}:"
                    f"len={len(data)}:max={legacy.WS_MAX_FRAME_BYTES}"
                )

            declared_binary = item.get("binary") is True
            if channel_id and channel_id not in self._browser_frame_seen:
                self._browser_frame_seen.add(channel_id)
                self._trace(
                    "ws_first_browser_frame",
                    session_id=session_id,
                    channel_id=channel_id,
                    detail=(
                        f"len={len(data)}:binary={declared_binary}:"
                        f"sha256={self._fingerprint(data)}"
                    ),
                )

            if declared_binary:
                ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
                return

            try:
                text = data.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                # A WebSocket text message cannot legally contain these bytes.
                # Keep the protocol alive by preserving the exact payload as binary,
                # and emit only length/hash metadata so diagnostics never leak data.
                self._trace(
                    "ws_browser_text_promoted_binary",
                    session_id=session_id,
                    channel_id=channel_id,
                    detail=f"len={len(data)}:sha256={self._fingerprint(data)}",
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
