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
* malformed metadata cancels a still-pending v6 open as well as an established
  socket, so a rejected frame cannot leave an orphan live channel behind;
* protocol compatibility state is bounded independently of payload buffers and
  is discarded on canonical broken-channel cleanup;
* Docker/session reconciliation remains isolated from the latency-sensitive
  control loop while both loops use the same fail-closed recovery policy;
* no frame payload, cookie, token or credential is written to diagnostics.
"""
from __future__ import annotations

import re
import threading
from typing import Any

from . import workspace_gateway as legacy
from . import workspace_gateway_v2 as transport
from . import workspace_gateway_v6 as concurrent_open
from .supervisor_recovery import (
    PLATFORM_REPROBE_SECONDS,
    PolicyHostTunnelSupervisor,
    supervisor_wait,
)

WORKSPACE_GATEWAY_PROTOCOL_VERSION = 2
WS_PROTOCOL_CHANNEL_MAX_ITEMS = 512
_CODE_SERVER_WS_PATH = re.compile(r"^/stable-[0-9a-fA-F]{40}(?:\?|$)")


class GatewaySupervisor(concurrent_open.GatewaySupervisor):
    """v6 supervisor with protocol compatibility and policy-driven recovery."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._ws_protocol_lock = threading.Lock()
        self._ws_channel_paths: dict[str, str] = {}
        # The base constructor creates an empty tunnel supervisor. Replace it
        # before the run loop starts so tunnel retries share the central bounded
        # schedule without changing any authority/bootstrap validation logic.
        self.host_tunnels = PolicyHostTunnelSupervisor(
            self.api,
            self.key,
            self.machine_id,
            self.config,
        )

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

    def _cancel_pending_open(self, channel_id: str) -> bool:
        """Cancel v6 scheduler state without waiting for the local open thread."""
        if not channel_id:
            return False
        with self._ws_open_state_lock:
            pending = self._ws_open_pending.get(channel_id)
            if pending is None:
                return False
            self._ws_open_cancelled.add(channel_id)
            pending.clear()
            self._ws_open_pending_bytes[channel_id] = 0
            return True

    def _close_broken_channel(self, session_id: str, channel_id: str, ws: Any) -> None:
        """Extend v3 canonical cleanup with v7 compatibility-state cleanup."""
        try:
            super()._close_broken_channel(session_id, channel_id, ws)
        finally:
            self._forget_channel_path(channel_id)

    def _fail_channel(self, item: dict[str, Any], error: Exception) -> None:
        channel_id = str(item.get("channelId") or "")
        session_id = str(item.get("sessionId") or "")
        self._report_error(error)
        self._cancel_pending_open(channel_id)
        ws = self.channels.get(channel_id)
        if ws is not None:
            # v3 owns the canonical established-channel cleanup routine; our
            # override also removes the protocol-path state.
            self._close_broken_channel(session_id, channel_id, ws)
        else:
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

    def _report_recovery(
        self,
        mode: str,
        reason: str,
        delay_seconds: float | None,
    ) -> None:
        detail = f"workspace_gateway_recovery:mode={mode}:reason={reason}"
        if delay_seconds is not None:
            detail += f":retryAfter={delay_seconds:g}"
        self._report_error(RuntimeError(detail))

    def _recover_gateway_failure(self, exc: Exception, attempt: int) -> tuple[bool, int]:
        """Apply one central-policy decision and return (continue, next_attempt)."""
        self._report_error(exc)
        mode, reason, delay = supervisor_wait(
            exc,
            attempt,
            subsystem="gateway",
        )
        if mode == "retry":
            actual_delay = delay if delay is not None else 5.0
            self._report_recovery(mode, reason, actual_delay)
            if self.stop_event.wait(actual_delay):
                return False, attempt + 1
            return True, attempt + 1

        # Never retain an edge sidecar when signed gateway authority is blocked
        # by a platform/owner/security state.
        self.host_tunnels.stop_all()
        if mode == "platform_action":
            self._report_recovery(mode, reason, PLATFORM_REPROBE_SECONDS)
            if self.stop_event.wait(PLATFORM_REPROBE_SECONDS):
                return False, 0
            return True, 0

        # Unknown/owner/security failures shut down only this gateway plane. The
        # Windows service-wide power guard and diagnostic authority are separate.
        self._report_recovery(mode, reason, None)
        self.stop_event.set()
        return False, attempt

    def _reconcile_loop(self) -> None:
        """Keep expensive Docker reconciliation off the control-message loop."""
        attempt = 0
        while not self.stop_event.is_set():
            started = legacy.time.monotonic()
            try:
                self._reconcile_sessions()
            except Exception as exc:
                keep_running, attempt = self._recover_gateway_failure(exc, attempt)
                if not keep_running:
                    return
                continue
            attempt = 0
            elapsed = legacy.time.monotonic() - started
            delay = max(0.0, legacy.RECONCILE_INTERVAL_SECONDS - elapsed)
            if self.stop_event.wait(delay):
                return

    def run(self) -> None:
        """Preserve v2 control/reconcile isolation with central recovery policy."""
        initial_attempt = 0
        while not self.stop_event.is_set():
            try:
                self._reconcile_sessions()
            except Exception as exc:
                keep_running, initial_attempt = self._recover_gateway_failure(
                    exc,
                    initial_attempt,
                )
                if not keep_running:
                    self.host_tunnels.stop_all()
                    return
                continue
            break

        if self.stop_event.is_set():
            self.host_tunnels.stop_all()
            return

        reconcile_thread = threading.Thread(
            target=self._reconcile_loop,
            daemon=True,
            name="gpubnb-workspace-reconcile",
        )
        reconcile_thread.start()
        control_attempt = 0
        try:
            while not self.stop_event.is_set():
                try:
                    items = self._next_items()
                    for item in items:
                        self._handle(item)
                except Exception as exc:
                    keep_running, control_attempt = self._recover_gateway_failure(
                        exc,
                        control_attempt,
                    )
                    if not keep_running:
                        return
                    continue
                control_attempt = 0
                self._last_error_signature = None
                if items and self.stop_event.wait(transport.CONTROL_BURST_PAUSE_SECONDS):
                    return
        finally:
            self.stop_event.set()
            reconcile_thread.join(timeout=2.0)
            self.host_tunnels.stop_all()


def install() -> None:
    """Install protocol compatibility after the qualified v6 scheduler."""
    legacy.GatewaySupervisor = GatewaySupervisor
