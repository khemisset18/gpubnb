"""Strict control-plane validation for Developer Workspace HTTP relay commands.

The browser-facing API already limits raw HTTP request bodies to 10 MiB. This
layer mirrors that invariant on the Host before a command enters the HTTP worker
queue. It rejects malformed or oversized Base64 without allocating an unbounded
decoded payload and without letting permissive decoding silently alter bytes.
"""
from __future__ import annotations

import base64
import binascii
from typing import Any

from . import workspace_gateway as legacy
from . import workspace_gateway_v3 as browser

HTTP_RELAY_MAX_REQUEST_BYTES = 10 * 1024 * 1024
HTTP_RELAY_MAX_REQUEST_BASE64_BYTES = ((HTTP_RELAY_MAX_REQUEST_BYTES + 2) // 3) * 4


class GatewaySupervisor(browser.GatewaySupervisor):
    """v3 supervisor with strict HTTP control-plane payload validation."""

    @staticmethod
    def _validate_http_body(item: dict[str, Any]) -> None:
        encoded = item.get("bodyBase64")
        if encoded is None:
            return
        if not isinstance(encoded, str):
            raise RuntimeError("workspace_http_request_invalid_base64_type")
        if len(encoded) > HTTP_RELAY_MAX_REQUEST_BASE64_BYTES:
            raise RuntimeError(
                f"workspace_http_request_encoded_too_large:max={HTTP_RELAY_MAX_REQUEST_BASE64_BYTES}"
            )
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("workspace_http_request_invalid_base64") from exc
        if len(decoded) > HTTP_RELAY_MAX_REQUEST_BYTES:
            raise RuntimeError(
                f"workspace_http_request_too_large:max={HTTP_RELAY_MAX_REQUEST_BYTES}"
            )

    def _dispatch_http(self, item: dict[str, Any]) -> None:
        try:
            self._validate_http_body(item)
        except Exception as exc:
            request_id = str(item.get("id") or "")
            self._trace(
                "http_request_rejected",
                session_id=str(item.get("sessionId") or ""),
                detail=str(exc)[:180],
            )
            try:
                self._request(
                    "/agent/workspace-gateway/respond",
                    "POST",
                    {
                        "machineId": self.machine_id,
                        "id": request_id,
                        "status": 502,
                        "error": str(exc)[:200],
                    },
                )
            except Exception as response_error:
                self._report_error(response_error)
            return
        return super()._dispatch_http(item)


def install() -> None:
    """Install strict HTTP validation after the v3 browser-frame layer."""
    legacy.GatewaySupervisor = GatewaySupervisor
