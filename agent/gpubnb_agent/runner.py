"""Strict runner for the only remotely accepted MVP workload."""
from __future__ import annotations

import re
import subprocess
from typing import Any

PINNED_IMAGE = re.compile(r"^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")


def diagnostic_command(image: str) -> list[str]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit être une image Docker épinglée par digest sha256")
    return [
        "docker", "run", "--rm", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=64", "--memory=512m", "--cpus=1",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", "--gpus=device=0",
        image, "nvidia-smi",
        "--query-gpu=name,uuid,memory.total,driver_version,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]


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
