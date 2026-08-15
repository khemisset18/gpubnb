"""Safe migration bridge between the QUIC control channel and legacy HTTPS jobs.

The bridge keeps HTTPS telemetry and durable job leases authoritative for rental
prepare/start while allowing a deliberately small set of idempotent local
mutations to execute directly after the control-channel protocol has fenced and
deduplicated them.
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
from .execution_control import ExecutionControlError, stop_rental
from .gpu_resource_supervisor import GpuResourceSupervisor
from .storage import load_config

ASSIGNMENT_REFRESH_SECONDS = 300
_POLICY_REJECTIONS = {
    "approved_miner_platform_unsupported",
    "approved_miner_binary_missing",
    "approved_miner_binary_path_invalid",
    "approved_miner_binary_hash_mismatch",
    "miner_secret_resolution_required",
    "mining_command_payload_invalid",
    "mining_command_payload_unknown_field",
    "mining_resource_id_invalid",
    "mining_hardware_uuid_invalid",
    "mining_command_id_invalid",
    "mining_profile_not_resource_gpu_approved",
    "mining_pool_url_invalid",
    "mining_pool_credentials_not_allowed",
    "mining_pool_port_invalid",
    "mining_pool_dns_resolution_failed",
    "mining_pool_address_not_public",
    "mining_wallet_invalid",
    "mining_worker_invalid",
    "mining_performance_mode_invalid",
    "mining_runtime_generation_invalid",
    "mining_runtime_generation_stale",
    "mining_runtime_generation_replay",
    "mining_runtime_generation_future",
    "mining_runtime_generation_fence_mismatch",
    "mining_resource_lease_required",
    "mining_resource_lease_mismatch",
    "mining_resource_hardware_identity_conflict",
    "mining_resource_quarantined",
    "resource_gpu_nvidia_smi_unavailable",
    "resource_gpu_inventory_unavailable",
    "resource_gpu_pci_identity_invalid",
    "resource_gpu_power_limits_invalid",
    "resource_gpu_power_limits_unavailable",
    "resource_gpu_identity_not_unique",
    "resource_gpu_not_present",
    "mining_stop_payload_invalid",
    "stop_rental_payload_invalid",
    "stop_rental_session_id_invalid",
    "stop_rental_workspace_not_direct",
}


def _validated_mining_payload(command: ControlCommand) -> dict[str, Any]:
    if command.lease is None:
        raise ExecutionControlError("mining_resource_lease_required")
    if not isinstance(command.payload, dict):
        raise ExecutionControlError("mining_command_payload_invalid")
    resource_id = command.payload.get("resourceId")
    generation = command.payload.get("runtimeGeneration")
    if not isinstance(resource_id, str) or command.lease.get("resourceId") != resource_id:
        raise ExecutionControlError("mining_resource_lease_mismatch")
    fencing_token = command.lease.get("fencingToken")
    if (
        not isinstance(generation, str)
        or not generation.isdigit()
        or generation.startswith("0")
        or len(generation) > 19
        or not isinstance(fencing_token, str)
        or fencing_token != generation
    ):
        raise ExecutionControlError("mining_runtime_generation_fence_mismatch")
    numeric_generation = int(generation)
    if numeric_generation <= 0 or numeric_generation > 9_223_372_036_854_775_807:
        raise ExecutionControlError("mining_runtime_generation_fence_mismatch")
    normalized = dict(command.payload)
    # Python integers are arbitrary precision. Conversion happens only after the
    # exact decimal string has matched the lease fence byte-for-byte.
    normalized["runtimeGeneration"] = numeric_generation
    return normalized


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
        self.gpu_supervisor = GpuResourceSupervisor()
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

    def _run_mutation(self, command: ControlCommand) -> ControlCommandResult:
        try:
            if command.kind == "STOP_RENTAL":
                if not isinstance(command.payload, dict) or command.payload.get("workspaceSlug") != "developer":
                    raise ExecutionControlError("stop_rental_workspace_not_direct")
                result = stop_rental(command.payload)
            elif command.kind == "STOP_MINING":
                result = self.gpu_supervisor.stop(_validated_mining_payload(command))
            elif command.kind == "START_MINING":
                result = self.gpu_supervisor.start(_validated_mining_payload(command), command.command_id)
            else:
                return ControlCommandResult("REJECTED", "direct_mutation_not_supported")
            self.emit({
                "event": "control_mutation_applied",
                "machineId": self.machine_id,
                "commandId": command.command_id,
                "kind": command.kind,
                "detailCode": result.detail_code,
            })
            return ControlCommandResult("SUCCEEDED", result.detail_code)
        except ExecutionControlError as exc:
            code = str(exc)[:96] or "execution_control_failed"
            status = "REJECTED" if code in _POLICY_REJECTIONS else "FAILED"
            self.emit({
                "event": "control_mutation_failed",
                "machineId": self.machine_id,
                "commandId": command.command_id,
                "kind": command.kind,
                "status": status,
                "detailCode": code,
            })
            return ControlCommandResult(status, code)

    def _handle_command(self, command: ControlCommand) -> ControlCommandResult:
        if command.kind in {"STOP_RENTAL", "START_MINING", "STOP_MINING"}:
            return self._run_mutation(command)
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
