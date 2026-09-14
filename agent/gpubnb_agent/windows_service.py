"""Windows Service Control Manager integration for the frozen GPUbnb agent."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from logging import Formatter, Logger
from logging.handlers import RotatingFileHandler
from typing import Any

SERVICE_NAME = "GPUbnbAgent"
SERVICE_DISPLAY_NAME = "GPUbnb Host Agent"
SERVICE_DESCRIPTION = "Supervises the GPUbnb host agent and secure workspace runtime."
RESTART_DELAY_SECONDS = 5
MAX_RESTART_DELAY_SECONDS = 300


def _service_logger() -> Logger:
    from .storage import log_path

    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    logger = Logger("gpubnb-agent-service")
    handler = RotatingFileHandler(
        path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    handler.setFormatter(
        Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S%z")
    )
    logger.addHandler(handler)
    return logger


def _service_event_sink(logger: Logger):
    def emit(event: dict[str, Any]) -> None:
        logger.info(
            "agent_event %s",
            json.dumps(event, ensure_ascii=False, separators=(",", ":"), default=str),
        )

    return emit


def supervise_heartbeat(
    stop_event: threading.Event,
    heartbeat: Any,
    logger: Logger,
) -> None:
    """Supervise the main Agent worker without blind catch-all restarts.

    Retryable transport/process exits use the central bounded recovery policy.
    Platform-action states are periodically re-probed so a legitimate server-side
    recovery can resume without rebooting Windows. Unknown/owner/security states
    park this worker until service stop/restart; the independent power guard stays
    alive and therefore does not lose signed Standby/rental protection.
    """
    # Keep the SCM bootstrap module cheap to import. Recovery policy is part of the
    # normal runtime and is only needed after ServiceFramework is already running.
    from .supervisor_recovery import PLATFORM_REPROBE_SECONDS, supervisor_wait

    event_sink = _service_event_sink(logger)
    attempt = 0
    while not stop_event.is_set():
        try:
            exit_code = heartbeat(
                stop_event,
                process_mode="_service",
                event_sink=event_sink,
            )
            if stop_event.is_set() and exit_code in (None, 0):
                return
            failure: BaseException = RuntimeError(
                f"heartbeat_worker_exited:exit={exit_code}"
            )
        except Exception as exc:
            failure = exc

        mode, reason, delay = supervisor_wait(
            failure,
            attempt,
            subsystem="heartbeat",
        )
        event = {
            "event": "agent_supervisor_recovery",
            "mode": mode,
            "reason": reason,
            "type": type(failure).__name__,
            "message": str(failure)[:300],
            "retryAfterSeconds": delay,
        }
        event_sink(event)

        if mode == "retry":
            actual_delay = delay if delay is not None else float(RESTART_DELAY_SECONDS)
            logger.error(
                "Agent worker failed (%s); policy retry in %s seconds: %s",
                reason,
                actual_delay,
                str(failure)[:300],
            )
            attempt += 1
            if stop_event.wait(actual_delay):
                return
            continue

        if mode == "platform_action":
            logger.error(
                "Agent worker paused for platform action (%s); signed re-probe in %s seconds",
                reason,
                PLATFORM_REPROBE_SECONDS,
            )
            event_sink({
                "event": "agent_supervisor_platform_wait",
                "mode": mode,
                "reason": reason,
                "retryAfterSeconds": PLATFORM_REPROBE_SECONDS,
            })
            attempt = 0
            if stop_event.wait(PLATFORM_REPROBE_SECONDS):
                return
            continue

        logger.error(
            "Agent worker blocked by recovery policy (%s/%s): %s",
            mode,
            reason,
            str(failure)[:300],
        )
        event_sink({
            "event": "agent_supervisor_blocked",
            "mode": mode,
            "reason": reason,
        })
        stop_event.wait()
        return


def _require_windows() -> tuple[Any, Any, Any, Any]:
    if os.name != "nt":
        raise RuntimeError("windows_service_not_supported")
    try:
        import servicemanager
        import win32event
        import win32service
        import win32serviceutil
    except ImportError as exc:
        raise RuntimeError("windows_service_runtime_missing") from exc
    return servicemanager, win32event, win32service, win32serviceutil


def _service_class() -> type:
    servicemanager, win32event, win32service, win32serviceutil = _require_windows()

    class GPUbnbAgentService(win32serviceutil.ServiceFramework):
        _svc_name_ = SERVICE_NAME
        _svc_display_name_ = SERVICE_DISPLAY_NAME
        _svc_description_ = SERVICE_DESCRIPTION
        _exe_name_ = sys.executable
        _exe_args_ = "_service"

        def __init__(self, args: list[str]) -> None:
            super().__init__(args)
            self._stop_handle = win32event.CreateEvent(None, 1, 0, None)
            self._stop_event = threading.Event()

        def SvcStop(self) -> None:
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            self._stop_event.set()
            win32event.SetEvent(self._stop_handle)

        def SvcDoRun(self) -> None:
            # ServiceFramework reports SERVICE_RUNNING before entering SvcDoRun.
            # Only now is it safe to import the full Agent/Workspace stack on a
            # cold Windows boot without consuming SCM's dispatcher deadline.
            servicemanager.LogInfoMsg(f"{SERVICE_NAME} starting")
            logger = _service_logger()
            event_sink = _service_event_sink(logger)
            logger.info("%s starting", SERVICE_NAME)

            from . import install_runtime_layers

            # Preserve the historically qualified package wiring: v2 -> ... -> v7
            # must be installed before cli imports workspace_gateway.
            install_runtime_layers()

            from . import cli
            from .entrypoint import install_process_runtime
            from .power_guard import run_rental_power_guard

            docker_executable = install_process_runtime(cli)
            if docker_executable:
                logger.info("Docker CLI resolved for service runtime: %s", docker_executable)
            else:
                logger.warning("Docker CLI was not found in PATH or supported Docker Desktop install roots")

            # GPUbnb standby: while the owner still exposes this machine to the
            # marketplace (or a rental/session is live), prevent only automatic
            # system sleep. Windows may still turn the display off and idle the
            # CPU/GPU normally, and explicit user sleep/reboot/shutdown remains
            # possible. This thread is independent from heartbeat supervision so a
            # transient heartbeat worker restart cannot silently drop protection.
            power_guard_thread = threading.Thread(
                target=run_rental_power_guard,
                args=(self._stop_event,),
                kwargs={"event_sink": event_sink},
                name="gpubnb-host-power-guard",
                daemon=True,
            )
            power_guard_thread.start()

            supervise_heartbeat(self._stop_event, cli.heartbeat_loop, logger)
            # SvcStop sets the shared event. Give the guard a short bounded window
            # to release ES_SYSTEM_REQUIRED before the service process exits.
            power_guard_thread.join(timeout=5)
            logger.info("%s stopped", SERVICE_NAME)
            servicemanager.LogInfoMsg(f"{SERVICE_NAME} stopped")

    return GPUbnbAgentService


def dispatch_service() -> int:
    # This path intentionally performs only the minimum pywin32 work required to
    # connect the process to SCM. Heavy Agent imports happen inside SvcDoRun.
    servicemanager, _, _, _ = _require_windows()
    service_class = _service_class()
    servicemanager.Initialize()
    servicemanager.PrepareToHostSingle(service_class)
    servicemanager.StartServiceCtrlDispatcher()
    return 0


def manage_service(action: str) -> int:
    _, _, _, win32serviceutil = _require_windows()
    service_class = _service_class()
    arguments = [sys.executable]
    if action == "install":
        arguments.extend(["--startup", "auto", "install"])
    else:
        arguments.append(action)
    previous = sys.argv
    try:
        sys.argv = arguments
        win32serviceutil.HandleCommandLine(service_class)
    finally:
        sys.argv = previous
    if action == "install":
        _configure_recovery()
    return 0


def _sc(*arguments: str) -> subprocess.CompletedProcess[str]:
    # Service recovery configuration is non-interactive background work. Reuse
    # the Agent's bounded no-console launcher so sc.exe cannot flash a console
    # when invoked from the desktop/service setup path. Import it lazily so the
    # SCM dispatcher bootstrap never loads platform/GPU runtime helpers first.
    from .platform_info import run_command

    result = run_command(["sc.exe", *arguments], timeout=15)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-500:]
        raise RuntimeError(f"service_control_failed:{arguments[0]}:{detail}")
    return result


def _configure_recovery() -> None:
    _sc(
        "failure",
        SERVICE_NAME,
        "reset=",
        "86400",
        "actions=",
        "restart/5000/restart/30000/restart/120000",
    )
    _sc("failureflag", SERVICE_NAME, "1")


def service_status() -> dict[str, bool]:
    _, _, win32service, win32serviceutil = _require_windows()
    try:
        status = win32serviceutil.QueryServiceStatus(SERVICE_NAME)
    except win32service.error as exc:
        if getattr(exc, "winerror", None) == 1060:
            return {"installed": False, "running": False}
        raise RuntimeError(f"service_status_failed:{exc}") from exc
    return {
        "installed": True,
        "running": status[1] == win32service.SERVICE_RUNNING,
    }


def service_fully_stopped() -> bool:
    """True only once the SCM reports SERVICE_STOPPED specifically.

    Distinct from `not service_status()["running"]`: a service also reports
    running=False while in the transitional STOP_PENDING state, for several
    seconds after `stop` on a real service. Treating that as "safe to
    restart" races the real Service Control Manager - reproduced live
    (StartService failed: 1056, an instance of the service is already
    running) while testing self_update.perform_self_update against a real
    Windows service. Used specifically to gate that restart.
    """
    _, _, win32service, win32serviceutil = _require_windows()
    try:
        status = win32serviceutil.QueryServiceStatus(SERVICE_NAME)
    except win32service.error as exc:
        if getattr(exc, "winerror", None) == 1060:
            return True
        raise RuntimeError(f"service_status_failed:{exc}") from exc
    return status[1] == win32service.SERVICE_STOPPED
