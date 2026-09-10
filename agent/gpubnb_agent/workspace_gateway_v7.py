"""Protocol compatibility guard for browser -> code-server WebSocket frames.

Physical beta.84 traces proved that local code-server opens and signed open ACKs
are fast, but some browser relay commands can still arrive without the `binary`
boolean that the hardened v3 relay requires. The v3 contract remains strict for
all generic channels. This final layer adds one deliberately narrow rollout
compatibility rule for code-server's content-addressed `/stable-<commit>`
WebSocket endpoint and recognizes an explicit protocol version when the API
supplies one.

Security properties:

* modern protocol messages MUST carry an explicit boolean `binary` field;
* unknown/non-boolean metadata still fails closed;
* legacy missing metadata is accepted only on a previously observed, strictly
  matched code-server `/stable-<40 hex>` channel and is relayed as binary bytes;
* frame payload/base64/size validation remains owned by v3 and is unchanged;
* unsupported protocol versions fail with a precise error instead of entering a
  reconnect loop;
* protocol compatibility state is bounded independently of payload buffers;
* no frame payload, cookie, token or credential is written to diagnostics.
"""
from __future__ import annotations

import re
import threading
from typing import Any

from . import workspace_gateway as legacy
from . import workspace_gateway_v6 as concurrent_open

WORKSPACE_GATEWAY_PROTOCOL_VERSION = 2
WS_PROTOCOL_CHANNEL_MAX_ITEMS = 512
_CODE_SERVER_WS_PATH = re.compile(r"^/stable-[0-9a-fA-F]{40}(?:\?|$)")


class GatewaySupervisor(concurrent_open.GatewaySupervisor):
    """v6 supervisor with explicit protocol-version and legacy metadata guard."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._ws_protocol_lock = threading.Lock()
        self._ws_channel_paths: dict[str, str] = {}

    @staticmethod
    def _message_protocol_version(item: dict[str, Any]) -> int | None:
        value = item.get("protocolVersion")
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise RuntimeError("workspace_protocol_version_invalid")
        if value != WORKSPACE_GATEWAY_PROTOCOL_VERSION:
            raise RuntimeError(
                "workspace_protocol_version_mismatch:"
                f"expected={WORKSPACE_GATEWAY_PROTOCOL_VERSION}:received={value}"
            )
        return value

    def _remember_channel_path(self, item: dict[str, Any]) -> None:
        channel_id = str(item.get("channelId") or "")
        path = str(item.get("path") or "")
        if not channel_id:
            return
        with self._ws_protocol_lock:
            if (
                channel_id not in self._ws_channel_paths
                and len(self._ws_channel_paths) >= WS_PROTOCOL_CHANNEL_MAX_ITEMS
            ):
                raise RuntimeError(
                    f"workspace_protocol_channel_state_exceeded:max={WS_PROTOCOL_CHANNEL_MAX_ITEMS}"
                )
            self._ws_channel_paths[channel_id] = path

    def _forget_channel_path(self, channel_id: str) -> None:
        if not channel_id:
            return
        with self._ws_protocol_lock:
            self._ws_channel_paths.pop(channel_id, None)

    def _channel_path(self, channel_id: str) -> str:
        with self._ws_protocol_lock:
            return self._ws_channel_paths.get(channel_id, "")

    def _fail_channel(self, item: dict[str, Any], error: Exception) -> None:
        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        self._report_error(error)
        ws = self.channels.get(channel_id)
        if ws is not None:
            # v3 owns the canonical fail-closed channel cleanup routine.
            self._close_broken_channel(session_id, channel_id, ws)
        self._forget_channel_path(channel_id)

    def _normalize_ws_send(self, item: dict[str, Any]) -> dict[str, Any] | None:
        """Return a safe relay item, or fail the channel and return ``None``.

        Legacy API messages have no protocolVersion. For those messages only,
        a missing binary field is recoverable on code-server's immutable
        `/stable-<commit>` WebSocket path. The exact payload bytes are then sent
        as a WebSocket binary frame, which is lossless and avoids inventing text
        encoding semantics. Any modern/malformed/ambiguous case remains strict.
        """
        try:
            version = self._message_protocol_version(item)
        except Exception as exc:
            self._fail_channel(item, exc)
            return None

        binary = item.get("binary")
        if isinstance(binary, bool):
            return item

        if version is not None:
            self._fail_channel(
                item,
                RuntimeError("workspace_protocol_binary_metadata_required"),
            )
            return None

        # Do not coerce strings, integers or other corrupted metadata. The only
        # rollout exception is a genuinely absent/null field from a legacy API.
        if "binary" in item and binary is not None:
            self._fail_channel(
                item,
                RuntimeError("ws_browser_frame_invalid_binary_metadata"),
            )
            return None

        channel_id = str(item.get("channelId") or "")
        path = self._channel_path(channel_id)
        if not _CODE_SERVER_WS_PATH.match(path):
            self._fail_channel(
                item,
                RuntimeError("ws_browser_frame_invalid_binary_metadata"),
            )
            return None

        normalized = dict(item)
        normalized["binary"] = True
        encoded = normalized.get("dataBase64")
        encoded_len = len(encoded) if isinstance(encoded, str) else 0
        self._trace(
            "ws_browser_binary_metadata_legacy_compat",
            session_id=str(item.get("sessionId") or ""),
            channel_id=channel_id,
            detail=f"binary=true:base64={encoded_len}",
        )
        return normalized

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")

        if kind == "ws_open":
            try:
                self._message_protocol_version(item)
                self._remember_channel_path(item)
            except Exception as exc:
                # Before a socket exists, use v6's signed open rejection path so
                # the API/browser receives a deterministic failure immediately.
                self._report_error(exc)
                self._reject_open(item, str(exc)[:180])
                return
            return super()._handle(item)

        if kind == "ws_send":
            normalized = self._normalize_ws_send(item)
            if normalized is None:
                return
            return super()._handle(normalized)

        if kind == "ws_close":
            self._forget_channel_path(str(item.get("channelId") or ""))
            return super()._handle(item)

        return super()._handle(item)


def install() -> None:
    """Install protocol compatibility after the qualified v6 scheduler."""
    legacy.GatewaySupervisor = GatewaySupervisor
