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
import urllib.request
from pathlib import Path
from typing import Any


WINDOWS_NVIDIA_SMI = Path(r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe")


def find_nvidia_smi() -> str | None:
    override = os.environ.get("GPUBNB_NVIDIA_SMI")
    candidates: list[str | None] = [override, shutil.which("nvidia-smi")]
    if platform.system() == "Windows":
        candidates.append(str(WINDOWS_NVIDIA_SMI))
    candidates.extend(["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"])
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))
    return None


def find_rocm_smi() -> str | None:
    override = os.environ.get("GPUBNB_ROCM_SMI")
    candidates: list[str | None] = [override, shutil.which("rocm-smi"), shutil.which("rocm_smi")]
    candidates.extend(["/opt/rocm/bin/rocm-smi", "/usr/bin/rocm-smi"])
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))
    return None


def find_xpu_smi() -> str | None:
    override = os.environ.get("GPUBNB_XPU_SMI")
    candidates: list[str | None] = [override, shutil.which("xpu-smi"), shutil.which("xpu_smi")]
    candidates.extend(["/usr/local/bin/xpu-smi", "/usr/bin/xpu-smi"])
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
            row: dict[str, Any] = {
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


def nvidia_gpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    executable = binary or find_nvidia_smi()
    if not executable:
        return []
    query = "name,uuid,memory.total,memory.used,driver_version,temperature.gpu,utilization.gpu,power.draw"
    result = run_command([executable, f"--query-gpu={query}", "--format=csv,noheader,nounits"])
    rows = parse_nvidia_csv(result.stdout) if result.returncode == 0 else []
    version = run_command([executable]).stdout
    match = re.search(r"CUDA Version:\s*([0-9.]+)", version)
    cuda_version = match.group(1) if match else None
    for row in rows:
        row["cudaVersion"] = cuda_version
        row["gpuVendor"] = "NVIDIA"
    return rows


def amdgpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    executable = binary or find_rocm_smi()
    if not executable:
        return []
    result = run_command([executable, "--json"])
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(data, list):
        data = [data]
    rows: list[dict[str, Any]] = []
    for card in data:
        if not isinstance(card, dict):
            continue
        try:
            vram = int(card.get("VRAM Total Memory (B)", card.get("memory", {}).get("vram", {}).get("total_memory", "0")))
            vram_mib = vram // (1024 * 1024) if vram else 0
            used = int(card.get("VRAM Total Memory (B)", card.get("memory", {}).get("vram", {}).get("used_memory", "0")))
            used_mib = used // (1024 * 1024) if used else 0
            row = {
                "gpuModel": str(card.get("Card series", card.get("Card model", card.get("gpu", "AMD GPU"))))[:200],
                "gpuUuid": str(card.get("GPU UUID", card.get("GUID", card.get("gpu_id", "amd-unknown"))))[:200],
                "vramMiB": vram_mib,
                "memoryUsedMiB": used_mib,
                "driverVersion": str(card.get("Driver version", "rocm"))[:100],
                "cudaVersion": None,
                "temperatureC": int(float(card.get("Temperature (Sensor edge) (C)", card.get("temperature", {}).get("edge", "0")))),
                "gpuUtilization": int(float(card.get("GPU use (%)", card.get("utilization", {}).get("gpu", "0")))),
                "powerWatts": float(card.get("Average Graphics Package Power (W)", card.get("power", {}).get("average_graphics", 0))) or None,
                "gpuVendor": "AMD",
            }
        except (ValueError, TypeError):
            continue
        if vram_mib > 0 and -20 <= row["temperatureC"] <= 130 and 0 <= row["gpuUtilization"] <= 100:
            rows.append(row)
    return rows


def intel_gpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    executable = binary or find_xpu_smi()
    if not executable:
        return []
    result = run_command([executable, "discovery", "-j"])
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(data, list):
        data = [data]
    rows: list[dict[str, Any]] = []
    for gpu in data:
        if not isinstance(gpu, dict):
            continue
        try:
            vram_mib = int(gpu.get("memory", {}).get("size", 0)) // (1024 * 1024)
            row = {
                "gpuModel": str(gpu.get("name", "Intel GPU"))[:200],
                "gpuUuid": str(gpu.get("device_id", f"intel-{gpu.get('pci_device', 'unknown')}"))[:200],
                "vramMiB": vram_mib or 0,
                "memoryUsedMiB": 0,
                "driverVersion": str(gpu.get("driver_version", "xpu"))[:100],
                "cudaVersion": None,
                "temperatureC": int(gpu.get("temperature", {}).get("celsius", 0)),
                "gpuUtilization": 0,
                "powerWatts": float(gpu.get("power", {}).get("watts", 0)) or None,
                "gpuVendor": "INTEL",
            }
        except (ValueError, TypeError):
            continue
        if vram_mib >= 0 and -20 <= row["temperatureC"] <= 130:
            rows.append(row)
    return rows


def gpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    for detector in (nvidia_gpu_inventory, amdgpu_inventory, intel_gpu_inventory):
        rows = detector(binary if detector is nvidia_gpu_inventory else None)
        if rows:
            return rows
    return []


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


def internet_available() -> bool:
    try:
        urllib.request.urlopen("https://httpbin.org/status/200", timeout=5)
        return True
    except Exception:
        return False


def public_ip() -> str | None:
    try:
        with urllib.request.urlopen("https://httpbin.org/ip", timeout=5) as response:
            data = json.loads(response.read(1024).decode())
            return data.get("origin")
    except Exception:
        return None


def machine_fingerprint() -> str:
    gpus = gpu_inventory()
    gpu = gpus[0] if gpus else {}
    parts = [
        socket.gethostname(),
        platform.machine(),
        platform.processor() or platform.machine(),
        str(os.cpu_count() or 0),
        str(memory_info().get("ramTotalMiB") or 0),
        str(shutil.disk_usage(configured_disk_root()).total // (1024 * 1024)),
        str(gpu.get("gpuModel") or ""),
        str(gpu.get("gpuUuid") or ""),
        str(gpu.get("vramMiB") or 0),
    ]
    import hashlib
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]


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
        "internetAvailable": internet_available(),
        "publicIp": public_ip(),
        "machineFingerprint": machine_fingerprint(),
    }


def configured_disk_root() -> str:
    return os.environ.get("SystemDrive", "C:") + "\\" if platform.system() == "Windows" else "/"
