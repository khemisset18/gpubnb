"""Safe migration bridge between the QUIC control channel and legacy HTTPS jobs.

The bridge intentionally keeps HTTPS telemetry and durable job leases authoritative.
QUIC commands wake those proven paths; they do not bypass them.
"""
from __future__ import annotations

import atexit
import threading
import time
from typing import Any, Callable

from .client import agent_request
from .control_channel import (
    ControlChannelSupervisor,
    ControlCommand,
    ControlCommandResult,
    classify_command_action,
)
from .storage import load_config

ASSIGNMENT_REFRESH_SECONDS = 300


class _Runtime:
    def __init__(
        self,
        *,
        api: Any,
        key: Any,
        machine_id: str,
        original_heartbeat: Callable[..., dict[str, Any]],
        original_run_next_job: Callable[..., None],
        emit: Callable[[dict[str, Any]], None],
    ) -> None:
        self.api = api
        self.key = key
        self.machine_id = machine_id
        self.original_heartbeat = original_heartbeat
        self.original_run_next_job = original_run_next_job
        self.emit = emit
        self.config = load_config()
        self._job_lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._next_assignment_refresh = 0.0
        self._next_fallback_poll = 0.0
        self.supervisor = ControlChannelSupervisor(
            machine_id=machine_id,
            key=key,
            command_handler=self._handle_command,
            event_sink=emit,
            ca_file=self.config.get("controlGatewayCaFile") if isinstance(self.config.get("controlGatewayCaFile"), str) else None,
        )
        self.supervisor.start()

    def stop(self) -> None:
        self.supervisor.stop()

    def refresh_assignment_if_due(self) -> None:
        now = time.monotonic()
        if now < self._next_assignment_refresh or not self._refresh_lock.acquire(blocking=False):
            return
        try:
            if time.monotonic() < self._next_assignment_refresh:
                return
            path = f"/agent/control-channel/{self.machine_id}"
            try:
                assignment = agent_request(self.api, self.key, self.machine_id, path)
                self.supervisor.update_assignment(assignment)
                self._next_assignment_refresh = time.monotonic() + ASSIGNMENT_REFRESH_SECONDS
            except Exception as exc:
                # Migration must fail back to the proven HTTPS path. Retry assignment
                # sooner than the normal refresh cadence, but never tight-loop.
                self._next_assignment_refresh = time.monotonic() + 30
                self.emit({
                    "event": "control_channel_assignment_error",
                    "type": type(exc).__name__,
                    "message": str(exc)[:300],
                })
        finally:
            self._refresh_lock.release()

    def legacy_job_poll(self, *args: Any, **kwargs: Any) -> None:
        if self.supervisor.is_connected():
            now = time.monotonic()
            if now < self._next_fallback_poll:
                return
            self._next_fallback_poll = now + self.supervisor.fallback_poll_seconds()
        self._run_job_serialized(*args, **kwargs)

    def _run_job_serialized(self, *args: Any, **kwargs: Any) -> None:
        if not self._job_lock.acquire(blocking=False):
            self.emit({"event": "job_wake_coalesced", "machineId": self.machine_id})
            return
        try:
            self.original_run_next_job(*args, **kwargs)
        finally:
            self._job_lock.release()

    def _handle_command(self, command: ControlCommand) -> ControlCommandResult:
        action = classify_command_action(command)
        if action == "WAKE_JOB":
            self._run_job_serialized(
                self.api,
                self.key,
                self.machine_id,
                self.config,
                event_sink=self.emit,
            )
            return ControlCommandResult("SUCCEEDED", "job_wake_processed")
        if action == "WAKE_HEARTBEAT":
            # Call the original heartbeat, not the installed wrapper, so a push
            # inventory refresh cannot recursively refresh its own channel assignment.
            self.original_heartbeat(self.api, self.key, self.machine_id)
            return ControlCommandResult("SUCCEEDED", "inventory_refresh_processed")
        return ControlCommandResult("REJECTED", "command_not_enabled_in_v1")


_lock = threading.Lock()
_runtimes: dict[str, _Runtime] = {}
_installed = False


def _stop_all() -> None:
    with _lock:
        values = list(_runtimes.values())
        _runtimes.clear()
    for runtime in values:
        try:
            runtime.stop()
        except Exception:
            pass


def install(cli_module: Any) -> None:
    """Install the migration bridge once after ``gpubnb_agent.cli`` is imported."""
    global _installed
    with _lock:
        if _installed:
            return
        _installed = True

    original_heartbeat = cli_module.heartbeat
    original_run_next_job = cli_module.run_next_job
    original_heartbeat_loop = cli_module.heartbeat_loop
    default_emit = cli_module.print_json
    sink_lock = threading.Lock()
    sink: dict[str, Callable[[dict[str, Any]], None]] = {"value": default_emit}

    def active_emit(event: dict[str, Any]) -> None:
        with sink_lock:
            target = sink["value"]
        target(event)

    def ensure_runtime(api: Any, key: Any, machine_id: str) -> _Runtime | None:
        with _lock:
            existing = _runtimes.get(machine_id)
        if existing is not None:
            return existing
        try:
            candidate = _Runtime(
                api=api,
                key=key,
                machine_id=machine_id,
                original_heartbeat=original_heartbeat,
                original_run_next_job=original_run_next_job,
                emit=active_emit,
            )
        except Exception as exc:
            active_emit({
                "event": "control_channel_local_init_error",
                "type": type(exc).__name__,
                "message": str(exc)[:300],
            })
            return None
        with _lock:
            winner = _runtimes.setdefault(machine_id, candidate)
        if winner is not candidate:
            candidate.stop()
        return winner

    def heartbeat_with_control(api: Any, key: Any, machine_id: str) -> dict[str, Any]:
        result = original_heartbeat(api, key, machine_id)
        runtime = ensure_runtime(api, key, machine_id)
        if runtime is not None:
            runtime.refresh_assignment_if_due()
        return result

    def run_next_job_with_control(
        api: Any,
        key: Any,
        machine_id: str,
        config: dict[str, Any],
        event_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        runtime = ensure_runtime(api, key, machine_id)
        if runtime is None:
            return original_run_next_job(api, key, machine_id, config, event_sink=event_sink)
        runtime.legacy_job_poll(api, key, machine_id, config, event_sink=event_sink)

    def heartbeat_loop_with_control(
        stop_event: threading.Event | None = None,
        process_mode: str = "_run",
        event_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> int:
        with sink_lock:
            previous = sink["value"]
            sink["value"] = event_sink or default_emit
        try:
            return original_heartbeat_loop(
                stop_event=stop_event,
                process_mode=process_mode,
                event_sink=event_sink,
            )
        finally:
            _stop_all()
            with sink_lock:
                sink["value"] = previous

    cli_module.heartbeat = heartbeat_with_control
    cli_module.run_next_job = run_next_job_with_control
    cli_module.heartbeat_loop = heartbeat_loop_with_control
    atexit.register(_stop_all)
