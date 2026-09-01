"""Beginner-friendly GPUbnb Agent CLI."""
from __future__ import annotations

import argparse
import codecs
import json
import os
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .client import ApiClient, agent_request, heartbeat
from .gpu_rental_preemption import (
    TRANSIENT_QUIESCENCE_REASONS,
    parse_rental_authority_sessions,
    resolve_session_resources,
)
from .runner import (
    cleanup_workspace,
    gpu_proof_command,
    prepare_workspace,
    prewarm_workspace_image,
    run_gpu_diagnostic,
    run_gpu_proof_workspace,
    verify_protection_profile,
)
DIAGNOSTIC_RUN_TIMEOUT_SECONDS = 120
from .platform_info import find_nvidia_smi, find_rocm_smi, find_xpu_smi, gpu_inventory, system_inventory
from .storage import (
    config_dir, fingerprint, generate_key, key_path, load_config, load_key,
    log_path, pid_path, public_key, save_config,
)
from .runtime_images import DEFAULT_DEVELOPER_IMAGE, workspace_image

DEFAULT_API = "https://gpubnb.netlify.app/api"

# The spawned daemon must load config/key, resolve its workspace image, and start
# its background threads before it writes its own pid record - and on Windows,
# each confirmation poll below verifies that pid via a real `Get-CimInstance`
# PowerShell subprocess (~0.3-1.5s per call depending on system load). A 5-second
# budget was measured to fail intermittently on an otherwise-healthy machine
# under ordinary load (e.g. right after other Docker/npm activity); 20s gives
# enough margin for a handful of slow polls without masking a genuinely hung
# child (which still fails fast via `process.poll()`).
DAEMON_START_CONFIRM_TIMEOUT_SECONDS = 20

# Human-readable explanations for the quiescence-probe reasons that
# gpu_rental_preemption.py treats as transient (see TRANSIENT_QUIESCENCE_REASONS):
# these retry automatically, so the log should say so instead of surfacing a bare
# exception name. Anything not listed here (fencing conflicts, miner identity
# mismatches, tooling failures) keeps the raw message - those are not retried
# silently and deserve an operator's attention.
_GATEWAY_ERROR_EXPLANATIONS: dict[str, str] = {
    "rental_gpu_compute_processes_present": (
        "GPU rental startup delayed: another program on this machine is currently "
        "using the GPU. Retrying automatically once it is free."
    ),
    "rental_gpu_utilization_not_quiescent": (
        "GPU rental startup delayed: GPU utilization has not settled yet. "
        "Retrying automatically."
    ),
    "rental_gpu_memory_not_quiescent": (
        "GPU rental startup delayed: GPU memory is still occupied by another "
        "process. Retrying automatically once it is released."
    ),
}
assert set(_GATEWAY_ERROR_EXPLANATIONS) == set(TRANSIENT_QUIESCENCE_REASONS)


def print_json(value: Any) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    buffer = getattr(sys.stdout, "buffer", None)
    if buffer is not None:
        buffer.write(payload.encode("utf-8", errors="replace"))
        buffer.write(b"\n")
        buffer.flush()
    else:
        print(payload, flush=True)


def client(config: dict[str, Any]) -> ApiClient:
    return ApiClient(str(config.get("apiUrl") or DEFAULT_API), config.get("caFile"))


def command_setup(args: argparse.Namespace) -> int:
    directory = config_dir()
    key_existed = key_path().exists()
    key = generate_key()
    config = load_config()
    config.update({"apiUrl": args.api_url.rstrip("/"), "intervalSeconds": args.interval})
    workspace_images = config.get("workspaceImages") if isinstance(config.get("workspaceImages"), dict) else {}
    workspace_images.setdefault("developer", DEFAULT_DEVELOPER_IMAGE)
    config["workspaceImages"] = workspace_images
    if args.diagnostic_image:
        config["diagnosticImage"] = args.diagnostic_image
    save_config(config)
    print("GPUbnb Agent est configuré.")
    print(f"Dossier : {directory}")
    print(f"Clé : {'conservée' if key_existed else 'générée'}")
    print(f"Clé publique : {public_key(key)}")
    print(f"Fingerprint : {fingerprint(key)}")
    print("\nÉtape suivante : ouvrez votre espace loueur, créez un code de liaison, puis :")
    print("  gpubnb-agent link CODE")
    print("\nDiagnostic initial :")
    return command_diagnose(args)


def command_login(args: argparse.Namespace) -> int:
    url = args.site.rstrip("/") + "/dashboard.html"
    print(f"Ouverture de votre espace GPUbnb : {url}")
    return 0 if webbrowser.open(url) else 1


def command_link(args: argparse.Namespace) -> int:
    config = load_config()
    key = load_key()
    inventory = {"system": system_inventory(), "gpus": gpu_inventory(), "agentVersion": __version__}
    result = client(config).link(args.code.strip().upper(), public_key(key), inventory)
    machine_id = result.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Réponse de liaison invalide")
    config.update({"machineId": machine_id, "linkedAt": result.get("linkedAt")})
    save_config(config)
    print("Machine liée avec succès.")
    print(f"Machine ID : {machine_id}")
    print("Lancez maintenant : gpubnb-agent start")
    return 0


def command_show_key(_: argparse.Namespace) -> int:
    print(f"Clé publique : {public_key()}")
    print(f"Fingerprint : {fingerprint()}")
    return 0


def command_reset_key(args: argparse.Namespace) -> int:
    if not args.yes:
        print("Cette action invalide la liaison actuelle. Relancez avec --yes pour confirmer.", file=sys.stderr)
        return 2
    key = generate_key(force=True)
    config = load_config()
    config.pop("machineId", None)
    config.pop("linkedAt", None)
    save_config(config)
    print("Nouvelle clé générée. La machine doit être liée à nouveau.")
    print(f"Clé publique : {public_key(key)}")
    print(f"Fingerprint : {fingerprint(key)}")
    return 0


def diagnostic_report() -> dict[str, Any]:
    config = load_config()
    executable = find_nvidia_smi() or find_rocm_smi() or find_xpu_smi()
    system = system_inventory()
    gpus = gpu_inventory(executable)
    api_result: dict[str, Any]
    try:
        api_result = {"reachable": True, **client(config).health()}
    except Exception as exc:
        api_result = {"reachable": False, "error": str(exc)}
    return {
        "agentVersion": __version__,
        "configurationDirectory": str(config_dir()),
        "keyPresent": key_path().exists(),
        "machineLinked": bool(config.get("machineId")),
        "machineId": config.get("machineId"),
        "gpuSmi": executable,
        "gpus": gpus,
        "system": system,
        "api": api_result,
        "readyForHeartbeat": bool(key_path().exists() and config.get("machineId") and len(gpus) == 1 and api_result.get("reachable")),
    }


def command_diagnose(_: argparse.Namespace) -> int:
    report = diagnostic_report()
    print_json(report)
    if report["readyForHeartbeat"]:
        print("\nRésultat : prêt à démarrer.")
        return 0
    print("\nRésultat : configuration incomplète.")
    if not report["gpuSmi"]:
        print("- Utilitaire GPU introuvable : installez nvidia-smi (NVIDIA), rocm-smi (AMD) ou xpu-smi (Intel).")
    if not report["keyPresent"]:
        print("- Exécutez : gpubnb-agent setup")
    if not report["machineLinked"]:
        print("- Créez un code dans l'espace loueur puis exécutez : gpubnb-agent link CODE")
    if not report["api"].get("reachable"):
        print("- Vérifiez Internet, le pare-feu et l'URL API.")
    return 1


def command_api_health(_: argparse.Namespace) -> int:
    config = load_config()
    result = client(config).health()
    print_json({"reachable": True, **result})
    return 0


def command_runtime_check(_: argparse.Namespace) -> int:
    codecs.lookup("idna")
    addresses = socket.getaddrinfo("localhost", 443, type=socket.SOCK_STREAM)
    ssl.create_default_context()
    print_json({
        "idnaCodec": True,
        "dnsResolution": bool(addresses),
        "tlsContext": True,
    })
    return 0


def command_status(_: argparse.Namespace) -> int:
    config = load_config()
    pid = _running_agent_pid()
    service = {"installed": False, "running": False}
    if os.name == "nt":
        from .windows_service import service_status

        service = service_status()
    print_json({
        "running": pid is not None or service["running"],
        "pid": pid,
        "serviceInstalled": service["installed"],
        "serviceRunning": service["running"],
        "machineId": config.get("machineId"),
        "linked": bool(config.get("machineId")),
        "logFile": str(log_path()),
    })
    return 0


def _agent_process_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "_run"]
    return [sys.executable, "-m", "gpubnb_agent", "_run"]


def _process_record() -> dict[str, Any] | None:
    try:
        value = json.loads(pid_path().read_text(encoding="ascii"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(value, dict):
        return None
    pid = value.get("pid")
    executable = value.get("executable")
    mode = value.get("mode")
    if (
        not isinstance(pid, int)
        or pid <= 0
        or not isinstance(executable, str)
        or not executable
        or mode not in {"_run", "_service"}
    ):
        return None
    return {"pid": pid, "executable": executable, "mode": mode}


def _process_matches(pid: int, executable: str, mode: str) -> bool:
    if mode not in {"_run", "_service"}:
        return False
    try:
        if os.name == "nt":
            command = (
                f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}';"
                "if($p){@{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine}"
                "|ConvertTo-Json -Compress}"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if result.returncode != 0 or not result.stdout.strip():
                return False
            process = json.loads(result.stdout)
            actual_executable = str(process.get("ExecutablePath") or "")
            command_line = str(process.get("CommandLine") or "")
            return (
                os.path.normcase(os.path.abspath(actual_executable))
                == os.path.normcase(os.path.abspath(executable))
                and mode in command_line.split()
            )

        executable_path = Path(f"/proc/{pid}/exe")
        command_line_path = Path(f"/proc/{pid}/cmdline")
        if executable_path.exists() and command_line_path.exists():
            actual_executable = str(executable_path.resolve())
            command_line = command_line_path.read_bytes().replace(b"\0", b" ").decode(
                "utf-8", errors="replace"
            )
            return os.path.samefile(actual_executable, executable) and mode in command_line.split()

        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return (
            result.returncode == 0
            and Path(executable).name in result.stdout
            and mode in result.stdout.split()
        )
    except (json.JSONDecodeError, OSError, subprocess.SubprocessError):
        return False


def _running_agent_pid() -> int | None:
    record = _process_record()
    if record and _process_matches(record["pid"], record["executable"], record["mode"]):
        return int(record["pid"])
    return None


def heartbeat_loop(
    stop_event: threading.Event | None = None,
    process_mode: str = "_run",
    event_sink: Callable[[dict[str, Any]], None] | None = None,
) -> int:
    if process_mode not in {"_run", "_service"}:
        raise RuntimeError("invalid_agent_process_mode")
    emit = event_sink or print_json
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Machine non liée. Exécutez : gpubnb-agent link CODE")
    key = load_key()
    interval = max(5, min(60, int(config.get("intervalSeconds", 10))))
    failures = 0
    developer_image = workspace_image(config, "developer")
    job_thread: threading.Thread | None = None
    diagnostic_thread: threading.Thread | None = None

    def gateway_error(exc: Exception) -> None:
        message = str(exc)[:300]
        event: dict[str, Any] = {
            "event": "workspace_gateway_error",
            "type": type(exc).__name__,
            "message": message,
        }
        detail = _GATEWAY_ERROR_EXPLANATIONS.get(message)
        if detail is not None:
            event["detail"] = detail
        emit(event)

    def supervise_gateway() -> None:
        from .workspace_gateway import run_workspace_gateway_forever

        delay = 5
        while stop_event is None or not stop_event.is_set():
            try:
                emit({"event": "workspace_gateway_starting"})
                run_workspace_gateway_forever(
                    stop_event=stop_event,
                    error_callback=gateway_error,
                )
                if stop_event is not None and stop_event.is_set():
                    return
                raise RuntimeError("workspace_gateway_exited")
            except Exception as exc:
                gateway_error(exc)
                if stop_event is not None:
                    if stop_event.wait(delay):
                        return
                else:
                    time.sleep(delay)
                delay = min(60, delay * 2)

    def prewarm() -> None:
        try:
            result = prewarm_workspace_image(
                developer_image,
                progress_callback=lambda step, elapsed: emit({
                    "event": "workspace_image_progress",
                    "step": step,
                    "elapsedSeconds": elapsed,
                }),
            )
            emit({"event": "workspace_image_ready", **result})
        except Exception as exc:
            emit({"event": "workspace_image_prewarm_failed", "message": str(exc)[:300]})

    def poll_and_run_job() -> None:
        try:
            run_next_job(client(config), key, machine_id, config, event_sink=emit)
        except Exception as exc:
            emit({"event": "job_poll_error", "type": type(exc).__name__, "message": str(exc)[:300]})

    def poll_and_run_diagnostic() -> None:
        try:
            poll_and_run_diagnostic_once(client(config), key, machine_id, event_sink=emit)
        except Exception as exc:
            emit({"event": "diagnostic_poll_error", "type": type(exc).__name__, "message": str(exc)[:300]})

    threading.Thread(target=prewarm, name="gpubnb-workspace-prewarm", daemon=True).start()
    threading.Thread(
        target=supervise_gateway,
        name="gpubnb-workspace-gateway",
        daemon=True,
    ).start()
    pid_path().write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "executable": sys.executable,
                "mode": process_mode,
            }
        ),
        encoding="ascii",
    )
    if os.name != "nt":
        pid_path().chmod(0o600)
    try:
        while stop_event is None or not stop_event.is_set():
            try:
                result = heartbeat(client(config), key, machine_id)
                emit({"event": "heartbeat", "result": result})
                if job_thread is None or not job_thread.is_alive():
                    job_thread = threading.Thread(
                        target=poll_and_run_job,
                        name="gpubnb-job-worker",
                        daemon=True,
                    )
                    job_thread.start()
                if diagnostic_thread is None or not diagnostic_thread.is_alive():
                    diagnostic_thread = threading.Thread(
                        target=poll_and_run_diagnostic,
                        name="gpubnb-diagnostic-worker",
                        daemon=True,
                    )
                    diagnostic_thread.start()
                failures = 0
            except Exception as exc:
                failures = min(failures + 1, 8)
                emit({"event": "heartbeat_error", "type": type(exc).__name__, "message": str(exc)[:300]})
            delay = min(300, interval * (2 ** failures)) if failures else interval
            if stop_event is not None:
                stop_event.wait(delay)
            else:
                time.sleep(delay)
    except KeyboardInterrupt:
        print("Agent arrêté.")
        return 0
    finally:
        try:
            pid_path().unlink()
        except FileNotFoundError:
            pass


def resolve_developer_workspace_gpu_uuid(
    api: ApiClient, key: Any, machine_id: str, session_id: str,
) -> str:
    """Resolve the exact hardware UUID the rental resource authority leased for
    this Developer session, before any Docker command runs.

    Mirrors the GPU_PROOF resolution above (same official mechanism: signed
    rental-authority -> parse_rental_authority_sessions -> resolve_session_resources),
    kept as its own function rather than sharing code with the GPU_PROOF path so a
    change here can never affect that already-verified workflow. Fails closed on
    every step - no step here may silently fall back to a fixed device index:
      - rental authority request/parse failure -> propagates (RuntimeError)
      - session absent from the authority or blocked -> rental_resource_authority_missing_for_session / blockedReason
      - more than one leased accelerator -> developer_workspace_requires_exactly_one_accelerator
      - leased UUID not present in this host's own current GPU inventory,
        or present only under a different case/format -> developer_workspace_gpu_uuid_not_found_locally
    """
    authority_payload = agent_request(
        api, key, machine_id, f"/agent/mining/{machine_id}/rental-authority",
    )
    authority = parse_rental_authority_sessions(authority_payload)
    specs = resolve_session_resources(authority, session_id)
    if len(specs) != 1:
        raise RuntimeError("developer_workspace_requires_exactly_one_accelerator")
    gpu_uuid = specs[0].hardware_uuid
    local_uuids = {str(gpu.get("gpuUuid") or "").casefold() for gpu in gpu_inventory()}
    if gpu_uuid.casefold() not in local_uuids:
        raise RuntimeError("developer_workspace_gpu_uuid_not_found_locally")
    return gpu_uuid


def poll_and_run_diagnostic_once(
    api: ApiClient,
    key: Any,
    machine_id: str,
    event_sink: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    """Polls for a server-side DiagnosticRun (created from Host's "Relancer le
    diagnostic" / "Revalider la machine" button, see machine-diagnostics-routes.ts)
    and reports the real result back, signed exactly like every other agent
    request. Deliberately independent of run_next_job's booking-scoped Job
    machinery: this must keep working even while the machine is quarantined
    (moderationStatus != CLEAR), which /agent/jobs/next intentionally does not
    guarantee. Never invents a result - an execution failure here is reported
    as an explicit error, never silently as a passing check.
    """
    emit = event_sink or print_json
    next_path = f"/agent/diagnostics/next/{machine_id}"
    pending = agent_request(api, key, machine_id, next_path)
    diagnostic_run_id = pending.get("diagnosticRunId")
    if not isinstance(diagnostic_run_id, str) or not diagnostic_run_id:
        return
    image = str(pending.get("diagnosticImage") or "")
    timeout_seconds = int(pending.get("timeoutSeconds") or DIAGNOSTIC_RUN_TIMEOUT_SECONDS)
    emit({"event": "quarantine_diagnostic_started", "diagnosticRunId": diagnostic_run_id})
    result_path = f"/agent/diagnostics/{diagnostic_run_id}/result"
    try:
        if not image:
            raise RuntimeError("diagnostic_image_not_configured")
        report = run_gpu_diagnostic(image, timeout_seconds)
        metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
        agent_request(api, key, machine_id, result_path, "POST", {
            "machineId": machine_id,
            "gpuDetected": bool(report.get("gpuDetected")),
            "gpuUuid": metrics.get("firstGpuUuid"),
            "summary": str(report.get("summary") or "")[:2000],
            "metrics": metrics,
        })
        emit({"event": "quarantine_diagnostic_completed", "diagnosticRunId": diagnostic_run_id, "gpuDetected": bool(report.get("gpuDetected"))})
    except Exception as exc:
        agent_request(api, key, machine_id, result_path, "POST", {
            "machineId": machine_id,
            "gpuDetected": False,
            "summary": "",
            "error": str(exc)[:500],
        })
        emit({"event": "quarantine_diagnostic_failed", "diagnosticRunId": diagnostic_run_id, "message": str(exc)[:300]})


def run_next_job(
    api: ApiClient,
    key: Any,
    machine_id: str,
    config: dict[str, Any],
    event_sink: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    emit = event_sink or print_json
    path = f"/agent/jobs/next/{machine_id}"
    job = agent_request(api, key, machine_id, path)
    if not job:
        return
    job_id = str(job["id"])
    attempt_id = job.get("attemptId")
    lease_token = job.get("leaseToken")
    if not isinstance(attempt_id, str) or not attempt_id or not isinstance(lease_token, str) or len(lease_token) < 32:
        raise RuntimeError("job_lease_credentials_missing")
    if job.get("type") not in {"GPU_DIAGNOSTIC", "WORKSPACE_PREPARE", "GPU_PROOF"}:
        update_job(api, key, machine_id, job_id, attempt_id, lease_token, "REJECTED", "unsupported_job_type")
        return
    lease_stop = threading.Event()
    lease_fenced = threading.Event()

    def refresh_job_lease() -> None:
        lease_path = f"/agent/jobs/{job_id}/lease"
        while not lease_stop.wait(10):
            try:
                agent_request(api, key, machine_id, lease_path, "POST", {
                    "machineId": machine_id,
                    "attemptId": attempt_id,
                    "leaseToken": lease_token,
                })
            except Exception as exc:
                if "stale_job_attempt" in str(exc):
                    lease_fenced.set()
                    emit({"event": "job_fenced", "jobId": job_id, "attemptId": attempt_id})
                    return
                emit({
                    "event": "job_lease_refresh_error",
                    "jobId": job_id,
                    "attemptId": attempt_id,
                    "message": str(exc)[:300],
                })

    lease_thread = threading.Thread(
        target=refresh_job_lease,
        name=f"gpubnb-job-lease-{job_id[-8:]}",
        daemon=True,
    )
    parameters = job.get("parameters") if isinstance(job.get("parameters"), dict) else {}
    workspace_slug = str(parameters.get("workspaceSlug") or "compute")
    if job.get("type") == "GPU_DIAGNOSTIC":
        # The official diagnostic image (ghcr.io/khemisset18/gpu-diagnostic) is a
        # separate, minimal image from the Compute workspace's own
        # gpu-proof-workspace image - resolving via workspace_image(config,
        # "compute") here would silently probe with the wrong image and fail
        # diagnostic_command()'s official-image check. The server always sends
        # the real pinned diagnostic image in parameters.diagnosticImage
        # (dev-booking-reconciler.ts); only fall back to local config for a
        # renter-triggered re-run job that predates this parameter.
        image = str(parameters.get("diagnosticImage") or config.get("diagnosticImage") or "")
    else:
        image = workspace_image(config, workspace_slug)
    lease_thread.start()
    try:
        if job.get("type") in {"WORKSPACE_PREPARE", "GPU_PROOF"}:
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "DOWNLOADING")
        else:
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "PREPARING")
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "RUNNING")
        if job.get("type") == "GPU_PROOF":
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "PREPARING")
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "RUNNING")
            if not isinstance(session_value := job.get("workspaceSession"), dict) or not isinstance(session_value.get("id"), str):
                raise RuntimeError("gpu_proof_session_missing")
            session_id = session_value["id"]
            # Resolve the exact hardware UUID the rental resource authority leased
            # for this session before touching Docker. GPU_PROOF is a renter-billed
            # workload: it must never guess a fixed device index (see runner.py's
            # gpu_proof_command). This fails closed - rental_resource_authority_missing_for_session,
            # a blockedReason such as rental_gpu_resource_mapping_missing, or an
            # empty/ambiguous resource set all abort the job before any container runs.
            authority_payload = agent_request(
                api, key, machine_id, f"/agent/mining/{machine_id}/rental-authority",
            )
            authority = parse_rental_authority_sessions(authority_payload)
            specs = resolve_session_resources(authority, session_id)
            if len(specs) != 1:
                raise RuntimeError("gpu_proof_requires_exactly_one_accelerator")
            gpu_uuid = specs[0].hardware_uuid
            metric_counter = 0
            previous_elapsed = 0

            def publish_sample(sample: dict[str, int]) -> None:
                nonlocal metric_counter, previous_elapsed
                metric_counter += 1
                elapsed = sample["elapsedSeconds"]
                interval = max(1, min(30, elapsed - previous_elapsed))
                previous_elapsed = elapsed
                send_session_metric(api, key, machine_id, session_value["id"], metric_counter, interval)
                control_path = f"/agent/jobs/{job_id}/control"
                control = agent_request(api, key, machine_id, control_path, "POST", {
                    "machineId": machine_id,
                    "attemptId": attempt_id,
                    "leaseToken": lease_token,
                })
                if control.get("cancelRequested") is True:
                    raise RuntimeError("rental_cancel_requested")

            result = run_gpu_proof_workspace(
                image,
                int(parameters.get("durationSeconds", 60)),
                gpu_uuid,
                publish_sample,
            )
        elif job.get("type") == "WORKSPACE_PREPARE":
            developer_gpu_uuid: str | None = None
            if workspace_slug in ("developer", "ai", "video"):
                # AI and Video Workspaces are renter-billed and GPU-compute
                # just like Developer - same rationale, same resolver: never
                # fall back to a fixed device index for a workload the renter
                # is paying for a specific accelerator's worth of.
                if not isinstance(session_value := job.get("workspaceSession"), dict) or not isinstance(session_value.get("id"), str):
                    raise RuntimeError("developer_workspace_session_missing")
                developer_gpu_uuid = resolve_developer_workspace_gpu_uuid(api, key, machine_id, session_value["id"])

            def publish_preparation_progress(step: str, elapsed_seconds: int) -> None:
                if lease_fenced.is_set():
                    raise RuntimeError("stale_job_attempt")
                try:
                    report_job_progress(
                        api,
                        key,
                        machine_id,
                        job_id,
                        attempt_id,
                        lease_token,
                        step,
                        elapsed_seconds,
                    )
                except Exception as exc:
                    if "stale_job_attempt" in str(exc):
                        lease_fenced.set()
                        raise
                    emit({
                        "event": "job_progress_error",
                        "jobId": job_id,
                        "attemptId": attempt_id,
                        "step": step,
                        "message": str(exc)[:300],
                    })

            result = prepare_workspace(
                image,
                int(parameters.get("timeoutSeconds", 1200)),
                workspace_slug,
                publish_preparation_progress,
                developer_gpu_uuid,
            )
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "PREPARING")
            update_job(api, key, machine_id, job_id, attempt_id, lease_token, "RUNNING")
        else:
            result = run_gpu_diagnostic(image, int(parameters.get("timeoutSeconds", 120)))
        session_value = job.get("workspaceSession")
        if job.get("type") == "GPU_DIAGNOSTIC" and isinstance(session_value, dict) and isinstance(session_value.get("id"), str):
            send_session_metric(api, key, machine_id, session_value["id"], 1, 5)
        update_job(api, key, machine_id, job_id, attempt_id, lease_token, "UPLOADING_RESULTS")
        complete_path = f"/agent/jobs/{job_id}/complete"
        agent_request(api, key, machine_id, complete_path, "POST", {
            "machineId": machine_id,
            "attemptId": attempt_id,
            "leaseToken": lease_token,
            "result": result,
        })
        if job.get("type") == "GPU_PROOF":
            finalize_path = f"/agent/jobs/{job_id}/finalize-proof"
            agent_request(api, key, machine_id, finalize_path, "POST", {
                "machineId": machine_id,
                "attemptId": attempt_id,
                "leaseToken": lease_token,
            })
        emit({"event": "job_completed", "jobId": job_id, "attemptId": attempt_id})
    except Exception as exc:
        if lease_fenced.is_set() or "stale_job_attempt" in str(exc):
            emit({"event": "job_fenced", "jobId": job_id, "attemptId": attempt_id, "message": str(exc)[:300]})
            return
        try:
            cancelled = str(exc) == "rental_cancel_requested"
            update_job(
                api,
                key,
                machine_id,
                job_id,
                attempt_id,
                lease_token,
                "CANCELLED" if cancelled else "FAILED",
                str(exc)[:100],
            )
        finally:
            emit({"event": "job_failed", "jobId": job_id, "attemptId": attempt_id, "message": str(exc)[:300]})
    finally:
        lease_stop.set()
        lease_thread.join(timeout=2)


def update_job(
    api: ApiClient,
    key: Any,
    machine_id: str,
    job_id: str,
    attempt_id: str,
    lease_token: str,
    status: str,
    error_code: str | None = None,
) -> dict[str, Any]:
    path = f"/agent/jobs/{job_id}/state"
    body = {
        "machineId": machine_id,
        "attemptId": attempt_id,
        "leaseToken": lease_token,
        "status": status,
    }
    if error_code:
        body["errorCode"] = error_code
    return agent_request(api, key, machine_id, path, "POST", body)


def report_job_progress(
    api: ApiClient,
    key: Any,
    machine_id: str,
    job_id: str,
    attempt_id: str,
    lease_token: str,
    step: str,
    elapsed_seconds: int,
) -> dict[str, Any]:
    path = f"/agent/jobs/{job_id}/progress"
    return agent_request(api, key, machine_id, path, "POST", {
        "machineId": machine_id,
        "attemptId": attempt_id,
        "leaseToken": lease_token,
        "step": step,
        "elapsedSeconds": max(0, int(elapsed_seconds)),
    })


def send_session_metric(api: ApiClient, key: Any, machine_id: str, session_id: str, counter: int, interval_seconds: int) -> dict[str, Any]:
    system = system_inventory()
    gpus = gpu_inventory()
    gpu = gpus[0] if gpus else {}
    ram_total = int(system.get("ramTotalMiB") or 0)
    ram_available = int(system.get("ramAvailableMiB") or 0)
    disk_total = int(system.get("diskTotalMiB") or 0)
    disk_available = int(system.get("diskAvailableMiB") or 0)
    payload = {
        "machineId": machine_id, "counter": counter,
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "intervalSeconds": interval_seconds, "gpuUtilization": int(gpu.get("gpuUtilization") or 0),
        "memoryUsedMiB": int(gpu.get("memoryUsedMiB") or 0),
        "temperatureC": int(gpu.get("temperatureC") or 0),
        "cpuUtilization": 0, "ramUsedMiB": max(0, ram_total - ram_available),
        "diskUsedMiB": max(0, disk_total - disk_available),
        "networkRxBytes": 0, "networkTxBytes": 0,
        "available": True, "workloadProof": True,
    }
    path = f"/agent/workspace-sessions/{session_id}/metrics"
    return agent_request(api, key, machine_id, path, "POST", payload)


def command_start(args: argparse.Namespace) -> int:
    if args.daemon:
        running_pid = _running_agent_pid()
        if running_pid is not None:
            print(f"Agent déjà démarré (PID {running_pid}).")
            return 0
        handle = open(log_path(), "a", encoding="utf-8")
        try:
            if os.name == "nt":
                flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
                process = subprocess.Popen(
                    _agent_process_command(),
                    stdout=handle,
                    stderr=handle,
                    creationflags=flags,
                    close_fds=True,
                )
            else:
                process = subprocess.Popen(
                    _agent_process_command(),
                    stdout=handle,
                    stderr=handle,
                    start_new_session=True,
                    close_fds=True,
                )
        finally:
            handle.close()
        deadline = time.monotonic() + DAEMON_START_CONFIRM_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if process.poll() is not None:
                print("L'agent n'a pas pu démarrer. Consultez les journaux.", file=sys.stderr)
                return 1
            if _running_agent_pid() == process.pid:
                print(f"Agent démarré en arrière-plan (PID {process.pid}).")
                return 0
            time.sleep(0.05)
        process.terminate()
        process.wait(timeout=5)
        print("Le démarrage de l'agent n'a pas pu être confirmé.", file=sys.stderr)
        return 1
    return heartbeat_loop()


def command_stop(_: argparse.Namespace) -> int:
    pid = _running_agent_pid()
    if pid is None:
        try:
            pid_path().unlink()
        except FileNotFoundError:
            pass
        print("L'agent n'est pas démarré.")
        return 1
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Arrêt demandé au processus {pid}.")
    except ProcessLookupError:
        print("Le processus était déjà arrêté.")
    return 0


def command_benchmark(_: argparse.Namespace) -> int:
    started = time.monotonic()
    gpus = gpu_inventory()
    print_json({"type": "GPU_DIAGNOSTIC_LOCAL", "durationMs": round((time.monotonic() - started) * 1000), "gpus": gpus})
    return 0 if gpus else 1


def command_logs(args: argparse.Namespace) -> int:
    try:
        lines = log_path().read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        print("Aucun journal disponible.")
        return 0
    print("\n".join(lines[-args.lines:]))
    return 0


def command_workspaces_list(_: argparse.Namespace) -> int:
    config = load_config()
    result = client(config).request("/workspaces")
    print_json(result)
    return 0


def command_workspaces_analyze(_: argparse.Namespace) -> int:
    print_json({"system": system_inventory(), "gpus": gpu_inventory(), "note": "L’analyse persistée et l’activation se font depuis l’espace loueur authentifié."})
    return 0


def command_files_upload(args: argparse.Namespace) -> int:
    config = load_config()
    key = load_key()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Machine non liée. Exécutez : gpubnb-agent link CODE")
    file_path = Path(args.path)
    if not file_path.is_file():
        raise RuntimeError(f"Fichier introuvable : {args.path}")
    upload_path = f"/jobs/{args.job_id}/artifacts?machineId={machine_id}&kind={args.kind}"
    import hashlib
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    upload_path += f"&sha256={sha256}&sizeBytes={file_path.stat().st_size}"
    result = client(config).upload_file(upload_path, args.job_id, args.path, key, machine_id, args.kind)
    print_json({"uploaded": True, "jobId": args.job_id, "artifact": result})
    return 0


def command_files_download(args: argparse.Namespace) -> int:
    config = load_config()
    key = load_key()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Machine non liée. Exécutez : gpubnb-agent link CODE")
    output = args.output or f"artifact_{args.artifact_id}"
    download_path = f"/jobs/{args.job_id}/artifacts/{args.artifact_id}"
    result = client(config).download_file(download_path, output, args.sha256)
    print_json({"downloaded": True, "jobId": args.job_id, "artifactId": args.artifact_id, **result})
    return 0


def command_files_list(args: argparse.Namespace) -> int:
    config = load_config()
    key = load_key()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Machine non liée. Exécutez : gpubnb-agent link CODE")
    list_path = f"/jobs/{args.job_id}/artifacts"
    result = agent_request(client(config), key, machine_id, list_path)
    print_json(result)
    return 0


def command_workspace_install(args: argparse.Namespace) -> int:
    config = load_config()
    if args.slug == "compute":
        gpu_proof_command(args.image, 30, "gpubnb-proof-install-check")
        result = verify_protection_profile(args.image)
    else:
        result = prepare_workspace(
            args.image,
            args.timeout,
            args.slug,
            lambda step, elapsed: print_json({
                "event": "workspace_install_progress",
                "slug": args.slug,
                "step": step,
                "elapsedSeconds": elapsed,
            }),
        )
    images = config.get("workspaceImages")
    if not isinstance(images, dict):
        images = {}
    images[args.slug] = args.image
    config["workspaceImages"] = images
    save_config(config)
    print_json({"installed": True, "slug": args.slug, "image": args.image, "verification": result})
    return 0


def command_protections_verify(_: argparse.Namespace) -> int:
    config = load_config()
    workspace_images = config.get("workspaceImages")
    image = workspace_images.get("compute") if isinstance(workspace_images, dict) else None
    image = image or config.get("diagnosticImage")
    if not isinstance(image, str) or not image:
        raise RuntimeError("protection_image_not_configured")
    print_json(verify_protection_profile(image))
    return 0


def command_gpu_processes_list(args: argparse.Namespace) -> int:
    from .gpu_process_release import list_gpu_processes

    hardware_uuid = args.gpu_uuid
    if not hardware_uuid:
        gpus = gpu_inventory()
        if not gpus:
            raise RuntimeError("no_gpu_detected")
        hardware_uuid = gpus[0]["gpuUuid"]
    print_json(list_gpu_processes(hardware_uuid))
    return 0


def command_gpu_processes_close(args: argparse.Namespace) -> int:
    from .gpu_process_release import close_gpu_process

    print_json(close_gpu_process(args.pid))
    return 0


def command_service(args: argparse.Namespace) -> int:
    from .windows_service import manage_service

    return manage_service(args.service_action)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="gpubnb-agent", description="Agent local sécurisé GPUbnb")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("setup", help="préparer la machine et générer la clé")
    setup.add_argument("--api-url", default=DEFAULT_API)
    setup.add_argument("--interval", type=int, default=10)
    setup.add_argument("--diagnostic-image", help="image de diagnostic épinglée, au format registre/image@sha256:...")
    setup.set_defaults(handler=command_setup)
    login = commands.add_parser("login", help="ouvrir l'espace GPUbnb")
    login.add_argument("--site", default="https://gpubnb.netlify.app")
    login.set_defaults(handler=command_login)
    link = commands.add_parser("link", help="lier la machine avec un code temporaire")
    link.add_argument("code")
    link.set_defaults(handler=command_link)
    start = commands.add_parser("start", help="démarrer les heartbeats")
    start.add_argument("--daemon", action="store_true")
    start.set_defaults(handler=command_start)
    commands.add_parser("_run").set_defaults(handler=lambda _: heartbeat_loop())
    commands.add_parser("stop", help="arrêter l'agent en arrière-plan").set_defaults(handler=command_stop)
    commands.add_parser("status", help="afficher l'état local").set_defaults(handler=command_status)
    commands.add_parser("diagnose", help="tester GPU, Docker, API et liaison").set_defaults(handler=command_diagnose)
    commands.add_parser("api-health", help="tester uniquement la connexion à l'API").set_defaults(handler=command_api_health)
    commands.add_parser("runtime-check", help=argparse.SUPPRESS).set_defaults(handler=command_runtime_check)
    commands.add_parser("show-key", help="afficher uniquement la clé publique").set_defaults(handler=command_show_key)
    reset = commands.add_parser("reset-key", help="régénérer la clé locale")
    reset.add_argument("--yes", action="store_true")
    reset.set_defaults(handler=command_reset_key)
    commands.add_parser("benchmark", help="lancer le diagnostic GPU local").set_defaults(handler=command_benchmark)
    logs = commands.add_parser("logs", help="afficher les derniers journaux")
    logs.add_argument("--lines", type=int, default=100)
    logs.set_defaults(handler=command_logs)
    workspaces = commands.add_parser("workspaces", help="catalogue et capacités Workspace")
    workspace_commands = workspaces.add_subparsers(dest="workspace_command", required=True)
    workspace_commands.add_parser("list", help="afficher les 13 espaces du catalogue").set_defaults(handler=command_workspaces_list)
    workspace_commands.add_parser("analyze", help="afficher les capacités locales utilisées pour la compatibilité").set_defaults(handler=command_workspaces_analyze)
    install_workspace = workspace_commands.add_parser("install", help="télécharger et vérifier une image Workspace épinglée")
    install_workspace.add_argument("slug", choices=["compute", "developer"])
    install_workspace.add_argument("image", help="registre/image@sha256:digest")
    install_workspace.add_argument("--timeout", type=int, default=600)
    install_workspace.set_defaults(handler=command_workspace_install)
    protections = commands.add_parser("protections", help="vérifier les protections du runtime")
    protection_commands = protections.add_subparsers(
        dest="protection_command", required=True
    )
    protection_commands.add_parser(
        "verify", help="créer, inspecter et supprimer un conteneur de contrôle"
    ).set_defaults(handler=command_protections_verify)
    gpu_processes = commands.add_parser(
        "gpu-processes", help="détecter et libérer proprement le GPU avant une location"
    )
    gpu_process_commands = gpu_processes.add_subparsers(dest="gpu_process_command", required=True)
    gpu_list_cmd = gpu_process_commands.add_parser(
        "list", help="lister les processus qui utilisent actuellement le GPU"
    )
    gpu_list_cmd.add_argument("--gpu-uuid", help="UUID matériel ciblé (par défaut : premier GPU détecté)")
    gpu_list_cmd.set_defaults(handler=command_gpu_processes_list)
    gpu_close_cmd = gpu_process_commands.add_parser(
        "close", help="demander à un seul processus utilisateur de se fermer proprement"
    )
    gpu_close_cmd.add_argument("--pid", type=int, required=True)
    gpu_close_cmd.set_defaults(handler=command_gpu_processes_close)
    service = commands.add_parser("service", help="gérer le service système Windows")
    service.add_argument(
        "service_action", choices=["install", "remove", "start", "stop", "restart", "status"]
    )
    service.set_defaults(handler=command_service)
    commands.add_parser("_service").set_defaults(
        handler=lambda _: __import__(
            "gpubnb_agent.windows_service", fromlist=["dispatch_service"]
        ).dispatch_service()
    )
    files = commands.add_parser("files", help="transférer des fichiers de résultats")
    file_commands = files.add_subparsers(dest="file_command", required=True)
    upload_cmd = file_commands.add_parser("upload", help="téléverser un fichier de résultat vers un job")
    upload_cmd.add_argument("job_id", help="identifiant du job")
    upload_cmd.add_argument("path", help="chemin du fichier local à téléverser")
    upload_cmd.add_argument("--kind", default="result", help="type d'artefact (result, log, etc.)")
    upload_cmd.set_defaults(handler=command_files_upload)
    download_cmd = file_commands.add_parser("download", help="télécharger un artefact depuis un job")
    download_cmd.add_argument("job_id", help="identifiant du job")
    download_cmd.add_argument("artifact_id", help="identifiant de l'artefact")
    download_cmd.add_argument("--output", help="chemin de destination local")
    download_cmd.add_argument("--sha256", help="empreinte attendue pour vérification d'intégrité")
    download_cmd.set_defaults(handler=command_files_download)
    list_cmd = file_commands.add_parser("list", help="lister les artefacts d'un job")
    list_cmd.add_argument("job_id", help="identifiant du job")
    list_cmd.set_defaults(handler=command_files_list)
    commands.add_parser("version", help="afficher la version").set_defaults(handler=lambda _: print(__version__) or 0)
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        return int(args.handler(args))
    except RuntimeError as exc:
        print(f"Erreur : {exc}", file=sys.stderr)
        return 1
