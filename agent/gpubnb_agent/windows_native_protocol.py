"""Strict wire parsing shared by native helper preflight and lifecycle checks."""
from __future__ import annotations

import json
import re
from typing import Any

# Exact public IddCx failure classes emitted by the Helper. Shared by preflight
# and lifecycle parsing so START/STOP cannot silently discard a refined cause.
VIRTUAL_DISPLAY_FAILURE_REASONS = frozenset({
    "virtual_display",
    "virtual_display_interface_query",
    "virtual_display_interface_missing",
    "virtual_display_interface_ambiguous",
    "virtual_display_control_open",
    "virtual_display_control",
    "virtual_display_gate",
    "virtual_display_busy",
    "virtual_display_access_denied",
    "virtual_display_not_ready",
    "virtual_display_invalid_request",
})

_GPU_UUID = re.compile(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


def valid_gpu_uuid(value: object) -> bool:
    return isinstance(value, str) and _GPU_UUID.fullmatch(value) is not None


def schema_v1(value: object) -> bool:
    # bool is an int subclass in Python; JSON true and 1.0 are not schema 1.
    return type(value) is int and value == 1


def json_object(stdout: str) -> dict[str, Any] | None:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_key")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError("non_json_constant")

    if not isinstance(stdout, str) or len(stdout) > 65536:
        return None
    try:
        value = json.loads(
            stdout, object_pairs_hook=unique_object, parse_constant=reject_constant
        )
    except (TypeError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None
