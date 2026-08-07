"""Strict runner for the only remotely accepted MVP workload."""
from __future__ import annotations

import json
import re
import subprocess
import uuid
from typing import Any, Callable

from .platform_info import gpu_inventory

PINNED_IMAGE = re.compile(r"^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")
OFFICIAL_DIAGNOSTIC_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpu-diagnostic@sha256:[a-f0-9]{64}$")
OFFICIAL_GPU_PROOF_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpu-proof-workspace@sha256:[a-f0-9]{64}$")


def _gpu_vendor() -> str:
    gpus = gpu_inventory()
    return str(gpus[0].get("gpuVendor", "NVIDIA")).upper() if gpus else "NVIDIA"


def gpu_passthrough_flags() -> list[str]:
    vendor = _gpu_vendor()
    if vendor == "AMD":
        return ["--device=/dev/kfd", "--device=/dev/dri"]
    if vendor == "INTEL":
        return ["--device=/dev/dri"]
    return ["--gpus=device=0", "--env=NVIDIA_DRIVER_CAPABILITIES=utility"]


def _hardened_container_base(image: str, container_name: str | None = None) -> list[str]:
    command = [
        "docker", "run", "--rm", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pids-limit=32", "--memory=128m", "--cpus=0.5",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=8m",
    ]
    if container_name:
        command.extend(["--name", container_name])
    return [*command, *gpu_passthrough_flags(), image]


def gpu_probe_command(image: str, container_name: str | None = None) -> list[str]:
    if _gpu_vendor() != "NVIDIA":
        raise RuntimeError("official_gpu_diagnostic_supports_nvidia_only")
    return _hardened_container_base(image, container_name)


def diagnostic_command(image: str, container_name: str | None = None) -> list[str]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit être une image Docker épinglée par digest sha256")
    if not OFFICIAL_DIAGNOSTIC_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit utiliser l'image officielle ghcr.io/khemisset18/gpu-diagnostic épinglée par digest")
    return gpu_probe_command(image, container_name)


def _bounded_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"diagnostic_invalid_{name}")
    if value < minimum or value > maximum:
        raise RuntimeError(f"diagnostic_invalid_{name}")
    return value


def _parse_report(stdout: str) -> list[dict[str, object]]:
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("diagnostic_invalid_json") from exc
    if not isinstance(report, dict) or report.get("schemaVersion") != 1 or report.get("vendor") != "NVIDIA":
        raise RuntimeError("diagnostic_invalid_schema")
    gpus = report.get("gpus")
    if not isinstance(gpus, list) or len(gpus) > 16:
        raise RuntimeError("diagnostic_invalid_gpu_list")
    declared_count = _bounded_int(report.get("gpuCount"), "gpu_count", 0, 16)
    if declared_count != len(gpus):
        raise RuntimeError("diagnostic_gpu_count_mismatch")
    safe_gpus: list[dict[str, object]] = []
    seen_uuids: set[str] = set()
    for expected_index, gpu in enumerate(gpus):
        if not isinstance(gpu, dict):
            raise RuntimeError("diagnostic_invalid_gpu_entry")
        index = _bounded_int(gpu.get("index"), "gpu_index", 0, 15)
        if index != expected_index:
            raise RuntimeError("diagnostic_invalid_gpu_index")
        name = gpu.get("name")
        gpu_uuid = gpu.get("uuid")
        if not isinstance(name, str) or not 1 <= len(name) <= 200:
            raise RuntimeError("diagnostic_invalid_gpu_name")
        if not isinstance(gpu_uuid, str) or not 1 <= len(gpu_uuid) <= 200 or gpu_uuid in seen_uuids:
            raise RuntimeError("diagnostic_invalid_gpu_uuid")
        seen_uuids.add(gpu_uuid)
        total = _bounded_int(gpu.get("memoryTotalMiB"), "memory_total", 1, 2_000_000)
        used = _bounded_int(gpu.get("memoryUsedMiB"), "memory_used", 0, total)
        temperature = _bounded_int(gpu.get("temperatureC"), "temperature", 0, 130)
        safe_gpus.append({
            "index": index,
            "name": name,
            "uuid": gpu_uuid,
            "memoryTotalMiB": total,
            "memoryUsedMiB": used,
            "temperatureC": temperature,
        })
    return safe_gpus


def _pull_image(image: str, timeout: int) -> bool:
    inspect = subprocess.run(
        ["docker", "image", "inspect", image],
        capture_output=True, text=True, timeout=30, check=False, shell=False,
    )
    cache_hit = inspect.returncode == 0
    pull = subprocess.run(
        ["docker", "pull", image],
        capture_output=True, text=True, timeout=timeout, check=False, shell=False,
    )
    if pull.returncode != 0:
        raise RuntimeError(f"diagnostic_image_pull_failed:{pull.returncode}:{pull.stderr[:1000].strip()}")
    return cache_hit


def run_gpu_diagnostic(image: str, timeout_seconds: int) -> dict[str, Any]:
    diagnostic_command(image)
    timeout = max(30, min(600, int(timeout_seconds)))
    container_name = f"gpubnb-diagnostic-{uuid.uuid4().hex[:12]}"
    cache_hit = _pull_image(image, timeout)
    try:
        try:
            result = subprocess.run(
                diagnostic_command(image, container_name), capture_output=True, text=True,
                timeout=timeout, check=False, shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("diagnostic_timeout") from exc
        stdout = result.stdout[:64_000].strip()
        stderr = result.stderr[:4_000].strip()
        if result.returncode != 0:
            raise RuntimeError(f"diagnostic_container_failed:{result.returncode}:{stderr}")
        safe_gpus = _parse_report(stdout)
        first_gpu = safe_gpus[0] if safe_gpus else None
        report = {
            "gpuDetected": bool(safe_gpus),
            "summary": "Diagnostic GPU officiel terminé." if safe_gpus else "Aucun GPU détecté dans le conteneur.",
            "metrics": {
                # The API stores metrics as a flat map of scalars — no nested arrays/objects.
                "gpuCount": len(safe_gpus), "vendor": "NVIDIA", "imageCacheHit": cache_hit,
                **({
                    "firstGpuName": first_gpu["name"], "firstGpuUuid": first_gpu["uuid"],
                    "firstGpuMemoryTotalMiB": first_gpu["memoryTotalMiB"],
                    "firstGpuMemoryUsedMiB": first_gpu["memoryUsedMiB"],
                    "firstGpuTemperatureC": first_gpu["temperatureC"],
                } if first_gpu else {}),
            },
        }
    except Exception:
        cleanup_workspace(container_name)
        raise

    cleanup = cleanup_workspace(container_name)
    if not cleanup["cleaned"]:
        raise RuntimeError("diagnostic_cleanup_unverified")
    report["metrics"]["containerCleaned"] = True
    return report


def gpu_proof_command(image: str, duration_seconds: int, container_name: str) -> list[str]:
    if not OFFICIAL_GPU_PROOF_IMAGE.fullmatch(image):
        raise RuntimeError("gpu_proof_image_not_official_or_pinned")
    duration = max(30, min(600, int(duration_seconds)))
    return [
        "docker", "run", "--rm", "--name", container_name,
        "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--pids-limit=64",
        "--memory=512m", "--cpus=1", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--gpus=device=0", "--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        image, "--duration-seconds", str(duration),
    ]


def run_gpu_proof_workspace(
    image: str,
    duration_seconds: int,
    on_sample: Callable[[dict[str, int]], None] | None = None,
) -> dict[str, Any]:
    duration = max(30, min(600, int(duration_seconds)))
    container_name = f"gpubnb-proof-{uuid.uuid4().hex[:12]}"
    _pull_image(image, min(600, duration + 120))
    process: subprocess.Popen[str] | None = None
    final: dict[str, Any] | None = None
    try:
        process = subprocess.Popen(
            gpu_proof_command(image, duration, container_name),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, shell=False,
        )
        if process.stdout is None:
            raise RuntimeError("gpu_proof_stdout_unavailable")
        for raw_line in process.stdout:
            if len(raw_line) > 4096:
                raise RuntimeError("gpu_proof_output_too_large")
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise RuntimeError("gpu_proof_invalid_json") from exc
            if not isinstance(event, dict) or event.get("schemaVersion") != 1:
                raise RuntimeError("gpu_proof_invalid_schema")
            if event.get("type") == "sample":
                sample = {
                    "elapsedSeconds": _bounded_int(event.get("elapsedSeconds"), "elapsed", 1, 600),
                    "iterations": _bounded_int(event.get("iterations"), "iterations", 1, 10_000_000_000),
                }
                if on_sample is not None:
                    on_sample(sample)
            elif event.get("type") == "result":
                device = event.get("device")
                if not isinstance(device, str) or not 1 <= len(device) <= 120:
                    raise RuntimeError("gpu_proof_invalid_device")
                final = {
                    "gpuDetected": event.get("gpuDetected") is True,
                    "summary": "Calcul CUDA GPU Proof terminé et nettoyé.",
                    "metrics": {
                        "durationSeconds": _bounded_int(event.get("durationSeconds"), "duration", 30, 600),
                        "iterations": _bounded_int(event.get("iterations"), "iterations", 1, 10_000_000_000),
                        "device": device,
                    },
                }
            else:
                raise RuntimeError("gpu_proof_unknown_event")
        stderr = process.stderr.read(4000) if process.stderr is not None else ""
        code = process.wait(timeout=30)
        if code != 0:
            raise RuntimeError(f"gpu_proof_failed:{code}:{stderr.strip()}")
        if final is None or not final["gpuDetected"]:
            raise RuntimeError("gpu_proof_result_missing")
    except Exception:
        if process is not None and process.poll() is None:
            process.kill()
        cleanup_workspace(container_name)
        raise
    cleanup = cleanup_workspace(container_name)
    if not cleanup["cleaned"]:
        raise RuntimeError("gpu_proof_cleanup_unverified")
    final["metrics"]["containerCleaned"] = True
    return final


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
    cache_hit = _pull_image(image, timeout)
    health = subprocess.run(
        workspace_health_command(image, workspace_slug),
        capture_output=True, text=True, timeout=timeout, check=False, shell=False,
    )
    if health.returncode != 0:
        raise RuntimeError(f"workspace_health_check_failed:{health.returncode}:{health.stderr[:1000].strip()}")
    detected_gpus = gpu_inventory()
    return {
        "gpuDetected": bool(detected_gpus),
        "summary": f"Workspace {workspace_slug} préparé et contrôle isolé réussi.",
        "metrics": {
            "cacheHit": cache_hit,
            "workspaceSlug": workspace_slug,
            "gpuCount": len(detected_gpus),
        },
    }


def verify_protection_profile(image: str) -> dict[str, bool]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("protection_image_must_be_digest_pinned")

    container_name = f"gpubnb-protection-probe-{uuid.uuid4().hex[:12]}"
    create = subprocess.run(
        [
            "docker", "create", "--name", container_name,
            "--network=none", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--pids-limit=32",
            "--memory=128m", "--cpus=0.5",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=8m", image,
        ],
        capture_output=True, text=True, timeout=30, check=False, shell=False,
    )
    if create.returncode != 0:
        raise RuntimeError(
            f"protection_probe_create_failed:{create.returncode}:{create.stderr[:1000].strip()}"
        )

    try:
        inspection = subprocess.run(
            ["docker", "inspect", container_name],
            capture_output=True, text=True, timeout=30, check=False, shell=False,
        )
        if inspection.returncode != 0:
            raise RuntimeError("protection_probe_inspect_failed")
        try:
            records = json.loads(inspection.stdout)
            record = records[0]
            host_config = record["HostConfig"]
            mounts = record.get("Mounts") or []
        except (json.JSONDecodeError, IndexError, KeyError, TypeError) as exc:
            raise RuntimeError("protection_probe_invalid_inspection") from exc

        isolation = (
            host_config.get("ReadonlyRootfs") is True
            and "ALL" in (host_config.get("CapDrop") or [])
            and "no-new-privileges" in (host_config.get("SecurityOpt") or [])
        )
        storage = (
            not (host_config.get("Binds") or [])
            and all(mount.get("Type") != "bind" for mount in mounts if isinstance(mount, dict))
            and "/tmp" in (host_config.get("Tmpfs") or {})
        )
        network = host_config.get("NetworkMode") == "none"
    finally:
        cleanup = cleanup_workspace(container_name)

    if not cleanup["cleaned"]:
        raise RuntimeError("protection_probe_cleanup_unverified")
    if not (isolation and storage and network):
        raise RuntimeError("protection_profile_not_enforced")
    return {
        "isolationVerified": isolation,
        "storageProtected": storage,
        "networkFiltered": network,
        "cleanupVerified": True,
    }


def cleanup_workspace(container_name: str) -> dict[str, Any]:
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "", container_name)[:128]
    if not safe_name:
        return {"cleaned": False, "container": ""}
    try:
        removal = subprocess.run(
            ["docker", "rm", "-f", safe_name],
            capture_output=True, text=True, timeout=30, check=False, shell=False,
        )
        remaining = subprocess.run(
            [
                "docker", "container", "ls", "-a",
                "--filter", f"name=^/{safe_name}$",
                "--format", "{{.ID}}",
            ],
            capture_output=True, text=True, timeout=30, check=False, shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {"cleaned": False, "container": safe_name}

    cleaned = remaining.returncode == 0 and not remaining.stdout.strip()
    return {
        "cleaned": cleaned,
        "container": safe_name,
        "removalExitCode": removal.returncode,
        "verificationExitCode": remaining.returncode,
    }
