"""Install policy-driven supervision around the real Agent heartbeat loop.

The entrypoint installs this after control_channel_runtime, so ``cli.heartbeat``
and ``cli.run_next_job`` already include the qualified control-channel bridge.
This layer changes only loop supervision and keeps diagnostics independent from
heartbeat success, which is required for quarantine/platform recovery.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Callable

from . import __version__
from ._build_info import BUILD_COMMIT
from .supervisor_recovery import PLATFORM_REPROBE_SECONDS, supervisor_wait


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def install(cli_module: Any) -> None:
    """Replace only the process loop; preserve installed heartbeat/job wrappers."""
    if getattr(cli_module, "_recovery_runtime_installed", False):
        return

    def heartbeat_loop_with_recovery(
        stop_event: threading.Event | None = None,
        process_mode: str = "_run",
        event_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> int:
        if process_mode not in {"_run", "_service"}:
            raise RuntimeError("invalid_agent_process_mode")

        emit = event_sink or cli_module.print_json
        config = cli_module.load_config()
        machine_id = config.get("machineId")
        if not isinstance(machine_id, str):
            raise RuntimeError("machine_not_linked")
        key = cli_module.load_key()
        interval = max(5, min(60, int(config.get("intervalSeconds", 10))))
        developer_image = cli_module.workspace_image(config, "developer")
        job_thread: threading.Thread | None = None
        diagnostic_thread: threading.Thread | None = None
        gateway_thread: threading.Thread | None = None
        diagnostic_stop = threading.Event()
        gateway_stop = threading.Event()
        recovery_attempt = 0

        def service_stopped() -> bool:
            return bool(stop_event is not None and stop_event.is_set())

        def wait_service(seconds: float | None) -> bool:
            if stop_event is not None:
                if seconds is None:
                    stop_event.wait()
                    return True
                return stop_event.wait(seconds)
            if seconds is None:
                # Foreground mode has no external event. Park in bounded sleeps
                # so Ctrl+C can still interrupt the process.
                while True:
                    time.sleep(60)
            time.sleep(seconds)
            return False

        def gateway_error(exc: Exception) -> None:
            message = str(exc)[:300]
            event: dict[str, Any] = {
                "event": "workspace_gateway_error",
                "type": type(exc).__name__,
                "message": message,
            }
            detail = cli_module._GATEWAY_ERROR_EXPLANATIONS.get(message)
            if detail is not None:
                event["detail"] = detail
            emit(event)

        def supervise_gateway() -> None:
            from .workspace_gateway import run_workspace_gateway_forever

            attempts = 0
            while not gateway_stop.is_set() and not service_stopped():
                try:
                    emit({"event": "workspace_gateway_starting"})
                    run_workspace_gateway_forever(
                        stop_event=gateway_stop,
                        error_callback=gateway_error,
                    )
                    if gateway_stop.is_set() or service_stopped():
                        return
                    failure: BaseException = RuntimeError("gateway_disconnected")
                except Exception as exc:
                    failure = exc
                    gateway_error(exc)

                mode, reason, delay = supervisor_wait(
                    failure,
                    attempts,
                    subsystem="gateway",
                )
                emit({
                    "event": "workspace_gateway_supervisor_recovery",
                    "mode": mode,
                    "reason": reason,
                    "retryAfterSeconds": delay,
                })
                if mode == "retry":
                    attempts += 1
                    actual_delay = delay if delay is not None else 5.0
                    if gateway_stop.wait(actual_delay):
                        return
                    continue
                if mode == "platform_action":
                    attempts = 0
                    if gateway_stop.wait(PLATFORM_REPROBE_SECONDS):
                        return
                    continue
                return

        def prewarm() -> None:
            try:
                result = cli_module.prewarm_workspace_image(
                    developer_image,
                    progress_callback=lambda step, elapsed: emit({
                        "event": "workspace_image_progress",
                        "step": step,
                        "elapsedSeconds": elapsed,
                    }),
                )
                emit({"event": "workspace_image_ready", **result})
            except Exception as exc:
                emit({
                    "event": "workspace_image_prewarm_failed",
                    "message": str(exc)[:300],
                })

        def poll_and_run_job() -> None:
            try:
                cli_module.run_next_job(
                    cli_module.client(config),
                    key,
                    machine_id,
                    config,
                    event_sink=emit,
                )
            except Exception as exc:
                emit({
                    "event": "job_poll_error",
                    "type": type(exc).__name__,
                    "message": str(exc)[:300],
                })

        def diagnostic_supervisor() -> None:
            while (
                not diagnostic_stop.is_set()
                and not service_stopped()
            ):
                try:
                    cli_module.poll_and_run_diagnostic_once(
                        cli_module.client(config),
                        key,
                        machine_id,
                        config=config,
                        event_sink=emit,
                    )
                except Exception as exc:
                    emit({
                        "event": "diagnostic_poll_error",
                        "machineId": machine_id,
                        "type": type(exc).__name__,
                        "message": str(exc)[:300],
                        "traceback": "".join(
                            traceback.format_exception(exc, limit=6)
                        )[-2000:],
                        "timestamp": _now_iso(),
                    })
                if diagnostic_stop.wait(interval):
                    return

        threading.Thread(
            target=prewarm,
            name="gpubnb-workspace-prewarm",
            daemon=True,
        ).start()
        gateway_thread = threading.Thread(
            target=supervise_gateway,
            name="gpubnb-workspace-gateway",
            daemon=True,
        )
        gateway_thread.start()
        diagnostic_thread = threading.Thread(
            target=diagnostic_supervisor,
            name="gpubnb-diagnostic-worker",
            daemon=True,
        )
        diagnostic_thread.start()

        emit({
            "event": "diagnostic_poll_loop_started",
            "machineId": machine_id,
            "processMode": process_mode,
            "intervalSeconds": interval,
            "agentVersion": __version__,
            "buildCommit": BUILD_COMMIT,
            "timestamp": _now_iso(),
        })
        cli_module.pid_path().write_text(
            json.dumps({
                "pid": os.getpid(),
                "executable": cli_module.sys.executable,
                "mode": process_mode,
            }),
            encoding="ascii",
        )
        if os.name != "nt":
            cli_module.pid_path().chmod(0o600)

        try:
            while not service_stopped():
                try:
                    result = cli_module.heartbeat(
                        cli_module.client(config),
                        key,
                        machine_id,
                    )
                    emit({"event": "heartbeat", "result": result})
                    if job_thread is None or not job_thread.is_alive():
                        job_thread = threading.Thread(
                            target=poll_and_run_job,
                            name="gpubnb-job-worker",
                            daemon=True,
                        )
                        job_thread.start()
                    recovery_attempt = 0
                    if wait_service(float(interval)):
                        break
                except Exception as exc:
                    mode, reason, delay = supervisor_wait(
                        exc,
                        recovery_attempt,
                        subsystem="heartbeat",
                    )
                    emit({
                        "event": "heartbeat_error",
                        "type": type(exc).__name__,
                        "message": str(exc)[:300],
                    })
                    emit({
                        "event": "heartbeat_recovery",
                        "mode": mode,
                        "reason": reason,
                        "retryAfterSeconds": delay,
                    })

                    if mode == "retry":
                        recovery_attempt += 1
                        if wait_service(delay if delay is not None else 5.0):
                            break
                        continue
                    if mode == "platform_action":
                        recovery_attempt = 0
                        if wait_service(PLATFORM_REPROBE_SECONDS):
                            break
                        continue
                    if mode == "stop":
                        # Security ambiguity stops data-plane/diagnostic workers,
                        # but not the service-wide power guard, which owns its own
                        # signed server policy thread in windows_service.py.
                        diagnostic_stop.set()
                        gateway_stop.set()
                    wait_service(None)
                    break
        except KeyboardInterrupt:
            return 0
        finally:
            diagnostic_stop.set()
            gateway_stop.set()
            emit({
                "event": "diagnostic_loop_stopped",
                "machineId": machine_id,
                "timestamp": _now_iso(),
            })
            try:
                cli_module.pid_path().unlink()
            except FileNotFoundError:
                pass
            if diagnostic_thread is not None:
                diagnostic_thread.join(timeout=2)
            if gateway_thread is not None:
                gateway_thread.join(timeout=2)
        return 0

    cli_module.heartbeat_loop = heartbeat_loop_with_recovery
    cli_module._recovery_runtime_installed = True
