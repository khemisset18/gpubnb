"""Windows Service Control Manager integration for the frozen GPUbnb agent."""
from __future__ import annotations

import os
import sys
import threading
from typing import Any

SERVICE_NAME = "GPUbnbAgent"
SERVICE_DISPLAY_NAME = "GPUbnb Host Agent"
SERVICE_DESCRIPTION = "Supervises the GPUbnb host agent and secure workspace runtime."


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
            exit_code = heartbeat_loop(self._stop_event)
            if exit_code:
                raise RuntimeError(f"agent_service_exited:{exit_code}")
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
    return 0
