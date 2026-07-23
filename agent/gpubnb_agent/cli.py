"""Beginner-friendly GPUbnb Agent CLI."""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import __version__
from .client import ApiClient, agent_request, heartbeat
from .runner import prepare_workspace, run_gpu_diagnostic
from .platform_info import find_nvidia_smi, gpu_inventory, system_inventory
from .storage import (
    config_dir, fingerprint, generate_key, key_path, load_config, load_key,
    log_path, pid_path, public_key, save_config,
)

DEFAULT_API = "https://gpubnb.netlify.app/api"


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


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
    executable = find_nvidia_smi()
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
        "nvidiaSmi": executable,
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
    if not report["nvidiaSmi"]:
        print("- NVIDIA SMI introuvable : installez ou mettez à jour le pilote NVIDIA.")
    if not report["keyPresent"]:
        print("- Exécutez : gpubnb-agent setup")
    if not report["machineLinked"]:
        print("- Créez un code dans l'espace loueur puis exécutez : gpubnb-agent link CODE")
    if not report["api"].get("reachable"):
        print("- Vérifiez Internet, le pare-feu et l'URL API.")
    return 1


def command_status(_: argparse.Namespace) -> int:
    config = load_config()
    pid = None
    try:
        pid = int(pid_path().read_text().strip())
        os.kill(pid, 0)
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError, OSError):
        pid = None
    print_json({
        "running": pid is not None,
        "pid": pid,
        "machineId": config.get("machineId"),
        "linked": bool(config.get("machineId")),
        "logFile": str(log_path()),
    })
    return 0


def heartbeat_loop() -> int:
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str):
        raise RuntimeError("Machine non liée. Exécutez : gpubnb-agent link CODE")
    key = load_key()
    interval = max(5, min(60, int(config.get("intervalSeconds", 10))))
    failures = 0
    pid_path().write_text(str(os.getpid()), encoding="ascii")
    if os.name != "nt":
        pid_path().chmod(0o600)
    try:
        while True:
            try:
                result = heartbeat(client(config), key, machine_id)
                print_json({"event": "heartbeat", "result": result})
                run_next_job(client(config), key, machine_id, config)
                failures = 0
            except Exception as exc:
                failures = min(failures + 1, 8)
                print_json({"event": "heartbeat_error", "type": type(exc).__name__, "message": str(exc)[:300]})
            time.sleep(min(300, interval * (2 ** failures)) if failures else interval)
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
    if job.get("type") not in {"GPU_DIAGNOSTIC", "WORKSPACE_PREPARE"}:
        update_job(api, key, machine_id, job_id, "REJECTED", "unsupported_job_type")
        return
    parameters = job.get("parameters") if isinstance(job.get("parameters"), dict) else {}
    workspace_slug = str(parameters.get("workspaceSlug") or "compute")
    workspace_images = config.get("workspaceImages") if isinstance(config.get("workspaceImages"), dict) else {}
    image = str(workspace_images.get(workspace_slug) or config.get("diagnosticImage") or "")
    try:
        if job.get("type") == "WORKSPACE_PREPARE":
            update_job(api, key, machine_id, job_id, "DOWNLOADING")
        update_job(api, key, machine_id, job_id, "PREPARING")
        update_job(api, key, machine_id, job_id, "RUNNING")
        if job.get("type") == "WORKSPACE_PREPARE":
            result = prepare_workspace(image, int(parameters.get("timeoutSeconds", 600)), workspace_slug)
        else:
            result = run_gpu_diagnostic(image, int(parameters.get("timeoutSeconds", 120)))
        session_value = job.get("workspaceSession")
        if job.get("type") == "GPU_DIAGNOSTIC" and isinstance(session_value, dict) and isinstance(session_value.get("id"), str):
            send_session_metric(api, key, machine_id, session_value["id"], result)
        update_job(api, key, machine_id, job_id, "UPLOADING_RESULTS")
        complete_path = f"/agent/jobs/{job_id}/complete"
        agent_request(api, key, machine_id, complete_path, "POST", {"machineId": machine_id, "result": result})
        print_json({"event": "job_completed", "jobId": job_id})
    except Exception as exc:
        try:
            update_job(api, key, machine_id, job_id, "FAILED", str(exc)[:100])
        finally:
            print_json({"event": "job_failed", "jobId": job_id, "message": str(exc)[:300]})


def update_job(api: ApiClient, key: Any, machine_id: str, job_id: str, status: str, error_code: str | None = None) -> dict[str, Any]:
    path = f"/agent/jobs/{job_id}/state"
    body = {"machineId": machine_id, "status": status}
    if error_code:
        body["errorCode"] = error_code
    return agent_request(api, key, machine_id, path, "POST", body)


def send_session_metric(api: ApiClient, key: Any, machine_id: str, session_id: str, result: dict[str, Any]) -> dict[str, Any]:
    system = system_inventory()
    gpus = gpu_inventory()
    gpu = gpus[0] if gpus else {}
    ram_total = int(system.get("ramTotalMiB") or 0)
    ram_available = int(system.get("ramAvailableMiB") or 0)
    disk_total = int(system.get("diskTotalMiB") or 0)
    disk_available = int(system.get("diskAvailableMiB") or 0)
    payload = {
        "machineId": machine_id, "counter": 1,
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "intervalSeconds": 5, "gpuUtilization": int(gpu.get("gpuUtilization") or 0),
        "memoryUsedMiB": int(gpu.get("memoryUsedMiB") or 0),
        "temperatureC": int(gpu.get("temperatureC") or 0),
        "cpuUtilization": 0, "ramUsedMiB": max(0, ram_total - ram_available),
        "diskUsedMiB": max(0, disk_total - disk_available),
        "networkRxBytes": 0, "networkTxBytes": 0,
        "available": bool(result.get("gpuDetected")), "workloadProof": bool(result.get("gpuDetected")),
    }
    path = f"/agent/workspace-sessions/{session_id}/metrics"
    return agent_request(api, key, machine_id, path, "POST", payload)


def command_start(args: argparse.Namespace) -> int:
    if args.daemon:
        if os.name == "nt":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            handle = open(log_path(), "a", encoding="utf-8")
            process = subprocess.Popen([sys.executable, str(Path(__file__).parents[1] / "agent.py"), "_run"], stdout=handle, stderr=handle, creationflags=flags, close_fds=True)
        else:
            handle = open(log_path(), "a", encoding="utf-8")
            process = subprocess.Popen([sys.executable, str(Path(__file__).parents[1] / "agent.py"), "_run"], stdout=handle, stderr=handle, start_new_session=True, close_fds=True)
        print(f"Agent démarré en arrière-plan (PID {process.pid}).")
        return 0
    return heartbeat_loop()


def command_stop(_: argparse.Namespace) -> int:
    try:
        pid = int(pid_path().read_text().strip())
    except (FileNotFoundError, ValueError):
        print("L'agent n'est pas démarré.")
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Arrêt demandé au processus {pid}.")
    except ProcessLookupError:
        print("Le processus était déjà arrêté.")
    return 0


def command_benchmark(_: argparse.Namespace) -> int:
    executable = find_nvidia_smi()
    if not executable:
        raise RuntimeError("nvidia-smi introuvable")
    started = time.monotonic()
    gpus = gpu_inventory(executable)
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


def command_workspace_install(args: argparse.Namespace) -> int:
    config = load_config()
    result = prepare_workspace(args.image, args.timeout, args.slug)
    images = config.get("workspaceImages")
    if not isinstance(images, dict):
        images = {}
    images[args.slug] = args.image
    config["workspaceImages"] = images
    save_config(config)
    print_json({"installed": True, "slug": args.slug, "image": args.image, "verification": result})
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="gpubnb-agent", description="Agent local sécurisé GPUbnb")
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
    commands.add_parser("version", help="afficher la version").set_defaults(handler=lambda _: print(__version__) or 0)
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        return int(args.handler(args))
    except RuntimeError as exc:
        print(f"Erreur : {exc}", file=sys.stderr)
        return 1
