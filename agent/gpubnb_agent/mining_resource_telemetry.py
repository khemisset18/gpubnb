"""Read-only, privacy-preserving mining telemetry for signed Agent heartbeats."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .storage import config_dir

SCHEMA_VERSION = 1
MAX_HEARTBEAT_MINING_RESOURCES = 32
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
SAFE_GPU_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")
RESOURCE_STATES = {"MINING", "STOPPED", "QUARANTINED"}
SAFE_STOP_REASON = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")


def _number(value: Any, minimum: float, maximum: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    return numeric if minimum <= numeric <= maximum else None


def _integer(value: Any, minimum: int, maximum: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if minimum <= value <= maximum else None


def _snapshot(resource_id: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or SAFE_ID.fullmatch(resource_id) is None:
        raise RuntimeError("gpu_resource_runtime_state_corrupt")
    hardware_uuid = value.get("hardware_uuid")
    state = value.get("state")
    maximum_temperature = value.get("maximum_temperature_c", 85)
    if (
        not isinstance(hardware_uuid, str)
        or SAFE_GPU_ID.fullmatch(hardware_uuid) is None
        or state not in RESOURCE_STATES
        or isinstance(maximum_temperature, bool)
        or not isinstance(maximum_temperature, int)
        or not 85 <= maximum_temperature <= 98
    ):
        raise RuntimeError("gpu_resource_runtime_state_corrupt")

    stop_reason = value.get("last_stop_reason")
    if not isinstance(stop_reason, str) or SAFE_STOP_REASON.fullmatch(stop_reason) is None:
        stop_reason = None
    hashrate_unit = value.get("last_hashrate_unit")
    if hashrate_unit not in {"H/s", "kH/s", "MH/s", "GH/s", "TH/s"}:
        hashrate_unit = None

    return {
        "resourceId": resource_id,
        "hardwareUuid": hardware_uuid,
        "state": state,
        "maximumTemperatureC": maximum_temperature,
        "temperatureC": _number(value.get("last_temperature_c"), 0, 150),
        "powerWatts": _number(value.get("last_power_watts"), 0, 5000),
        "utilizationPercent": _integer(value.get("last_utilization_percent"), 0, 100),
        "hashrate": _number(value.get("last_hashrate"), 0, 1_000_000_000_000_000),
        "hashrateUnit": hashrate_unit,
        "acceptedShares": _integer(value.get("accepted_shares"), 0, 9_007_199_254_740_991),
        "staleShares": _integer(value.get("stale_shares"), 0, 9_007_199_254_740_991),
        "hardwareErrors": _integer(value.get("hardware_errors"), 0, 9_007_199_254_740_991),
        "uptimeSeconds": _integer(value.get("uptime_seconds"), 0, 315_360_000),
        "poolConnected": value.get("pool_connected") is True,
        "sampledAtMs": _integer(value.get("last_sampled_at_ms"), 0, 9_007_199_254_740_991),
        "lastStopReason": stop_reason,
    }


def mining_resource_telemetry_snapshot(path: Path | None = None) -> list[dict[str, Any]]:
    runtime_path = path or (config_dir() / "gpu-resource-runtime-v1.json")
    try:
        raw = json.loads(runtime_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("gpu_resource_runtime_state_corrupt") from exc

    if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeError("gpu_resource_runtime_state_schema_invalid")
    resources = raw.get("resources")
    if not isinstance(resources, dict):
        raise RuntimeError("gpu_resource_runtime_state_corrupt")

    snapshots: list[dict[str, Any]] = []
    for resource_id in sorted(resources)[:MAX_HEARTBEAT_MINING_RESOURCES]:
        if not isinstance(resource_id, str):
            raise RuntimeError("gpu_resource_runtime_state_corrupt")
        snapshots.append(_snapshot(resource_id, resources[resource_id]))
    return snapshots
