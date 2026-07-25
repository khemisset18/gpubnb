"""Strict runner for the only remotely accepted MVP workload."""
from __future__ import annotations

import json
import re
import subprocess
from typing import Any

from .platform_info import gpu_inventory

PINNED_IMAGE = re.compile(r"^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")
OFFICIAL_DIAGNOSTIC_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpu-diagnostic@sha256:[a-f0-9]{64}$")


def _gpu_vendor() -> str:
    gpus = gpu_inventory()
    return str(gpus[0].get("gpuVendor", "NVIDIA")).upper() if gpus else "NVIDIA"


def gpu_passthrough_flags() -> list[str]:
    vendor = _gpu_vendor()
    if vendor == "AMD":
        return ["--device=/dev/kfd", "--device=/dev/dri", "--security-opt=seccomp=unconfined"]
    if vendor == "INTEL":
        return ["--device=/dev/dri", "--security-opt=seccomp=unconfined"]
    return ["--gpus=device=0", "--env=NVIDIA_DRIVER_CAPABILITIES=utility"]


def _hardened_container_base(image: str) -> list[str]:
    return [
        "docker", "run", "--rm", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=32", "--memory=128m", "--cpus=0.5",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=8m", *gpu_passthrough_flags(), image,
    ]


def gpu_probe_command(image: str) -> list[str]:
    if _gpu_vendor() != "NVIDIA":
        raise RuntimeError("official_gpu_diagnostic_supports_nvidia_only")
    return _hardened_container_base(image)


def diagnostic_command(image: str) -> list[str]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit être une image Docker épinglée par digest sha256")
    if not OFFICIAL_DIAGNOSTIC_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit utiliser l'image officielle ghcr.io/khemisset18/gpu-diagnostic épinglée par digest")
    return gpu_probe_command(image)


def run_gpu_diagnostic(image: str, timeout_seconds: int) -> dict[str, Any]:
    timeout = max(30, min(600, int(timeout_seconds)))
    try:
        result = subprocess.run(
            diagnostic_command(image), capture_output=True, text=True,
            timeout=timeout, check=False, shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("diagnostic_timeout") from exc
    stdout = result.stdout[:64_000].strip()
    stderr = result.stderr[:4_000].strip()
    if result.returncode != 0:
        raise RuntimeError(f"diagnostic_container_failed:{result.returncode}:{stderr}")
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("diagnostic_invalid_json") from exc
    if not isinstance(report, dict) or report.get("schemaVersion") != 1 or report.get("vendor") != "NVIDIA":
        raise RuntimeError("diagnostic_invalid_schema")
    gpus = report.get("gpus")
    if not isinstance(gpus, list):
        raise RuntimeError("diagnostic_invalid_gpu_list")
    safe_gpus = []
    for gpu in gpus[:16]:
        if not isinstance(gpu, dict):
            raise RuntimeError("diagnostic_invalid_gpu_entry")
        safe_gpus.append({
            "index": int(gpu.get("index", 0)),
            "name": str(gpu.get("name", ""))[:200],
            "uuid": str(gpu.get("uuid", ""))[:200],
            "memoryTotalMiB": int(gpu.get("memoryTotalMiB", 0)),
            "memoryUsedMiB": int(gpu.get("memoryUsedMiB", 0)),
            "temperatureC": int(gpu.get("temperatureC", 0)),
        })
    return {
        "gpuDetected": bool(safe_gpus),
        "summary": "Diagnostic GPU officiel terminé." if safe_gpus else "Aucun GPU détecté dans le conteneur.",
        "metrics": {"gpuCount": len(safe_gpus), "vendor": "NVIDIA", "gpus": safe_gpus},
    }


def workspace_health_command(image: str, workspace_slug: str) -> list[str]:
    if workspace_slug == "developer":
        base = [
            "docker", "run", "--rm", "--network=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=512m", "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", *gpu_passthrough_flags(),
        ]
        return [*base, "--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", image]
    return diagnostic_command(image)


def prepare_workspace(image: str, timeout_seconds: int, workspace_slug: str = "compute") -> dict[str, Any]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit être une image Docker épinglée par digest sha256")
    timeout = max(30, min(600, int(timeout_seconds)))
    inspect = subprocess.run(
        ["docker", "image", "inspect", image],
        capture_output=True, text=True, timeout=30, check=False, shell=False,
    )
    cache_hit = inspect.returncode == 0
    if not cache_hit:
        pull = subprocess.run(
            ["docker", "pull", image],
            capture_output=True, text=True, timeout=timeout, check=False, shell=False,
        )
        if pull.returncode != 0:
            raise RuntimeError(f"workspace_image_pull_failed:{pull.returncode}:{pull.stderr[:1000].strip()}")
    health = subprocess.run(
        workspace_health_command(image, workspace_slug),
        capture_output=True, text=True, timeout=timeout, check=False, shell=False,
    )
    if health.returncode != 0:
        raise RuntimeError(f"workspace_health_check_failed:{health.returncode}:{health.stderr[:1000].strip()}")
    return {
        "gpuDetected": True,
        "summary": f"Workspace {workspace_slug} préparé et contrôle isolé réussi.",
        "metrics": {"cacheHit": cache_hit, "workspaceSlug": workspace_slug},
    }


def cleanup_workspace(container_name: str) -> dict[str, Any]:
    subprocess.run(
        ["docker", "rm", "-f", container_name],
        capture_output=True, text=True, timeout=30, check=False, shell=False,
    )
    return {"cleaned": True, "container": container_name}
