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
from typing import Any

from . import __version__
from .client import ApiClient, agent_request, heartbeat
from .runner import (
    cleanup_workspace,
    gpu_proof_command,
    prepare_workspace,
    run_gpu_diagnostic,
    run_gpu_proof_workspace,
    verify_protection_profile,
)
from .platform_info import find_nvidia_smi, find_rocm_smi, find_xpu_smi, gpu_inventory, system_inventory
from .storage import (
    config_dir, fingerprint, generate_key, key_path, load_config, load_key,
    log_path, pid_path, public_key, save_config,
)

DEFAULT_API = "https://gpubnb.netlify.app/api"


def print_json(value: Any) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    # print() encodes through sys.stdout's text encoding, which on a real Windows
    # console defaults to the legacy console codepage (e.g. cp1252 on this machine) -
    # not UTF-8. Any non-ASCII content (the workspace catalog's emoji icons, accented
    # French text) then raises UnicodeEncodeError and crashes the CLI outright, which
    # is exactly what `gpubnb-agent workspaces list` did here. Writing UTF-8 bytes
    # directly sidesteps the console codepage entirely. Falls back to plain print()
    # when stdout has no .buffer (e.g. tests that redirect_stdout to an io.StringIO).
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
    stop_event: threading.Event | None = None, process_mode: str = "_run"
) -> int:
    if process_mode not in {"_run", "_service"}:
        raise RuntimeError("invalid_agent_process_mode")
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Machine non liée. Exécutez : gpubnb-agent link CODE")
    key = load_key()
    interval = max(5, min(60, int(config.get("intervalSeconds", 10))))
    failures = 0
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
                print_json({"event": "heartbeat", "result": result})
                run_next_job(client(config), key, machine_id, config)
                failures = 0
            except Exception as exc:
                failures = min(failures + 1, 8)
                print_json({"event": "heartbeat_error", "type": type(exc).__name__, "message": str(exc)[:300]})
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


def run_next_job(api: ApiClient, key: Any, machine_id: str, config: dict[str, Any]) -> None:
    path = f"/agent/jobs/next/{machine_id}"
    job = agent_request(api, key, machine_id, path)
    if not job:
        return
    job_id = str(job["id"])
    if job.get("type") not in {"GPU_DIAGNOSTIC", "WORKSPACE_PREPARE", "GPU_PROOF"}:
        update_job(api, key, machine_id, job_id, "REJECTED", "unsupported_job_type")
        return
    parameters = job.get("parameters") if isinstance(job.get("parameters"), dict) else {}
    workspace_slug = str(parameters.get("workspaceSlug") or "compute")
    workspace_images = config.get("workspaceImages") if isinstance(config.get("workspaceImages"), dict) else {}
    image = str(workspace_images.get(workspace_slug) or config.get("diagnosticImage") or "")
    try:
        if job.get("type") in {"WORKSPACE_PREPARE", "GPU_PROOF"}:
            update_job(api, key, machine_id, job_id, "DOWNLOADING")
        update_job(api, key, machine_id, job_id, "PREPARING")
        update_job(api, key, machine_id, job_id, "RUNNING")
        if job.get("type") == "GPU_PROOF":
            if not isinstance(session_value := job.get("workspaceSession"), dict) or not isinstance(session_value.get("id"), str):
                raise RuntimeError("gpu_proof_session_missing")
            metric_counter = 0
            previous_elapsed = 0

            def publish_sample(sample: dict[str, int]) -> None:
                nonlocal metric_counter, previous_elapsed
                metric_counter += 1
                elapsed = sample["elapsedSeconds"]
                interval = max(1, min(30, elapsed - previous_elapsed))
                previous_elapsed = elapsed
                send_session_metric(api, key, machine_id, session_value["id"], metric_counter, interval)
                control = agent_request(api, key, machine_id, f"/agent/jobs/{job_id}/control")
                if control.get("cancelRequested") is True:
                    raise RuntimeError("rental_cancel_requested")

            result = run_gpu_proof_workspace(
                image,
                int(parameters.get("durationSeconds", 60)),
                publish_sample,
            )
        elif job.get("type") == "WORKSPACE_PREPARE":
            result = prepare_workspace(image, int(parameters.get("timeoutSeconds", 600)), workspace_slug)
        else:
            result = run_gpu_diagnostic(image, int(parameters.get("timeoutSeconds", 120)))
        session_value = job.get("workspaceSession")
        if job.get("type") == "GPU_DIAGNOSTIC" and isinstance(session_value, dict) and isinstance(session_value.get("id"), str):
            send_session_metric(api, key, machine_id, session_value["id"], 1, 5)
        update_job(api, key, machine_id, job_id, "UPLOADING_RESULTS")
        complete_path = f"/agent/jobs/{job_id}/complete"
        agent_request(api, key, machine_id, complete_path, "POST", {"machineId": machine_id, "result": result})
        if job.get("type") == "GPU_PROOF":
            finalize_path = f"/agent/jobs/{job_id}/finalize-proof"
            agent_request(api, key, machine_id, finalize_path, "POST", {"machineId": machine_id})
        print_json({"event": "job_completed", "jobId": job_id})
    except Exception as exc:
        try:
            cancelled = str(exc) == "rental_cancel_requested"
            update_job(api, key, machine_id, job_id, "CANCELLED" if cancelled else "FAILED", str(exc)[:100])
        finally:
            print_json({"event": "job_failed", "jobId": job_id, "message": str(exc)[:300]})


def update_job(api: ApiClient, key: Any, machine_id: str, job_id: str, status: str, error_code: str | None = None) -> dict[str, Any]:
    path = f"/agent/jobs/{job_id}/state"
    body = {"machineId": machine_id, "status": status}
    if error_code:
        body["errorCode"] = error_code
    return agent_request(api, key, machine_id, path, "POST", body)


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
        deadline = time.monotonic() + 5
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
        # Validate the dedicated proof image allow-list without starting a GPU
        # workload during installation, then check the container protections.
        gpu_proof_command(args.image, 30, "gpubnb-proof-install-check")
        result = verify_protection_profile(args.image)
    else:
        result = prepare_workspace(args.image, args.timeout, args.slug)
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
