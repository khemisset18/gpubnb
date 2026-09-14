"""Versioned cross-component compatibility descriptor reported by the Agent.

The values in this module intentionally mirror apps/api/src/release-compatibility.ts.
They travel inside the v2 telemetry object of the signed heartbeat, so the API can
fail closed on component skew without inventing compatibility from a version string.
"""
from __future__ import annotations

from typing import Final

RELEASE_COMPATIBILITY_PROTOCOL: Final[int] = 1
RELEASE_FEATURE_PROTOCOLS: Final[dict[str, int]] = {
    "agentRequestSignature": 2,
    "hostPowerPolicy": 1,
    "workspaceGateway": 1,
    "supportReport": 1,
}


def release_compatibility_descriptor() -> dict[str, object]:
    return {
        "releaseCompatibilityProtocol": RELEASE_COMPATIBILITY_PROTOCOL,
        "features": dict(RELEASE_FEATURE_PROTOCOLS),
    }
