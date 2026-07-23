"""Cross-platform hardware and runtime detection."""
from __future__ import annotations

import csv
import json
import os
import platform
import re
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any


WINDOWS_NVIDIA_SMI = Path(r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe")


def find_nvidia_smi() -> str | None:
    override = os.environ.get("GPUBNB_NVIDIA_SMI")
    candidates = [override, shutil.which("nvidia-smi")]
    if platform.system() == "Windows":
        candidates.append(str(WINDOWS_NVIDIA_SMI))
    candidates.extend(["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"])
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))
    return None


def run_command(command: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def parse_nvidia_csv(output: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for values in csv.reader(line for line in output.splitlines() if line.strip()):
        fields = [value.strip() for value in values]
        if len(fields) not in {8, 9}:
            continue
        try:
            row = {
                "gpuModel": fields[0][:200],
                "gpuUuid": fields[1][:200],
                "vramMiB": int(fields[2]),
                "memoryUsedMiB": int(fields[3]),
                "driverVersion": fields[4][:100],
                "cudaVersion": fields[5][:50] if len(fields) == 9 else None,
                "temperatureC": int(fields[-3]),
                "gpuUtilization": int(fields[-2]),
                "powerWatts": None if fields[-1] in {"N/A", "[N/A]"} else float(fields[-1]),
            }
        except ValueError:
            continue
        if 0 <= row["memoryUsedMiB"] <= row["vramMiB"] <= 1_000_000 and -20 <= row["temperatureC"] <= 130 and 0 <= row["gpuUtilization"] <= 100:
            rows.append(row)
    return rows


def gpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    executable = binary or find_nvidia_smi()
    if not executable:
        return []
    query = "name,uuid,memory.total,memory.used,driver_version,temperature.gpu,utilization.gpu,power.draw"
    result = run_command([executable, f"--query-gpu={query}", "--format=csv,noheader,nounits"])
    rows = parse_nvidia_csv(result.stdout) if result.returncode == 0 else []
    version = run_command([executable]).stdout
    match = re.search(r"CUDA Version:\s*([0-9.]+)", version)
    for row in rows:
        row["cudaVersion"] = match.group(1) if match else None
    return rows


def docker_info() -> dict[str, Any]:
    executable = shutil.which("docker")
    if not executable:
        return {"available": False, "nvidiaRuntime": False, "version": None}
    version_result = run_command([executable, "version", "--format", "{{json .Server.Version}}"])
    info_result = run_command([executable, "info", "--format", "{{json .Runtimes}}"])
    runtimes = info_result.stdout.lower()
    return {
        "available": version_result.returncode == 0,
        "nvidiaRuntime": info_result.returncode == 0 and "nvidia" in runtimes,
        "version": version_result.stdout.strip().strip('"') or None,
    }


def memory_info() -> dict[str, int | None]:
    if platform.system() == "Windows":
        result = run_command(["powershell.exe", "-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress)"])
        try:
            value = json.loads(result.stdout)
            return {"ramTotalMiB": int(value["TotalVisibleMemorySize"]) // 1024, "ramAvailableMiB": int(value["FreePhysicalMemory"]) // 1024}
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return {"ramTotalMiB": None, "ramAvailableMiB": None}
    try:
        values: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0])
        return {"ramTotalMiB": values.get("MemTotal", 0) // 1024, "ramAvailableMiB": values.get("MemAvailable", 0) // 1024}
    except (FileNotFoundError, ValueError):
        return {"ramTotalMiB": None, "ramAvailableMiB": None}


def virtualization_available() -> bool:
    if platform.system() == "Windows":
        result = run_command(["powershell.exe", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty VirtualizationFirmwareEnabled)"])
        return result.returncode == 0 and result.stdout.strip().lower() == "true"
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").lower()
        return " vmx " in f" {cpuinfo} " or " svm " in f" {cpuinfo} "
    except OSError:
        return False


def system_inventory() -> dict[str, Any]:
    disk = shutil.disk_usage(configured_disk_root())
    docker = docker_info()
    return {
        "os": platform.system(),
        "osVersion": platform.version(),
        "architecture": platform.machine(),
        "hostname": socket.gethostname(),
        "cpu": platform.processor() or platform.machine(),
        "cpuCount": os.cpu_count(),
        **memory_info(),
        "diskTotalMiB": disk.total // (1024 * 1024),
        "diskAvailableMiB": disk.free // (1024 * 1024),
        "dockerAvailable": docker["available"],
        "dockerVersion": docker["version"],
        "nvidiaRuntimeAvailable": docker["nvidiaRuntime"],
        "virtualizationAvailable": virtualization_available(),
    }


def configured_disk_root() -> str:
    return os.environ.get("SystemDrive", "C:") + "\\" if platform.system() == "Windows" else "/"
