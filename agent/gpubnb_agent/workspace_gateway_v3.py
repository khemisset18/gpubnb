"""Browser-frame compatibility layer for the Developer Workspace tunnel.

Production traces show the Management channel successfully exchanging binary
code-server messages before a later browser->host command triggers a UTF-8
decode failure. RFC 6455 requires text messages to contain valid UTF-8, so a
non-UTF-8 payload marked as text is transport metadata corruption, not valid
application text.

This layer preserves the v2 transport and lifecycle behavior while making the
browser->local relay lossless, bounded, and observable. Valid text stays text,
declared binary stays binary, and impossible non-UTF-8 "text" is promoted to
binary so one metadata mismatch cannot tear down the VS Code Management channel.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Any

import websocket

from . import workspace_gateway as legacy
from . import workspace_gateway_v2 as transport

MAX_BROWSER_FRAME_BASE64_BYTES = ((legacy.WS_MAX_FRAME_BYTES + 2) // 3) * 4


class GatewaySupervisor(transport.GatewaySupervisor):
    """v2 supervisor with lossless, bounded browser-frame forwarding."""

    def _request(
        self,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Keep the failing workspace endpoint visible in local diagnostics."""
        try:
            return super()._request(path, method, body)
        except Exception as exc:
            raise RuntimeError(
                f"workspace_api_request_failed:{method.upper()}:{path}:{str(exc)[:220]}"
            ) from exc

    @staticmethod
    def _decode_browser_payload(item: dict[str, Any]) -> bytes:
        encoded_value = item.get("dataBase64")
        if not isinstance(encoded_value, str):
            raise RuntimeError("ws_browser_frame_invalid_base64_type")
        if len(encoded_value) > MAX_BROWSER_FRAME_BASE64_BYTES:
            raise RuntimeError(
                f"ws_browser_frame_encoded_too_large:max={MAX_BROWSER_FRAME_BASE64_BYTES}"
            )
        try:
            data = base64.b64decode(encoded_value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("ws_browser_frame_invalid_base64") from exc
        if len(data) > legacy.WS_MAX_FRAME_BYTES:
            raise RuntimeError(
                f"ws_browser_frame_too_large:len={len(data)}:max={legacy.WS_MAX_FRAME_BYTES}"
            )
        return data

    @staticmethod
    def _fingerprint(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()[:12]

    @staticmethod
    def _declared_binary(item: dict[str, Any]) -> bool:
        value = item.get("binary")
        if not isinstance(value, bool):
            raise RuntimeError("ws_browser_frame_invalid_binary_metadata")
        return value

    def _close_broken_channel(self, session_id: str, channel_id: str, ws: Any) -> None:
        self.channels.pop(channel_id, None)
        self.session_channels.get(session_id, set()).discard(channel_id)
        self._browser_frame_seen.discard(channel_id)
        try:
            ws.close()
        except Exception:
            pass

    def _handle(self, item: dict[str, Any]) -> None:
        if item.get("kind") != "ws_send":
            return super()._handle(item)

        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        ws = self.channels.get(channel_id)
        if ws is None:
            return

        try:
            data = self._decode_browser_payload(item)
            declared_binary = self._declared_binary(item)
            first_frame = bool(channel_id and channel_id not in self._browser_frame_seen)

            if declared_binary:
                ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
            else:
                try:
                    text = data.decode("utf-8", errors="strict")
                except UnicodeDecodeError:
                    # RFC 6455 text messages must be valid UTF-8. Production proved
                    # that bytes can nevertheless arrive with text metadata in this
                    # relay. Preserve the exact bytes as binary instead of tearing
                    # down Management and emit only non-sensitive diagnostics.
                    self._trace(
                        "ws_browser_text_promoted_binary",
                        session_id=session_id,
                        channel_id=channel_id,
                        detail=f"len={len(data)}:sha256={self._fingerprint(data)}",
                    )
                    ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
                else:
                    ws.send(text, opcode=websocket.ABNF.OPCODE_TEXT)

            # Mark a first frame only after websocket-client accepted the send. The
            # trace therefore proves the frame reached the local socket API rather
            # than merely proving it was decoded from the control plane.
            if first_frame:
                self._browser_frame_seen.add(channel_id)
                self._trace(
                    "ws_first_browser_frame_relayed",
                    session_id=session_id,
                    channel_id=channel_id,
                    detail=(
                        f"len={len(data)}:binary={declared_binary}:"
                        f"sha256={self._fingerprint(data)}"
                    ),
                )
        except Exception as exc:
            self._report_error(exc)
            self._close_broken_channel(session_id, channel_id, ws)


def install() -> None:
    """Install the compatibility supervisor after the v2 transport."""
    legacy.GatewaySupervisor = GatewaySupervisor
