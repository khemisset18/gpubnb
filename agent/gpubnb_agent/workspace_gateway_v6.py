"""Capability negotiation for latency-safe browser WebSocket startup.

The preceding gateway layers own lifecycle, GPU fencing, HTTP/WebSocket relay and
frame compatibility.  This final layer only advertises a narrow protocol
capability on the already signed gateway registration request.

Protocol v2 means the Host guarantees an explicit ``ws_open`` acknowledgement
after the local code-server WebSocket handshake succeeds.  A compatible API may
therefore prepare the upstream channel before exposing an apparently-open
browser socket, avoiding a race with VS Code's own remote-handshake deadline.
Older APIs simply ignore the additive field.
"""
from __future__ import annotations

from typing import Any

from . import workspace_gateway as legacy

GATEWAY_PROTOCOL_VERSION = 2


def with_gateway_protocol_capability(
    path: str,
    method: str,
    body: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Return a copied register body with the supported protocol version.

    Only the exact signed ``/agent/workspace-gateway/<session>/register`` route
    is augmented.  No caller-owned dictionary is mutated and unrelated signed
    request bodies remain byte-for-byte unchanged before serialization.
    """
    parts = path.split("/")
    is_register = (
        method.upper() == "POST"
        and len(parts) == 5
        and parts[0] == ""
        and parts[1] == "agent"
        and parts[2] == "workspace-gateway"
        and bool(parts[3])
        and parts[4] == "register"
    )
    if not is_register or not isinstance(body, dict):
        return body
    enriched = dict(body)
    enriched["gatewayProtocolVersion"] = GATEWAY_PROTOCOL_VERSION
    return enriched


_BaseGatewaySupervisor = legacy.GatewaySupervisor


class GatewaySupervisor(_BaseGatewaySupervisor):
    """Advertise v2 without changing any already-qualified gateway behavior."""

    def _request(
        self,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return super()._request(
            path,
            method,
            with_gateway_protocol_capability(path, method, body),
        )


def install() -> None:
    legacy.GatewaySupervisor = GatewaySupervisor
