"""Retire a terminal native rental only under a fresh owner diagnostic.

No booking, new lease, locally invented generation, miner termination or driver
installation is part of this protocol. The caller holds PHYSICAL_GPU_LOCK over
prepare, the existing GPU diagnostic, finish, and the signed result submission.
The persisted rental claim keeps fencing probes until physical proof succeeds.
"""
from __future__ import annotations

import platform
import re
import time
from dataclasses import dataclass, replace
from typing import Any, Callable

from .execution_control import ExecutionControlError
from .gpu_rental_preemption import RentalClaimRecord, RentalPreemptionSupervisor
from .gpu_resource_supervisor import MAX_GENERATION, SAFE_ID, RuntimeRecord
from .physical_gpu_authority import PHYSICAL_GPU_LOCK
from .windows_native_capability import native_rental_physical_cleanup_confirmed
from .windows_native_runtime import stop_windows_native_workspace

GPU_UUID = re.compile(r"^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
GENERATION = re.compile(r"^[1-9][0-9]{0,18}$")


def _generation(value: Any) -> int:
    if not isinstance(value, str) or not GENERATION.fullmatch(value) or int(value) > MAX_GENERATION:
        raise ExecutionControlError("native_cleanup_fence_unverified")
    return int(value)


@dataclass(frozen=True)
class _Snapshot:
    claims: dict[str, RentalClaimRecord]
    runtimes: dict[str, RuntimeRecord]


class NativeQuarantineRecovery:
    def __init__(
        self, diagnostic_run_id: str, target: Any,
        authorize: Callable[[dict[str, Any]], dict[str, Any]], *,
        supervisor: RentalPreemptionSupervisor | None = None,
        stop: Callable[[str], None] | None = None,
    ) -> None:
        if platform.system() != "Windows":
            raise ExecutionControlError("native_cleanup_windows_required")
        if (not isinstance(diagnostic_run_id, str) or not SAFE_ID.fullmatch(diagnostic_run_id)
            or not isinstance(target, dict) or set(target) != {"sessionId", "resourceId", "hardwareUuid"}
            or any(not isinstance(target.get(key), str) or not SAFE_ID.fullmatch(target[key])
                   for key in ("sessionId", "resourceId"))
            or not isinstance(target.get("hardwareUuid"), str) or not GPU_UUID.fullmatch(target["hardwareUuid"])):
            raise ExecutionControlError("native_cleanup_scope_unverified")
        self.diagnostic_run_id = diagnostic_run_id
        self.target = dict(target)
        self.supervisor = supervisor or RentalPreemptionSupervisor()
        self.authorize = authorize
        self.stop = stop or stop_windows_native_workspace
        self._prepared: tuple[_Snapshot, int] | None = None

    def _snapshot(self) -> _Snapshot:
        claims = self.supervisor.claims.load()
        runtimes = self.supervisor.mining.store.load()
        resource = self.target["resourceId"]
        session = self.target["sessionId"]
        hardware = self.target["hardwareUuid"].casefold()
        for claim in claims.values():
            if (claim.resource_id != resource or claim.session_id != session
                or claim.hardware_uuid.casefold() != hardware
                or claim.holder_id != f"rental:{session}"
                or claim.fencing_token != str(claim.runtime_generation)
                or claim.state not in {"QUARANTINED", "QUIESCENT"}):
                raise ExecutionControlError("native_cleanup_claim_authority_unverified")
        current = runtimes.get(resource)
        if current is None or current.hardware_uuid.casefold() != hardware:
            raise ExecutionControlError("native_cleanup_runtime_authority_unverified")
        for record in runtimes.values():
            if (record.state not in ({"STOPPED", "QUARANTINED"} if record.resource_id == resource else {"STOPPED"})
                or record.pid is not None or record.process_creation_token is not None
                or record.command_id is not None):
                # No PID identity means there is nothing we can safely terminate.
                # Identity-bearing or unrelated unsafe runtimes require their own
                # canonical stop, not erasure by a native cleanup diagnostic.
                raise ExecutionControlError("native_cleanup_runtime_process_unverified")
        claim = claims.get(resource)
        if claim is not None and current.runtime_generation < claim.runtime_generation:
            raise ExecutionControlError("native_cleanup_runtime_fence_regressed")
        return _Snapshot(claims, runtimes)

    def _approve(self, minimum: int, expected: int | None = None) -> int:
        decision = self.authorize({**self.target, "runtimeGeneration": str(max(1, minimum))})
        if (not isinstance(decision, dict) or decision.get("allowed") is not True
            or type(decision.get("protocolVersion")) is not int or decision["protocolVersion"] != 1
            or decision.get("diagnosticRunId") != self.diagnostic_run_id
            or any(decision.get(key) != self.target[key] for key in ("sessionId", "resourceId"))
            or not isinstance(decision.get("hardwareUuid"), str)
            or decision["hardwareUuid"].casefold() != self.target["hardwareUuid"].casefold()):
            raise ExecutionControlError("native_cleanup_authority_refused")
        floor = _generation(decision.get("fenceFloor"))
        if floor < minimum or (expected is not None and floor != expected):
            raise ExecutionControlError("native_cleanup_authority_changed")
        return floor

    def _prove(self, snapshot: _Snapshot, expected: int | None = None) -> int:
        current = snapshot.runtimes[self.target["resourceId"]]
        floor = self._approve(current.runtime_generation, expected)
        self.stop(self.target["sessionId"])
        binding = self.supervisor.mining.binding_resolver(self.target["hardwareUuid"])
        if binding.hardware_uuid.casefold() != self.target["hardwareUuid"].casefold():
            raise ExecutionControlError("native_cleanup_gpu_binding_mismatch")
        self.supervisor.probe.prove(self.target["hardwareUuid"])
        if self._snapshot() != snapshot:
            raise ExecutionControlError("native_cleanup_local_authority_changed")
        self._approve(floor, floor)
        return floor

    def prepare(self) -> None:
        """Prove STOP before the GPU diagnostic; leave both stores untouched."""
        with PHYSICAL_GPU_LOCK:
            snapshot = self._snapshot()
            floor = self._prove(snapshot)
            self._prepared = (snapshot, floor)

    def finish(self) -> dict[str, Any]:
        """Reprove after the diagnostic and release via the canonical claim store."""
        with PHYSICAL_GPU_LOCK:
            if self._prepared is None:
                raise ExecutionControlError("native_cleanup_not_prepared")
            snapshot, floor = self._prepared
            if self._snapshot() != snapshot:
                raise ExecutionControlError("native_cleanup_local_authority_changed")
            self._prove(snapshot, floor)
            resource = self.target["resourceId"]
            now_ms = int(time.time() * 1000)
            runtimes = dict(snapshot.runtimes)
            runtimes[resource] = replace(
                runtimes[resource], runtime_generation=floor, state="STOPPED",
                profile_id=None, command_id=None, pid=None, executable_path=None,
                binary_sha256=None, process_creation_token=None, updated_at_ms=now_ms,
            )
            # Advance/retain the authoritative persistent floor BEFORE releasing
            # the old claim. A crash at any step leaves either that claim fencing
            # the GPU, or the STOPPED tombstone rejecting old commands.
            self.supervisor.mining.store.save(runtimes)
            if resource in snapshot.claims:
                claims = dict(snapshot.claims)
                claims[resource] = replace(claims[resource], state="QUIESCENT", verified_at_ms=now_ms)
                self.supervisor.claims.save(claims)
            self.supervisor.release_after_cleanup(self.target["sessionId"])
            final = self._snapshot()
            if final.claims or final.runtimes[resource].state != "STOPPED":
                raise ExecutionControlError("native_cleanup_release_unverified")
            native_rental_physical_cleanup_confirmed(self.target["sessionId"])
            self._prepared = None
            return {
                "protocolVersion": 1, **self.target, "fenceFloor": str(floor),
                "helperStopped": True, "gpuQuiescent": True,
                "remainingRentalResourceIds": [], "unsafeRuntimeResourceIds": [],
            }
