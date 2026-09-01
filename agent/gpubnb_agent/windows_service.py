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
    delay = RESTART_DELAY_SECONDS
    event_sink = _service_event_sink(logger)
    while not stop_event.is_set():
        try:
            exit_code = heartbeat(
                stop_event,
                process_mode="_service",
                event_sink=event_sink,
            )
            if stop_event.is_set() and exit_code in (None, 0):
                return
            raise RuntimeError(f"agent_service_exited:{exit_code}")
        except Exception:
            logger.exception("Agent worker failed; retry scheduled in %s seconds", delay)
            if stop_event.wait(delay):
                return
            delay = min(MAX_RESTART_DELAY_SECONDS, delay * 2)


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
    from .cli import heartbeat_loop

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
            servicemanager.LogInfoMsg(f"{SERVICE_NAME} starting")
            logger = _service_logger()
            logger.info("%s starting", SERVICE_NAME)
            supervise_heartbeat(self._stop_event, heartbeat_loop, logger)
            logger.info("%s stopped", SERVICE_NAME)
            servicemanager.LogInfoMsg(f"{SERVICE_NAME} stopped")

    return GPUbnbAgentService


def dispatch_service() -> int:
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
    result = subprocess.run(
        ["sc.exe", *arguments],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        shell=False,
    )
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
            return True  # not installed at all counts as "stopped"
        raise RuntimeError(f"service_status_failed:{exc}") from exc
    return status[1] == win32service.SERVICE_STOPPED
