#!/usr/bin/env python3
"""Local qualification report for GPUbnb Windows-native graphical Workspaces.

This tool is intentionally read-only from the marketplace point of view: it does
not make a Machine bookable and does not start a renter Workspace. It invokes the
same fail-closed native stream-helper self-test used by the Agent exactly once,
reports only non-secret capability facts, and can optionally return a non-zero exit
status when qualification is required by an operator/CI step.
"""
from __future__ import annotations

import argparse
import json
import platform
from typing import Any

from gpubnb_agent.windows_native_workspace import (
    WINDOWS_NATIVE_WORKSPACE_SLUGS,
    discover_native_application,
    find_stream_helper,
    profile_for_slug,
    windows_native_desktop_preflight,
)

REPORT_SCHEMA_VERSION = 1


def build_report(workspace: str | None = None) -> dict[str, Any]:
    slugs = [workspace] if workspace else sorted(WINDOWS_NATIVE_WORKSPACE_SLUGS)
    if any(slug not in WINDOWS_NATIVE_WORKSPACE_SLUGS for slug in slugs):
        raise ValueError("unsupported_windows_native_workspace")

    helper = find_stream_helper()
    # Expensive physical capture/NVENC/session proof: run once, then evaluate the
    # four Workspace-specific application/audio gates from the same snapshot.
    preflight = windows_native_desktop_preflight(helper)
    workspace_reports: dict[str, dict[str, Any]] = {}

    for slug in slugs:
        profile = profile_for_slug(slug)
        application = discover_native_application(slug)
        application_available = application is not None or profile.application is None

        if not preflight.available:
            ready, reason = False, preflight.reason
        elif profile.requires_audio and not preflight.audio_available:
            ready, reason = False, "workspace_audio_required"
        elif not application_available:
            ready, reason = False, f"{slug}_application_missing"
        else:
            ready, reason = True, "ready"

        workspace_reports[slug] = {
            "ready": bool(ready),
            "reason": str(reason)[:200],
            # Deliberately report only presence. Never print provider filesystem paths.
            "applicationAvailable": application_available,
            # Gaming controller readiness is asserted again by --start because the
            # preflight contract currently proves capture/input isolation, not a
            # particular renter controller device.
            "runtimeControllerProofRequired": bool(profile.requires_controller),
        }

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "platform": platform.system(),
        "helperPresent": helper is not None,
        "nativeDesktopStreamingAvailable": bool(preflight.available),
        "preflight": {
            "reason": preflight.reason,
            "gpuUuid": preflight.gpu_uuid,
            "hardwareEncoder": preflight.hardware_encoder,
            "helperVersion": preflight.helper_version,
            "audioAvailable": bool(preflight.audio_available),
        },
        "workspaces": workspace_reports,
        "qualified": bool(preflight.available) and all(
            item["ready"] for item in workspace_reports.values()
        ),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe GPUbnb Windows-native Cloud Desktop/Creator/CAD/Gaming readiness."
    )
    parser.add_argument(
        "--workspace",
        choices=sorted(WINDOWS_NATIVE_WORKSPACE_SLUGS),
        help="Only evaluate one Workspace slug.",
    )
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="Exit 2 when the selected qualification is not ready.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = build_report(args.workspace)
    except Exception as exc:
        report = {
            "schemaVersion": REPORT_SCHEMA_VERSION,
            "platform": platform.system(),
            "qualified": False,
            "error": f"qualification_error:{type(exc).__name__}",
        }
        print(json.dumps(report, sort_keys=True))
        return 2 if args.require_ready else 0

    print(json.dumps(report, sort_keys=True))
    if args.require_ready and not report["qualified"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
