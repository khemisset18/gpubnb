"""Strict runner for the only remotely accepted MVP workload."""
from __future__ import annotations

import json
import re
import subprocess
import threading
import time
import uuid
from typing import Any, Callable

from .platform_info import gpu_inventory

PINNED_IMAGE = re.compile(r"^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")
OFFICIAL_DIAGNOSTIC_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpu-diagnostic@sha256:[a-f0-9]{64}$")
OFFICIAL_GPU_PROOF_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpu-proof-workspace@sha256:[a-f0-9]{64}$")
# Mirrors gpu_resource_supervisor.SAFE_GPU_ID. Duplicated (not imported) to avoid a
# circular import: gpu_resource_supervisor -> execution_control -> workspace_gateway
# -> runner.
SAFE_GPU_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")
_IMAGE_PULL_LOCK = threading.Lock()
PROGRESS_INTERVAL_SECONDS = 5.0
GPU_PROOF_IMAGE_PULL_TIMEOUT_SECONDS = 1200
DEVELOPER_HOME_TMPFS = "--tmpfs=/home/coder:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700"
# jupyter/docker-stacks images run as the non-root "jovyan" user (uid/gid 1000).
DATA_HOME_TMPFS = "--tmpfs=/home/jovyan:rw,nosuid,size=512m,uid=1000,gid=100,mode=0700"
# Verifies the interpreter the real workspace container runs under can actually
# import the tools the manifest promises (Python/data-science stack). Kept as an
# inline script (not a baked-in health binary like Developer's) because Data
# Workspace uses the official upstream image directly - see runtime_images.py.
DATA_WORKSPACE_HEALTHCHECK_SCRIPT = (
    "import os; "
    "import jupyterlab, notebook, pandas, numpy, scipy, sklearn; "
    "os.makedirs('/home/jovyan/work', exist_ok=True); "
    "open('/home/jovyan/work/.gpubnb-healthcheck', 'w').close(); "
    "print('gpubnb_data_workspace_ok')"
)
# Unlike Data, this must prove CUDA is actually usable from inside the
# container, not just that the packages import - a container that starts
# but can't see the GPU is exactly the failure this workspace exists to rule
# out before a renter is billed for it.
AI_WORKSPACE_HEALTHCHECK_SCRIPT = (
    "import os; "
    "import jupyterlab, torch; "
    "assert torch.cuda.is_available(), 'cuda_not_available_in_container'; "
    "assert torch.cuda.device_count() >= 1, 'no_cuda_device_visible'; "
    "os.makedirs('/home/jovyan/work', exist_ok=True); "
    "open('/home/jovyan/work/.gpubnb-healthcheck', 'w').close(); "
    "print('gpubnb_ai_workspace_ok', torch.cuda.get_device_name(0))"
)
# Runs a real (tiny, discarded) hardware encode rather than only checking that
# h264_nvenc is registered as a codec: confirmed live that ffmpeg registers
# h264_nvenc either way, but it only actually *works* with
# NVIDIA_DRIVER_CAPABILITIES including "video" (without it: "Cannot load
# libnvidia-encode.so.1", a clean failure, not a silent software fallback) -
# this healthcheck is what would have caught that misconfiguration before a
# renter is billed for a workspace whose GPU encoding doesn't actually work.
VIDEO_WORKSPACE_HEALTHCHECK_SCRIPT = (
    "set -e; "
    "mkdir -p /home/jovyan/work && touch /home/jovyan/work/.gpubnb-healthcheck; "
    "ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=10 "
    "-c:v h264_nvenc -preset p1 -f null - >/tmp/gpubnb-nvenc-check.log 2>&1; "
    "echo gpubnb_video_workspace_ok"
)
# No GPU involved (audio DSP has no hardware-codec equivalent to NVENC) -
# runs a real (tiny, discarded) loudnorm pass, not just a filter-list check,
# proving the ffmpeg build can actually process audio, not merely that the
# filter is registered.
AUDIO_WORKSPACE_HEALTHCHECK_SCRIPT = (
    "set -e; "
    "mkdir -p /home/jovyan/work && touch /home/jovyan/work/.gpubnb-healthcheck; "
    "ffmpeg -y -f lavfi -i sine=frequency=440:duration=1 "
    "-af loudnorm=I=-16:LRA=11:TP=-1.5 -f null - >/tmp/gpubnb-audio-check.log 2>&1; "
    "echo gpubnb_audio_workspace_ok"
)


def _gpu_vendor() -> str:
    gpus = gpu_inventory()
    return str(gpus[0].get("gpuVendor", "NVIDIA")).upper() if gpus else "NVIDIA"


def gpu_passthrough_flags(nvidia_capabilities: str = "utility") -> list[str]:
    vendor = _gpu_vendor()
    if vendor == "AMD":
        return ["--device=/dev/kfd", "--device=/dev/dri"]
    if vendor == "INTEL":
        return ["--device=/dev/dri"]
    return ["--gpus=device=0", f"--env=NVIDIA_DRIVER_CAPABILITIES={nvidia_capabilities}"]


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


def _pull_image(
    image: str,
    timeout: int,
    progress_callback: Callable[[str, int], None] | None = None,
) -> bool:
    # Digest-pinned images are content-addressed and immutable. If Docker can inspect
    # this exact reference, re-pulling it adds latency without adding security. A
    # process-wide lock also prevents heartbeat prewarming and a renter job from
    # downloading the same layers concurrently.
    started = time.monotonic()

    def progress(step: str) -> None:
        if progress_callback is not None:
            progress_callback(step, max(0, round(time.monotonic() - started)))

    progress("WAITING_FOR_IMAGE_PULL")
    while not _IMAGE_PULL_LOCK.acquire(timeout=PROGRESS_INTERVAL_SECONDS):
        # Prewarming and a renter job can legitimately target the same image. The
        # renter job stays observable and fresh while it waits for that one shared
        # download instead of looking abandoned to the API.
        progress("WAITING_FOR_IMAGE_PULL")
    try:
        progress("CHECKING_IMAGE_CACHE")
        inspect = subprocess.run(
            ["docker", "image", "inspect", image],
            capture_output=True, text=True, timeout=30, check=False, shell=False,
        )
        if inspect.returncode == 0:
            progress("IMAGE_CACHE_READY")
            return True
        pull_finished = threading.Event()

        def report_pull_progress() -> None:
            while not pull_finished.wait(PROGRESS_INTERVAL_SECONDS):
                progress("PULLING_IMAGE")

        progress("PULLING_IMAGE")
        reporter = threading.Thread(
            target=report_pull_progress,
            name="gpubnb-image-pull-progress",
            daemon=True,
        )
        reporter.start()
        try:
            pull = subprocess.run(
                ["docker", "pull", image],
                capture_output=True, text=True, timeout=timeout, check=False, shell=False,
            )
        finally:
            pull_finished.set()
            reporter.join(timeout=1)
        if pull.returncode != 0:
            raise RuntimeError(f"diagnostic_image_pull_failed:{pull.returncode}:{pull.stderr[:1000].strip()}")
        progress("VERIFYING_IMAGE_DIGEST")
        verify = subprocess.run(
            ["docker", "image", "inspect", image],
            capture_output=True, text=True, timeout=30, check=False, shell=False,
        )
        if verify.returncode != 0:
            raise RuntimeError("diagnostic_image_digest_verification_failed")
        progress("IMAGE_CACHE_READY")
        return False
    finally:
        _IMAGE_PULL_LOCK.release()


def prewarm_workspace_image(
    image: str,
    timeout_seconds: int = 1200,
    progress_callback: Callable[[str, int], None] | None = None,
) -> dict[str, Any]:
    """Fetch an official immutable Workspace image before a renter needs it."""
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("workspace_prewarm_requires_digest_pinned_image")
    if not image.startswith("ghcr.io/khemisset18/gpubnb-"):
        raise RuntimeError("workspace_prewarm_requires_official_image")
    cache_hit = _pull_image(
        image,
        max(30, min(1800, int(timeout_seconds))),
        progress_callback,
    )
    return {"image": image, "cacheHit": cache_hit, "ready": True}


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


def gpu_proof_command(image: str, duration_seconds: int, container_name: str, gpu_uuid: str) -> list[str]:
    if not OFFICIAL_GPU_PROOF_IMAGE.fullmatch(image):
        raise RuntimeError("gpu_proof_image_not_official_or_pinned")
    # gpu_uuid must be the exact hardware UUID the rental resource authority leased
    # for this session (see resolve_session_gpu_uuids). A renter-billed GPU_PROOF
    # workload must never fall back to a fixed Docker device index: on a multi-GPU
    # host that would silently attach whichever physical GPU happens to be index 0,
    # regardless of which accelerator the renter actually booked and paid for.
    if not SAFE_GPU_ID.fullmatch(gpu_uuid):
        raise RuntimeError("gpu_proof_invalid_target_gpu")
    duration = max(30, min(600, int(duration_seconds)))
    return [
        "docker", "run", "--rm", "--name", container_name,
        "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--pids-limit=64",
        "--memory=512m", "--cpus=1", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        f"--gpus=device={gpu_uuid}", "--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        image, "--duration-seconds", str(duration),
    ]


def run_gpu_proof_workspace(
    image: str,
    duration_seconds: int,
    gpu_uuid: str,
    on_sample: Callable[[dict[str, int]], None] | None = None,
) -> dict[str, Any]:
    duration = max(30, min(600, int(duration_seconds)))
    container_name = f"gpubnb-proof-{uuid.uuid4().hex[:12]}"
    _pull_image(image, GPU_PROOF_IMAGE_PULL_TIMEOUT_SECONDS)
    process: subprocess.Popen[str] | None = None
    final: dict[str, Any] | None = None
    try:
        process = subprocess.Popen(
            gpu_proof_command(image, duration, container_name, gpu_uuid),
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


def workspace_health_command(image: str, workspace_slug: str, gpu_uuid: str | None = None) -> list[str]:
    if workspace_slug == "developer":
        # Renter-billed, like GPU_PROOF: must attach the exact hardwareUuid the
        # rental resource authority leased for this session (resolved by the
        # caller in cli.py, the same way run_gpu_proof_workspace's gpu_uuid is).
        # Never fall back to gpu_passthrough_flags()'s device=0 here - on a
        # multi-GPU host that would silently verify (and, if this healthcheck
        # command were ever reused for the live container, serve) whichever
        # physical GPU happens to be index 0, regardless of which accelerator
        # the renter actually booked and paid for.
        if not SAFE_GPU_ID.fullmatch(gpu_uuid or ""):
            raise RuntimeError("developer_workspace_invalid_target_gpu")
        base = [
            "docker", "run", "--rm", "--network=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=512m", "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
            # code-server writes its configuration below $HOME even for --version.
            # The real Developer runtime mounts this same owner-only tmpfs because
            # the container root is read-only. Keep preparation identical so it
            # verifies the production storage profile instead of failing on the
            # immutable image layer or relying on a host home-directory bind.
            DEVELOPER_HOME_TMPFS,
            # The manifest declares /workspace as writable (workspaces/developer/manifest.json
            # writablePaths), and the healthcheck requires it, but --read-only otherwise locks
            # the whole image layer including the baked-in /workspace directory. A tmpfs here —
            # not a host bind, so it satisfies the "no owner home mount" requirement — is what
            # actually makes that manifest promise true instead of failing every run.
            #
            # Docker's tmpfs defaults to root:root mode 0700 when uid/gid/mode aren't given,
            # which the image's own non-root "coder" user (uid/gid 1000, matching the
            # codercom/code-server base image) can't write to either — confirmed against the
            # published image, where the healthcheck failed on `test -w /workspace` even with
            # the tmpfs mounted. Pin the tmpfs to that same uid/gid so it's actually usable.
            "--tmpfs=/workspace:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700",
            f"--gpus=device={gpu_uuid}", "--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        ]
        return [*base, "--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", image]
    if workspace_slug == "ai":
        # Same exact-GPU-UUID rationale as Developer above (renter-billed,
        # never guess device=0 on a multi-GPU host).
        if not SAFE_GPU_ID.fullmatch(gpu_uuid or ""):
            raise RuntimeError("ai_workspace_invalid_target_gpu")
        return [
            "docker", "run", "--rm", "--network=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=2g", "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
            DATA_HOME_TMPFS,
            f"--gpus=device={gpu_uuid}", "--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility",
            "--entrypoint", "python3", image,
            "-c", AI_WORKSPACE_HEALTHCHECK_SCRIPT,
        ]
    if workspace_slug == "video":
        # Same exact-GPU-UUID rationale as Developer/AI above.
        if not SAFE_GPU_ID.fullmatch(gpu_uuid or ""):
            raise RuntimeError("video_workspace_invalid_target_gpu")
        return [
            "docker", "run", "--rm", "--network=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=1g", "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=128m",
            DATA_HOME_TMPFS,
            # NVENC needs the "video" driver capability, not just
            # compute,utility - without it ffmpeg fails closed
            # ("Cannot load libnvidia-encode.so.1"), confirmed live.
            f"--gpus=device={gpu_uuid}", "--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility,video",
            "--entrypoint", "bash", image,
            "-c", VIDEO_WORKSPACE_HEALTHCHECK_SCRIPT,
        ]
    if workspace_slug == "data":
        return [
            "docker", "run", "--rm", "--network=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=1g", "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
            # The real runtime mounts a persistent volume at /home/jovyan/work
            # (see workspace_gateway.py); the image bakes that directory in as
            # jovyan:users already, so a plain tmpfs here (no separate mount
            # needed for the nested path) exercises the same writability the
            # manifest promises without needing a throwaway volume just for
            # this check.
            DATA_HOME_TMPFS,
            "--entrypoint", "python3", image,
            "-c", DATA_WORKSPACE_HEALTHCHECK_SCRIPT,
        ]
    if workspace_slug == "audio":
        # No GPU: no exact-UUID requirement, unlike Developer/AI/Video.
        return [
            "docker", "run", "--rm", "--network=none", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=1g", "--cpus=1",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
            DATA_HOME_TMPFS,
            "--entrypoint", "bash", image,
            "-c", AUDIO_WORKSPACE_HEALTHCHECK_SCRIPT,
        ]
    return diagnostic_command(image)


def prepare_workspace(
    image: str,
    timeout_seconds: int,
    workspace_slug: str = "compute",
    progress_callback: Callable[[str, int], None] | None = None,
    gpu_uuid: str | None = None,
) -> dict[str, Any]:
    if not PINNED_IMAGE.fullmatch(image):
        raise RuntimeError("diagnosticImage doit être une image Docker épinglée par digest sha256")
    started = time.monotonic()
    # Both real workspace images (code-server, and the multi-gigabyte Jupyter
    # data-science stack) are far larger than the diagnostic/GPU-proof images
    # this default otherwise guards; give both the same extended pull budget.
    timeout_limit = 1800 if workspace_slug in {"developer", "data", "ai", "video", "audio"} else 600
    timeout = max(30, min(timeout_limit, int(timeout_seconds)))
    cache_hit = _pull_image(image, timeout, progress_callback)
    health_finished = threading.Event()

    def report_health_progress() -> None:
        while not health_finished.wait(PROGRESS_INTERVAL_SECONDS):
            if progress_callback is not None:
                progress_callback(
                    "VERIFYING_WORKSPACE",
                    max(0, round(time.monotonic() - started)),
                )

    if progress_callback is not None:
        progress_callback("VERIFYING_WORKSPACE", max(0, round(time.monotonic() - started)))
        health_reporter = threading.Thread(
            target=report_health_progress,
            name="gpubnb-workspace-health-progress",
            daemon=True,
        )
        health_reporter.start()
    else:
        health_reporter = None
    try:
        health = subprocess.run(
            workspace_health_command(image, workspace_slug, gpu_uuid),
            capture_output=True, text=True, timeout=timeout, check=False, shell=False,
        )
    finally:
        health_finished.set()
        if health_reporter is not None:
            health_reporter.join(timeout=1)
    if health.returncode != 0:
        raise RuntimeError(f"workspace_health_check_failed:{health.returncode}:{health.stderr[:1000].strip()}")
    if progress_callback is not None:
        progress_callback("WORKSPACE_VERIFIED", max(0, round(time.monotonic() - started)))
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
