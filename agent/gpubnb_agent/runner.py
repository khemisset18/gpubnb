"""Strict runner for the only remotely accepted MVP workload."""
from __future__ import annotations

import re
import subprocess
from typing import Any

from .platform_info import gpu_inventory

PINNED_IMAGE = re.compile(r"^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")


def gpu_passthrough_flags() -> list[str]:
    gpus = gpu_inventory()
    if not gpus:
        return []
    vendor = gpus[0].get("gpuVendor", "NVIDIA")
    if vendor == "AMD":
        return ["--device=/dev/kfd", "--device=/dev/dri", "--security-opt=seccomp=unconfined"]
    if vendor == "INTEL":
        return ["--device=/dev/dri", "--security-opt=seccomp=unconfined"]
    return ["--gpus=device=0"]


def gpu_probe_command(image: str) -> list[str]:
    gpus = gpu_inventory()
    vendor = gpus[0].get("gpuVendor", "NVIDIA") if gpus else "NVIDIA"
    base = [
        "docker", "run", "--rm", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=64", "--memory=512m", "--cpus=1",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", *gpu_passthrough_flags(),
    ]
    if vendor == "AMD":
        return [*base, image, "rocm-smi", "--showproductname", "--showmeminfo", "vram", "--json"]
    if vendor == "INTEL":
        return [*base, image, "xpu-smi", "discovery", "-j"]
    return [*base, image, "nvidia-smi", "--query-gpu=name,uuid,memory.total,driver_version,temperature.gpu", "--format=csv,noheader,nounits"]


def diagnostic_command(image: str) -> list[str]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit être une image Docker épinglée par digest sha256")
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
    rows = [line.strip() for line in stdout.splitlines() if line.strip()]
    return {
        "gpuDetected": bool(rows),
        "summary": "Diagnostic GPU isolé terminé." if rows else "Aucun GPU détecté dans le conteneur.",
        "metrics": {"gpuCount": len(rows), "nvidiaSmi": " | ".join(rows)[:4000]},
    }


def workspace_health_command(image: str, workspace_slug: str) -> list[str]:
    base = [
        "docker", "run", "--rm", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=64", "--memory=512m", "--cpus=1",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", *gpu_passthrough_flags(),
    ]
    if workspace_slug == "developer":
        return [*base, "--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", image]
    if workspace_slug == "developer":
        return [*base, "--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", image]
    return gpu_probe_command(image)


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
