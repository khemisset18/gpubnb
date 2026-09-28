"""Desktop/streaming workspace activation layer.

The base gateway already contains the real, digest-pinned Selkies launch profiles for
Cloud Desktop, Creator, CAD and Gaming, including GPU attachment and the reduced
linuxserver/webtop hardening profile. Until this layer, those code paths were
intentionally unreachable because the slugs were excluded from
``GATEWAY_WORKSPACE_SLUGS``.

This layer only expands the accepted slug set. Compatibility remains server
controlled: each of these manifests requires ``desktopGpuRenderingAvailable`` plus
its RAM/VRAM/disk requirements, so unsupported Windows/WSL2 hosts remain rejected
before a job can be created. No fallback to Developer is permitted for these slugs.
"""
from __future__ import annotations

import platform

from . import workspace_gateway as legacy

DESKTOP_GATEWAY_WORKSPACE_SLUGS = frozenset({
    "cloud-desktop",
    "creator",
    "cad",
    "gaming",
})


def install() -> None:
    """Enable Selkies desktop slugs only on the qualified Linux backend.

    Windows desktop sessions belong exclusively to the separate Windows-native
    runtime. Keeping these slugs out of the Docker gateway on every non-Linux
    host is defense in depth against a stale or malformed control-plane session.
    """
    if platform.system() != "Linux":
        return
    legacy.GATEWAY_WORKSPACE_SLUGS = frozenset(
        set(legacy.GATEWAY_WORKSPACE_SLUGS) | set(DESKTOP_GATEWAY_WORKSPACE_SLUGS)
    )
