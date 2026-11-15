"""Fail-closed opt-in for Linux desktop GPU streaming laboratory tests only.

Not connected to Stage-4 Windows/WTS and never enabled for production or WSL.
"""
from __future__ import annotations

import os
import platform
import sys
from collections.abc import Mapping

DESKTOP_WORKSPACE_SLUGS = frozenset({"creator", "cloud-desktop", "cad", "gaming"})


def desktop_workspace_preview_enabled(
    environ: Mapping[str, str] | None = None,
    *,
    platform_name: str | None = None,
    kernel_release: str | None = None,
) -> bool:
    values = os.environ if environ is None else environ
    system = sys.platform if platform_name is None else platform_name
    release = platform.release() if kernel_release is None else kernel_release
    return (
        values.get("NODE_ENV") in {"development", "test"}
        and values.get("GPUBNB_DESKTOP_WORKSPACE_PREVIEW") == "true"
        and not values.get("RENDER")
        and not values.get("RENDER_SERVICE_ID")
        and system.startswith("linux")
        and "microsoft" not in release.casefold()
        and "wsl" not in release.casefold()
    )
