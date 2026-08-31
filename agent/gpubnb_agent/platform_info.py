"""Cross-platform hardware and runtime detection.

Only marketplace-relevant inventory is returned. Direct personal identifiers
(hostname, username, public IP, process list and user paths) are deliberately
excluded from server-facing payloads.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

WINDOWS_NVIDIA_SMI = Path(r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe")
MAX_COMMAND_OUTPUT = 2_000_000


def _find_binary(env_name: str, names: list[str], fixed: list[str]) -> str | None:
    candidates = [os.environ.get(env_name), *(shutil.which(name) for name in names), *fixed]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    return None


def find_nvidia_smi() -> str | None:
    fixed = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"]
    if platform.system() == "Windows":
        fixed.insert(0, str(WINDOWS_NVIDIA_SMI))
    return _find_binary("GPUBNB_NVIDIA_SMI", ["nvidia-smi"], fixed)


def find_rocm_smi() -> str | None:
    return _find_binary("GPUBNB_ROCM_SMI", ["amd-smi", "rocm-smi", "rocm_smi"], ["/opt/rocm/bin/amd-smi", "/opt/rocm/bin/rocm-smi", "/usr/bin/rocm-smi"])


def find_xpu_smi() -> str | None:
    return _find_binary("GPUBNB_XPU_SMI", ["xpu-smi", "xpu_smi"], ["/usr/local/bin/xpu-smi", "/usr/bin/xpu-smi"])


def run_command(command: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
    """Run an allowlisted executable without a shell and with bounded output."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False, shell=False)
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(command, 127, "", "command unavailable")
    result.stdout = result.stdout[:MAX_COMMAND_OUTPUT]
    result.stderr = result.stderr[:16384]
    return result


def _number(value: Any, default: float = 0) -> float:
    if value is None:
        return default
    match = re.search(r"-?[0-9]+(?:\.[0-9]+)?", str(value).replace(",", "."))
    return float(match.group(0)) if match else default


def parse_nvidia_csv(output: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for values in csv.reader(line for line in output.splitlines() if line.strip()):
        fields = [value.strip() for value in values]
        if len(fields) not in {8, 9}:
            continue
        try:
            row: dict[str, Any] = {
                "gpuModel": fields[0][:200], "gpuUuid": fields[1][:200],
                "vramMiB": int(fields[2]), "memoryUsedMiB": int(fields[3]),
                "driverVersion": fields[4][:100],
                "cudaVersion": fields[5][:50] if len(fields) == 9 else None,
                "temperatureC": int(fields[-3]), "gpuUtilization": int(fields[-2]),
                "powerWatts": None if fields[-1] in {"N/A", "[N/A]"} else float(fields[-1]),
            }
        except ValueError:
            continue
        power = row["powerWatts"]
        if 0 <= row["memoryUsedMiB"] <= row["vramMiB"] <= 1_000_000 and -20 <= row["temperatureC"] <= 140 and 0 <= row["gpuUtilization"] <= 100 and (power is None or 0 <= power <= 5000):
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
    for row in rows:
        row.update({"cudaVersion": match.group(1) if match else None, "gpuVendor": "NVIDIA", "throttling": False})
    return rows


def _walk_dict(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def amdgpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    executable = binary or find_rocm_smi()
    if not executable:
        return []
    commands = [[executable, "static", "--json"], [executable, "metric", "--json"], [executable, "--json"]]
    data: Any = None
    for command in commands:
        result = run_command(command)
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                break
            except json.JSONDecodeError:
                pass
    if data is None:
        return []
    cards = data if isinstance(data, list) else list(data.values()) if isinstance(data, dict) and all(isinstance(v, dict) for v in data.values()) else [data]
    rows: list[dict[str, Any]] = []
    for card in cards:
        if not isinstance(card, dict):
            continue
        vram_bytes = int(_number(card.get("VRAM Total Memory (B)") or _walk_dict(card, "memory", "vram", "total_memory")))
        used_bytes = int(_number(card.get("VRAM Total Memory Used (B)") or _walk_dict(card, "memory", "vram", "used_memory")))
        vram_mib = vram_bytes // (1024 * 1024) if vram_bytes > 1_000_000 else int(_number(card.get("vram_total") or card.get("vram_size")))
        used_mib = used_bytes // (1024 * 1024) if used_bytes > 1_000_000 else int(_number(card.get("vram_used")))
        row = {
            "gpuModel": str(card.get("Card series") or card.get("Card model") or card.get("name") or "AMD GPU")[:200],
            "gpuUuid": str(card.get("GPU UUID") or card.get("GUID") or card.get("gpu_id") or card.get("bdf") or "")[:200],
            "vramMiB": vram_mib, "memoryUsedMiB": used_mib,
            "driverVersion": str(card.get("Driver version") or card.get("driver_version") or "rocm")[:100],
            "cudaVersion": None,
            "temperatureC": int(_number(card.get("Temperature (Sensor edge) (C)") or _walk_dict(card, "temperature", "edge"))),
            "gpuUtilization": int(_number(card.get("GPU use (%)") or _walk_dict(card, "utilization", "gpu"))),
            "powerWatts": _number(card.get("Average Graphics Package Power (W)") or _walk_dict(card, "power", "average_graphics")) or None,
            "gpuVendor": "AMD", "throttling": bool(card.get("throttling") or card.get("violation")),
        }
        if row["gpuUuid"] and vram_mib > 0 and 0 <= used_mib <= vram_mib and -20 <= row["temperatureC"] <= 140 and 0 <= row["gpuUtilization"] <= 100:
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
    except json.JSONDecodeError:
        return []
    cards = data if isinstance(data, list) else data.get("device_list", data.get("devices", [])) if isinstance(data, dict) else []
    rows: list[dict[str, Any]] = []
    for gpu in cards:
        if not isinstance(gpu, dict):
            continue
        raw_memory = _number(_walk_dict(gpu, "memory", "size") or gpu.get("memory_physical_size_byte"))
        vram_mib = int(raw_memory // (1024 * 1024)) if raw_memory > 1_000_000 else int(raw_memory)
        row = {
            "gpuModel": str(gpu.get("device_name") or gpu.get("name") or "Intel GPU")[:200],
            "gpuUuid": str(gpu.get("uuid") or gpu.get("device_id") or gpu.get("pci_bdf_address") or "")[:200],
            "vramMiB": vram_mib, "memoryUsedMiB": int(_number(gpu.get("memory_used"))),
            "driverVersion": str(gpu.get("driver_version") or "xpu")[:100], "cudaVersion": None,
            "temperatureC": int(_number(_walk_dict(gpu, "temperature", "celsius") or gpu.get("gpu_temperature"))),
            "gpuUtilization": int(_number(gpu.get("gpu_utilization"))),
            "powerWatts": _number(_walk_dict(gpu, "power", "watts") or gpu.get("gpu_power")) or None,
            "gpuVendor": "INTEL", "throttling": bool(gpu.get("throttling")),
        }
        if row["gpuUuid"] and vram_mib >= 0 and 0 <= row["memoryUsedMiB"] <= max(vram_mib, row["memoryUsedMiB"]) and -20 <= row["temperatureC"] <= 140 and 0 <= row["gpuUtilization"] <= 100:
            rows.append(row)
    return rows


def gpu_inventory(binary: str | None = None) -> list[dict[str, Any]]:
    """Return all detected GPUs, deduplicated by vendor and stable GPU UUID."""
    detected: list[dict[str, Any]] = []
    for detector in (nvidia_gpu_inventory, amdgpu_inventory, intel_gpu_inventory):
        detected.extend(detector(binary if detector is nvidia_gpu_inventory else None))
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for gpu in detected:
        key = (str(gpu.get("gpuVendor")), str(gpu.get("gpuUuid")))
        unique[key] = gpu
    return list(unique.values())


def docker_info() -> dict[str, Any]:
    executable = shutil.which("docker")
    if not executable:
        return {"available": False, "daemonReachable": False, "nvidiaRuntime": False, "version": None}
    version_result = run_command([executable, "version", "--format", "{{json .Server.Version}}"])
    # `docker info` enumerates the full daemon state (not just a version string);
    # under real contention (e.g. right after other Docker activity: pulling an
    # image, building, starting containers) it was measured taking up to ~14s on
    # a real Windows/Docker Desktop host, well past the default 8s run_command
    # timeout - a false timeout here reports nvidiaRuntimeAvailable=False on a
    # host where the NVIDIA Container Toolkit is genuinely installed, which then
    # makes every Developer-workspace compatibility check fail.
    info_result = run_command([executable, "info", "--format", "{{json .Runtimes}}"], timeout=20)
    return {
        "available": True,
        "daemonReachable": version_result.returncode == 0,
        "nvidiaRuntime": info_result.returncode == 0 and "nvidia" in info_result.stdout.lower(),
        "version": version_result.stdout.strip().strip('"') or None,
    }


def memory_info() -> dict[str, int | None]:
    if platform.system() == "Windows":
        result = run_command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress)"])
        try:
            value = json.loads(result.stdout)
            return {"ramTotalMiB": int(value["TotalVisibleMemorySize"]) // 1024, "ramAvailableMiB": int(value["FreePhysicalMemory"]) // 1024}
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            return {"ramTotalMiB": None, "ramAvailableMiB": None}
    try:
        values: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0])
        return {"ramTotalMiB": values.get("MemTotal", 0) // 1024, "ramAvailableMiB": values.get("MemAvailable", 0) // 1024}
    except (OSError, ValueError):
        return {"ramTotalMiB": None, "ramAvailableMiB": None}


def cpu_info() -> dict[str, Any]:
    model = platform.processor() or platform.machine()
    if platform.system() == "Linux":
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
                if line.lower().startswith("model name"):
                    model = line.split(":", 1)[1].strip()
                    break
        except OSError:
            pass
    return {"cpu": model[:200], "cpuCount": os.cpu_count() or 1}


def board_bios_info() -> dict[str, str | None]:
    result = {"motherboardManufacturer": None, "motherboardModel": None, "biosVendor": None, "biosVersion": None}
    if platform.system() == "Windows":
        command = "$b=Get-CimInstance Win32_BaseBoard|Select-Object -First 1 Manufacturer,Product;$i=Get-CimInstance Win32_BIOS|Select-Object -First 1 Manufacturer,SMBIOSBIOSVersion;@{board=$b;bios=$i}|ConvertTo-Json -Compress"
        parsed = run_command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command])
        try:
            data = json.loads(parsed.stdout)
            result.update({
                "motherboardManufacturer": str(data.get("board", {}).get("Manufacturer") or "")[:120] or None,
                "motherboardModel": str(data.get("board", {}).get("Product") or "")[:120] or None,
                "biosVendor": str(data.get("bios", {}).get("Manufacturer") or "")[:120] or None,
                "biosVersion": str(data.get("bios", {}).get("SMBIOSBIOSVersion") or "")[:120] or None,
            })
        except (json.JSONDecodeError, TypeError, AttributeError):
            pass
        return result
    paths = {
        "motherboardManufacturer": "/sys/class/dmi/id/board_vendor",
        "motherboardModel": "/sys/class/dmi/id/board_name",
        "biosVendor": "/sys/class/dmi/id/bios_vendor",
        "biosVersion": "/sys/class/dmi/id/bios_version",
    }
    for key, path in paths.items():
        try:
            value = Path(path).read_text(encoding="utf-8", errors="replace").strip()
            result[key] = value[:120] or None
        except OSError:
            pass
    return result


def virtualization_available() -> bool:
    if platform.system() == "Windows":
        # VirtualizationFirmwareEnabled becomes unreliable (often falsely False) once a
        # hypervisor (Hyper-V/WSL2, which Docker Desktop relies on) has already claimed the
        # CPU's virtualization extensions. HypervisorPresent is then the trustworthy signal
        # that virtualization is actually enabled and in use.
        firmware = run_command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty VirtualizationFirmwareEnabled)"])
        if firmware.returncode == 0 and firmware.stdout.strip().lower() == "true":
            return True
        hypervisor = run_command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 -ExpandProperty HypervisorPresent)"])
        return hypervisor.returncode == 0 and hypervisor.stdout.strip().lower() == "true"
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").lower()
        return " vmx " in f" {cpuinfo} " or " svm " in f" {cpuinfo} "
    except OSError:
        return False


def desktop_gpu_rendering_available() -> bool:
    """Real, honest, cheap static signal for a GPU-accelerated Linux desktop
    surface (Creator/Cloud Desktop/CAD Workspaces - not built yet, see
    docs/SESSION_RESUME.md). This is deliberately NOT the same thing as
    nvidiaRuntimeAvailable/cudaVersion: this host has real, working CUDA
    compute passthrough (--gpus works for AI/Video/Developer) but NO
    /dev/dri, confirmed live - proving those two capabilities are genuinely
    different and one must never be inferred from the other. Windows and
    WSL2 (which reports platform.system()=="Linux" too, so it must be
    excluded explicitly rather than assumed away) never have a real
    /dev/dri render node under Docker Desktop - only a real native Linux
    Docker host does. This is a cheap static check only (real Linux, a
    real /dev/dri/render* node, the NVIDIA Container Toolkit registered)
    - it does NOT prove OpenGL/Vulkan rendering actually works end to end
    inside a container; that needs a real one-shot container-based proof
    (mirroring GPU_PROOF's pattern) once there is an actual image to run
    it against, which there is not yet on this host.
    """
    if platform.system() != "Linux":
        return False
    try:
        version = Path("/proc/version").read_text(encoding="utf-8", errors="ignore").lower()
        if "microsoft" in version or "wsl" in version:
            return False
    except OSError:
        pass
    try:
        render_nodes = list(Path("/dev/dri").glob("render*"))
    except OSError:
        render_nodes = []
    if not render_nodes:
        return False
    return docker_info()["nvidiaRuntime"]


def configured_disk_root() -> str:
    return os.environ.get("SystemDrive", "C:") + "\\" if platform.system() == "Windows" else "/"


def machine_fingerprint() -> str:
    """Pseudonymous hardware-change marker; never includes hostname or serial numbers."""
    gpus = gpu_inventory()
    board = board_bios_info()
    memory = memory_info()
    disk = shutil.disk_usage(configured_disk_root())
    parts = [
        platform.system(), platform.machine(), str(os.cpu_count() or 0),
        str(memory.get("ramTotalMiB") or 0), str(disk.total // (1024 * 1024)),
        str(board.get("motherboardManufacturer") or ""), str(board.get("motherboardModel") or ""),
        *(f"{gpu.get('gpuVendor')}:{gpu.get('gpuUuid')}:{gpu.get('vramMiB')}" for gpu in gpus),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


def system_inventory() -> dict[str, Any]:
    disk = shutil.disk_usage(configured_disk_root())
    docker = docker_info()
    return {
        "inventorySchemaVersion": 2,
        "os": platform.system(), "osVersion": platform.version()[:200], "architecture": platform.machine(),
        **cpu_info(), **memory_info(), **board_bios_info(),
        "diskTotalMiB": disk.total // (1024 * 1024), "diskAvailableMiB": disk.free // (1024 * 1024),
        "dockerAvailable": docker["available"], "dockerDaemonReachable": docker["daemonReachable"],
        "dockerVersion": docker["version"], "nvidiaRuntimeAvailable": docker["nvidiaRuntime"],
        "virtualizationAvailable": virtualization_available(),
        "desktopGpuRenderingAvailable": desktop_gpu_rendering_available(),
        "machineFingerprint": machine_fingerprint(),
    }
