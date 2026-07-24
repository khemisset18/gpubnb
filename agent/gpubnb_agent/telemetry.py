"""Validated, privacy-preserving host telemetry for GPUbnb.

The sampler intentionally collects only values required for capacity planning,
health monitoring, availability accounting, and settlement evidence. It never
collects process lists, usernames, file paths, hostnames, or public IP addresses.
"""
from __future__ import annotations

import platform
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .accelerators import accelerator_inventory
from .platform_info import gpu_inventory, system_inventory


def _clamp(value: float | int | None, minimum: float, maximum: float) -> float | None:
    if value is None:
        return None
    numeric = float(value)
    if numeric < minimum or numeric > maximum:
        return None
    return numeric


def _linux_cpu_times() -> tuple[int, int] | None:
    try:
        fields = Path("/proc/stat").read_text(encoding="ascii", errors="strict").splitlines()[0].split()
        if not fields or fields[0] != "cpu":
            return None
        values = [int(value) for value in fields[1:]]
        total = sum(values)
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return total, idle
    except (OSError, ValueError, IndexError):
        return None


def _windows_cpu_times() -> tuple[int, int] | None:
    if platform.system() != "Windows":
        return None
    try:
        import ctypes

        class FileTime(ctypes.Structure):
            _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

            def value(self) -> int:
                return (self.high << 32) | self.low

        idle, kernel, user = FileTime(), FileTime(), FileTime()
        ok = ctypes.windll.kernel32.GetSystemTimes(
            ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
        )
        if not ok:
            return None
        return kernel.value() + user.value(), idle.value()
    except (AttributeError, OSError):
        return None


def cpu_times() -> tuple[int, int] | None:
    return _windows_cpu_times() if platform.system() == "Windows" else _linux_cpu_times()


def network_totals() -> tuple[int, int]:
    """Return aggregate RX/TX counters without exposing interface names."""
    if platform.system() == "Linux":
        try:
            rx = tx = 0
            for line in Path("/proc/net/dev").read_text(encoding="ascii", errors="replace").splitlines()[2:]:
                _, counters = line.split(":", 1)
                fields = counters.split()
                rx += int(fields[0])
                tx += int(fields[8])
            return rx, tx
        except (OSError, ValueError, IndexError):
            return 0, 0
    return 0, 0


def boot_id() -> str:
    """Return a non-secret boot identifier used to break accounting on reboot."""
    linux_id = Path("/proc/sys/kernel/random/boot_id")
    try:
        value = linux_id.read_text(encoding="ascii").strip().lower()
        if 8 <= len(value) <= 64:
            return value
    except OSError:
        pass
    started = max(0, int(time.time() - time.monotonic()))
    return f"boot-{started:x}"


@dataclass
class TelemetrySampler:
    """Stateful sampler that derives rates from monotonic host counters."""

    sequence: int = 0
    previous_monotonic: float | None = None
    previous_cpu: tuple[int, int] | None = None
    previous_network: tuple[int, int] | None = None

    def sample(self) -> dict[str, Any]:
        now = time.monotonic()
        cpu = cpu_times()
        network = network_totals()
        elapsed = None if self.previous_monotonic is None else max(0.001, now - self.previous_monotonic)

        cpu_percent: float | None = None
        if self.previous_cpu and cpu:
            total_delta = cpu[0] - self.previous_cpu[0]
            idle_delta = cpu[1] - self.previous_cpu[1]
            if total_delta > 0 and 0 <= idle_delta <= total_delta:
                cpu_percent = 100.0 * (total_delta - idle_delta) / total_delta

        rx_rate = tx_rate = 0
        if elapsed and self.previous_network:
            rx_rate = max(0, int((network[0] - self.previous_network[0]) / elapsed))
            tx_rate = max(0, int((network[1] - self.previous_network[1]) / elapsed))

        self.sequence += 1
        self.previous_monotonic = now
        self.previous_cpu = cpu
        self.previous_network = network

        system = system_inventory()
        gpus = [normalize_gpu_metric(gpu) for gpu in gpu_inventory()]
        gpus = [gpu for gpu in gpus if gpu is not None]
        accelerators = accelerator_inventory()
        ram_total = int(system.get("ramTotalMiB") or 0)
        ram_available = int(system.get("ramAvailableMiB") or 0)
        disk_total = int(system.get("diskTotalMiB") or 0)
        disk_available = int(system.get("diskAvailableMiB") or 0)

        return {
            "schemaVersion": 2,
            "sequence": self.sequence,
            "bootId": boot_id(),
            "monotonicMs": int(now * 1000),
            "cpuUtilization": round(cpu_percent, 2) if cpu_percent is not None else None,
            "ramUsedMiB": max(0, ram_total - ram_available),
            "diskUsedMiB": max(0, disk_total - disk_available),
            "networkRxBytesPerSecond": rx_rate,
            "networkTxBytesPerSecond": tx_rate,
            "gpus": gpus,
            "accelerators": accelerators,
            "runtime": {
                "dockerAvailable": bool(system.get("dockerAvailable")),
                "dockerVersion": system.get("dockerVersion"),
                "nvidiaRuntimeAvailable": bool(system.get("nvidiaRuntimeAvailable")),
            },
        }


def normalize_gpu_metric(gpu: dict[str, Any]) -> dict[str, Any] | None:
    total = int(gpu.get("vramMiB") or 0)
    used = int(gpu.get("memoryUsedMiB") or 0)
    utilization = _clamp(gpu.get("gpuUtilization"), 0, 100)
    temperature = _clamp(gpu.get("temperatureC"), -20, 140)
    power = _clamp(gpu.get("powerWatts"), 0, 5000)
    if not gpu.get("gpuUuid") or total <= 0 or used < 0 or used > total:
        return None
    return {
        "gpuVendor": str(gpu.get("gpuVendor") or "UNKNOWN")[:16],
        "gpuUuid": str(gpu["gpuUuid"])[:200],
        "gpuModel": str(gpu.get("gpuModel") or "Unknown GPU")[:200],
        "vramMiB": total,
        "memoryUsedMiB": used,
        "gpuUtilization": round(utilization, 2) if utilization is not None else None,
        "temperatureC": round(temperature, 2) if temperature is not None else None,
        "powerWatts": round(power, 2) if power is not None else None,
        "driverVersion": str(gpu.get("driverVersion") or "unknown")[:100],
        "throttling": bool(gpu.get("throttling", False)),
    }


_DEFAULT_SAMPLER = TelemetrySampler()


def telemetry_snapshot() -> dict[str, Any]:
    return _DEFAULT_SAMPLER.sample()
