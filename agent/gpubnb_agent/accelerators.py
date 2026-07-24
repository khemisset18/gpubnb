"""Extensible accelerator discovery for GPUbnb.

The agent core never relies on a closed model catalogue. Built-in and third-party
providers expose devices through a small, versioned interface. Unknown future
accelerators remain displayable even when only identity/capability data is
available.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Protocol, runtime_checkable

from .platform_info import gpu_inventory

SCHEMA_VERSION = 1
ENTRY_POINT_GROUP = "gpubnb.accelerator_providers"
MAX_DEVICES = 256
MAX_TEXT = 200
MAX_KIND = 32


def _text(value: Any, fallback: str = "unknown", limit: int = MAX_TEXT) -> str:
    text = str(value or fallback).strip()
    return text[:limit] or fallback


def _number(value: Any, minimum: float, maximum: float) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if minimum <= numeric <= maximum else None


def _stable_fallback_id(provider: str, vendor: str, model: str, bus: str | None) -> str:
    material = "|".join((provider, vendor, model, bus or "unaddressed")).encode("utf-8")
    return "derived-" + hashlib.sha256(material).hexdigest()[:32]


@dataclass(frozen=True)
class AcceleratorDevice:
    provider: str
    kind: str
    vendor: str
    model: str
    device_id: str
    bus_address: str | None = None
    memory_total_mib: int | None = None
    memory_used_mib: int | None = None
    utilization_percent: float | None = None
    temperature_c: float | None = None
    power_watts: float | None = None
    driver_version: str | None = None
    runtime_version: str | None = None
    available: bool = True
    throttling: bool = False
    capabilities: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)

    def as_payload(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "provider": self.provider,
            "kind": self.kind,
            "vendor": self.vendor,
            "model": self.model,
            "deviceId": self.device_id,
            "busAddress": self.bus_address,
            "memoryTotalMiB": self.memory_total_mib,
            "memoryUsedMiB": self.memory_used_mib,
            "utilizationPercent": self.utilization_percent,
            "temperatureC": self.temperature_c,
            "powerWatts": self.power_watts,
            "driverVersion": self.driver_version,
            "runtimeVersion": self.runtime_version,
            "available": self.available,
            "throttling": self.throttling,
            "capabilities": self.capabilities,
            "metrics": self.metrics,
        }


@runtime_checkable
class AcceleratorProvider(Protocol):
    """Contract implemented by built-in or externally installed detectors."""

    name: str

    def probe(self) -> bool:
        """Return quickly and without side effects when the provider is usable."""

    def inventory(self) -> Iterable[AcceleratorDevice | dict[str, Any]]:
        """Return detected devices. Provider failures must not stop other probes."""


class BuiltinGpuProvider:
    name = "builtin-gpu"

    def probe(self) -> bool:
        return True

    def inventory(self) -> Iterable[dict[str, Any]]:
        for gpu in gpu_inventory():
            yield {
                "provider": self.name,
                "kind": "GPU",
                "vendor": gpu.get("gpuVendor"),
                "model": gpu.get("gpuModel"),
                "deviceId": gpu.get("gpuUuid"),
                "memoryTotalMiB": gpu.get("vramMiB"),
                "memoryUsedMiB": gpu.get("memoryUsedMiB"),
                "utilizationPercent": gpu.get("gpuUtilization"),
                "temperatureC": gpu.get("temperatureC"),
                "powerWatts": gpu.get("powerWatts"),
                "driverVersion": gpu.get("driverVersion"),
                "runtimeVersion": gpu.get("cudaVersion"),
                "throttling": gpu.get("throttling", False),
                "capabilities": {"computeApi": "CUDA" if gpu.get("cudaVersion") else None},
            }


class JsonDirectoryProvider:
    """Read vendor-neutral device manifests produced by local driver adapters.

    A future hardware vendor can place UTF-8 JSON files in GPUBNB_ACCELERATOR_DIR
    without requiring a new GPUbnb release. Files contain either one object or a
    list of objects matching the normalized field names.
    """

    name = "json-directory"

    def __init__(self, directory: str | None = None) -> None:
        self.directory = Path(directory or os.environ.get("GPUBNB_ACCELERATOR_DIR", "./accelerators.d"))

    def probe(self) -> bool:
        return self.directory.is_dir()

    def inventory(self) -> Iterable[dict[str, Any]]:
        for path in sorted(self.directory.glob("*.json"))[:MAX_DEVICES]:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, UnicodeError):
                continue
            values = raw if isinstance(raw, list) else [raw]
            for value in values:
                if isinstance(value, dict):
                    value = dict(value)
                    value.setdefault("provider", f"manifest:{path.stem}")
                    yield value


def normalize_device(raw: AcceleratorDevice | dict[str, Any], provider_name: str) -> AcceleratorDevice | None:
    if isinstance(raw, AcceleratorDevice):
        return raw
    if not isinstance(raw, dict):
        return None

    provider = _text(raw.get("provider"), provider_name, 80)
    kind = _text(raw.get("kind"), "ACCELERATOR", MAX_KIND).upper()
    vendor = _text(raw.get("vendor"), "UNKNOWN", 80)
    model = _text(raw.get("model"), "Unknown accelerator")
    bus = _text(raw.get("busAddress"), "", 100) or None
    device_id = _text(raw.get("deviceId"), "", 200)
    if not device_id:
        device_id = _stable_fallback_id(provider, vendor, model, bus)

    total = raw.get("memoryTotalMiB")
    used = raw.get("memoryUsedMiB")
    try:
        total_i = None if total is None else int(total)
        used_i = None if used is None else int(used)
    except (TypeError, ValueError):
        return None
    if total_i is not None and not 0 <= total_i <= 100_000_000:
        return None
    if used_i is not None and (used_i < 0 or (total_i is not None and used_i > total_i)):
        return None

    capabilities = raw.get("capabilities") if isinstance(raw.get("capabilities"), dict) else {}
    metrics = raw.get("metrics") if isinstance(raw.get("metrics"), dict) else {}
    return AcceleratorDevice(
        provider=provider,
        kind=kind,
        vendor=vendor,
        model=model,
        device_id=device_id,
        bus_address=bus,
        memory_total_mib=total_i,
        memory_used_mib=used_i,
        utilization_percent=_number(raw.get("utilizationPercent"), 0, 100),
        temperature_c=_number(raw.get("temperatureC"), -273.15, 300),
        power_watts=_number(raw.get("powerWatts"), 0, 100_000),
        driver_version=_text(raw.get("driverVersion"), "", 100) or None,
        runtime_version=_text(raw.get("runtimeVersion"), "", 100) or None,
        available=bool(raw.get("available", True)),
        throttling=bool(raw.get("throttling", False)),
        capabilities=capabilities,
        metrics=metrics,
    )


def installed_providers() -> list[AcceleratorProvider]:
    providers: list[AcceleratorProvider] = [BuiltinGpuProvider(), JsonDirectoryProvider()]
    try:
        entries = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    except TypeError:  # Python 3.9 compatibility
        entries = importlib.metadata.entry_points().get(ENTRY_POINT_GROUP, [])
    except Exception:
        entries = []
    for entry in entries:
        try:
            candidate = entry.load()()
            if isinstance(candidate, AcceleratorProvider):
                providers.append(candidate)
        except Exception:
            continue
    return providers


def accelerator_inventory(providers: Iterable[AcceleratorProvider] | None = None) -> list[dict[str, Any]]:
    """Collect, normalize and deduplicate all accelerator devices."""
    devices: dict[tuple[str, str], AcceleratorDevice] = {}
    for provider in providers or installed_providers():
        try:
            if not provider.probe():
                continue
            for raw in provider.inventory():
                device = normalize_device(raw, provider.name)
                if device is not None:
                    devices[(device.kind, device.device_id)] = device
                if len(devices) >= MAX_DEVICES:
                    break
        except Exception:
            continue
    return [device.as_payload() for device in devices.values()]
