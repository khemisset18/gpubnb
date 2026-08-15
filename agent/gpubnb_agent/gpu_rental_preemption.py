"""Resource-scoped rental preemption and NVIDIA GPU quiescence proofs.

A rental may supersede an older mining fence for exactly one MiningResource.  The
Agent never scans or kills arbitrary miners: it terminates only the process whose
persisted PID + creation identity + canonical executable still match the process
spawned by GPUbnb.  Before a workspace can receive the GPU, NVIDIA telemetry must
prove that the target UUID has no compute clients and is stably idle.
"""
from __future__ import annotations

import csv
import json
import os
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .execution_control import ExecutionControlError, ExecutionResult
from .gpu_resource_supervisor import (
    MAX_GENERATION,
    SAFE_GPU_ID,
    SAFE_ID,
    GpuResourceSupervisor,
    ProcessIdentity,
    RuntimeRecord,
)
from .platform_info import find_nvidia_smi, run_command
from .storage import config_dir

RENTAL_SCHEMA_VERSION = 1
RENTAL_STATES = {"PREEMPTING", "QUIESCENT", "RENTAL_ACTIVE", "QUARANTINED"}
QUIESCENCE_SAMPLES = 3
QUIESCENCE_INTERVAL_SECONDS = 0.15
QUIESCENCE_MAX_UTILIZATION_PERCENT = 5
QUIESCENCE_MIN_MEMORY_THRESHOLD_MIB = 256
QUIESCENCE_MAX_MEMORY_THRESHOLD_MIB = 512

_RESOURCE_LOCKS_GUARD = threading.Lock()
_RESOURCE_LOCKS: dict[str, threading.RLock] = {}


def _resource_transition_lock(resource_id: str) -> threading.RLock:
    """Return the process-local transition lock for one MiningResource.

    Mining mutations already accepted by the control channel can race with the
    first rental reconciliation.  Sharing this lock between START/STOP_MINING and
    rental preemption closes that local delivery window without serializing other
    GPUs on the same host.
    """
    with _RESOURCE_LOCKS_GUARD:
        lock = _RESOURCE_LOCKS.get(resource_id)
        if lock is None:
            lock = threading.RLock()
            _RESOURCE_LOCKS[resource_id] = lock
        return lock


@dataclass(frozen=True)
class RentalResourceSpec:
    session_id: str
    resource_id: str
    hardware_uuid: str
    runtime_generation: int
    holder_id: str
    lease_id: str
    fencing_token: str


@dataclass(frozen=True)
class GpuQuiescenceSample:
    hardware_uuid: str
    utilization_percent: int
    memory_used_mib: int
    memory_total_mib: int
    compute_pids: tuple[int, ...]


@dataclass(frozen=True)
class GpuQuiescenceProof:
    hardware_uuid: str
    samples: tuple[GpuQuiescenceSample, ...]
    memory_threshold_mib: int
    verified_at_ms: int


@dataclass
class RentalClaimRecord:
    session_id: str
    resource_id: str
    hardware_uuid: str
    runtime_generation: int
    holder_id: str
    lease_id: str
    fencing_token: str
    state: str
    verified_at_ms: int

    @classmethod
    def parse(cls, resource_id: str, value: Any) -> "RentalClaimRecord | None":
        if not isinstance(value, dict):
            return None
        try:
            record = cls(
                session_id=str(value["session_id"]),
                resource_id=resource_id,
                hardware_uuid=str(value["hardware_uuid"]),
                runtime_generation=int(value["runtime_generation"]),
                holder_id=str(value["holder_id"]),
                lease_id=str(value["lease_id"]),
                fencing_token=str(value["fencing_token"]),
                state=str(value["state"]),
                verified_at_ms=int(value.get("verified_at_ms", 0)),
            )
        except (KeyError, TypeError, ValueError):
            return None
        if (
            SAFE_ID.fullmatch(record.session_id) is None
            or SAFE_ID.fullmatch(record.resource_id) is None
            or SAFE_GPU_ID.fullmatch(record.hardware_uuid) is None
            or SAFE_ID.fullmatch(record.holder_id) is None
            or SAFE_ID.fullmatch(record.lease_id) is None
            or record.state not in RENTAL_STATES
            or not 1 <= record.runtime_generation <= MAX_GENERATION
            or record.fencing_token != str(record.runtime_generation)
        ):
            return None
        return record


class RentalClaimStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (config_dir() / "gpu-resource-rental-v1.json")
        self._lock = threading.RLock()

    def load(self) -> dict[str, RentalClaimRecord]:
        with self._lock:
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {}
            except (OSError, json.JSONDecodeError) as exc:
                raise ExecutionControlError("rental_claim_store_unreadable") from exc
            if not isinstance(raw, dict) or raw.get("schemaVersion") != RENTAL_SCHEMA_VERSION:
                raise ExecutionControlError("rental_claim_store_schema_invalid")
            values = raw.get("resources")
            if not isinstance(values, dict):
                raise ExecutionControlError("rental_claim_store_schema_invalid")
            records: dict[str, RentalClaimRecord] = {}
            for resource_id, value in values.items():
                if not isinstance(resource_id, str):
                    raise ExecutionControlError("rental_claim_store_record_invalid")
                record = RentalClaimRecord.parse(resource_id, value)
                if record is None:
                    raise ExecutionControlError("rental_claim_store_record_invalid")
                records[resource_id] = record
            return records

    def save(self, records: dict[str, RentalClaimRecord]) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "schemaVersion": RENTAL_SCHEMA_VERSION,
                "resources": {resource_id: asdict(record) for resource_id, record in sorted(records.items())},
            }
            fd, temporary = tempfile.mkstemp(prefix="gpu-resource-rental-", suffix=".tmp", dir=str(self.path.parent))
            try:
                if os.name != "nt":
                    os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
                if os.name != "nt":
                    os.chmod(self.path, 0o600)
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise


class NvidiaGpuQuiescenceProbe:
    def sample(self, hardware_uuid: str) -> GpuQuiescenceSample:
        if SAFE_GPU_ID.fullmatch(hardware_uuid) is None:
            raise ExecutionControlError("rental_gpu_hardware_uuid_invalid")
        executable = find_nvidia_smi()
        if not executable:
            raise ExecutionControlError("rental_gpu_nvidia_smi_unavailable")
        result = run_command(
            [
                executable,
                f"--id={hardware_uuid}",
                "--query-gpu=uuid,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            timeout=12,
        )
        if result.returncode != 0:
            raise ExecutionControlError("rental_gpu_quiescence_inventory_failed")
        rows = list(csv.reader(line for line in result.stdout.splitlines() if line.strip()))
        if len(rows) != 1:
            raise ExecutionControlError("rental_gpu_quiescence_identity_not_unique")
        fields = [field.strip() for field in rows[0]]
        if len(fields) != 4 or fields[0].casefold() != hardware_uuid.casefold():
            raise ExecutionControlError("rental_gpu_quiescence_identity_mismatch")
        try:
            utilization = int(float(fields[1]))
            memory_used = int(float(fields[2]))
            memory_total = int(float(fields[3]))
        except ValueError as exc:
            raise ExecutionControlError("rental_gpu_quiescence_telemetry_invalid") from exc
        if not 0 <= utilization <= 100 or memory_total <= 0 or not 0 <= memory_used <= memory_total:
            raise ExecutionControlError("rental_gpu_quiescence_telemetry_invalid")

        compute = run_command(
            [
                executable,
                "--query-compute-apps=gpu_uuid,pid,used_gpu_memory",
                "--format=csv,noheader,nounits",
            ],
            timeout=12,
        )
        if compute.returncode != 0:
            raise ExecutionControlError("rental_gpu_compute_process_query_failed")
        pids: set[int] = set()
        for row in csv.reader(line for line in compute.stdout.splitlines() if line.strip()):
            values = [field.strip() for field in row]
            if len(values) < 2 or values[0].casefold() != hardware_uuid.casefold():
                continue
            try:
                pid = int(values[1])
            except ValueError as exc:
                raise ExecutionControlError("rental_gpu_compute_process_query_invalid") from exc
            if pid > 0:
                pids.add(pid)
        return GpuQuiescenceSample(
            hardware_uuid=hardware_uuid,
            utilization_percent=utilization,
            memory_used_mib=memory_used,
            memory_total_mib=memory_total,
            compute_pids=tuple(sorted(pids)),
        )

    def prove(self, hardware_uuid: str) -> GpuQuiescenceProof:
        samples: list[GpuQuiescenceSample] = []
        memory_threshold = 0
        for index in range(QUIESCENCE_SAMPLES):
            sample = self.sample(hardware_uuid)
            memory_threshold = max(
                QUIESCENCE_MIN_MEMORY_THRESHOLD_MIB,
                min(QUIESCENCE_MAX_MEMORY_THRESHOLD_MIB, int(sample.memory_total_mib * 0.03)),
            )
            if sample.compute_pids:
                raise ExecutionControlError("rental_gpu_compute_processes_present")
            if sample.utilization_percent > QUIESCENCE_MAX_UTILIZATION_PERCENT:
                raise ExecutionControlError("rental_gpu_utilization_not_quiescent")
            if sample.memory_used_mib > memory_threshold:
                raise ExecutionControlError("rental_gpu_memory_not_quiescent")
            samples.append(sample)
            if index + 1 < QUIESCENCE_SAMPLES:
                time.sleep(QUIESCENCE_INTERVAL_SECONDS)
        return GpuQuiescenceProof(
            hardware_uuid=hardware_uuid,
            samples=tuple(samples),
            memory_threshold_mib=memory_threshold,
            verified_at_ms=int(time.time() * 1000),
        )


def parse_rental_resource(session_id: str, value: Any) -> RentalResourceSpec:
    if SAFE_ID.fullmatch(session_id) is None or not isinstance(value, dict):
        raise ExecutionControlError("rental_resource_authority_invalid")
    lease = value.get("lease")
    if not isinstance(lease, dict):
        raise ExecutionControlError("rental_resource_lease_missing")
    resource_id = str(value.get("resourceId") or "")
    hardware_uuid = str(value.get("hardwareUuid") or "")
    holder_id = str(lease.get("holderId") or "")
    lease_id = str(lease.get("leaseId") or "")
    fencing_token = str(lease.get("fencingToken") or "")
    if (
        SAFE_ID.fullmatch(resource_id) is None
        or SAFE_GPU_ID.fullmatch(hardware_uuid) is None
        or SAFE_ID.fullmatch(holder_id) is None
        or SAFE_ID.fullmatch(lease_id) is None
        or str(lease.get("resourceId") or "") != resource_id
        or holder_id != f"rental:{session_id}"
        or not fencing_token.isdecimal()
    ):
        raise ExecutionControlError("rental_resource_authority_invalid")
    generation = int(fencing_token)
    if not 1 <= generation <= MAX_GENERATION:
        raise ExecutionControlError("rental_resource_fence_invalid")
    return RentalResourceSpec(
        session_id=session_id,
        resource_id=resource_id,
        hardware_uuid=hardware_uuid,
        runtime_generation=generation,
        holder_id=holder_id,
        lease_id=lease_id,
        fencing_token=fencing_token,
    )


def _record_identity(record: RuntimeRecord) -> ProcessIdentity | None:
    if record.pid is None or not record.executable_path or not record.process_creation_token:
        return None
    return ProcessIdentity(record.pid, record.executable_path, record.process_creation_token)


class RentalPreemptionSupervisor:
    def __init__(
        self,
        *,
        mining: GpuResourceSupervisor | None = None,
        claims: RentalClaimStore | None = None,
        probe: NvidiaGpuQuiescenceProbe | None = None,
    ) -> None:
        self.mining = mining or GpuResourceSupervisor()
        self.claims = claims or RentalClaimStore()
        self.probe = probe or NvidiaGpuQuiescenceProbe()
        self._lock = threading.RLock()

    def _quarantine(self, spec: RentalResourceSpec, error: str) -> None:
        claims = self.claims.load()
        claims[spec.resource_id] = RentalClaimRecord(
            session_id=spec.session_id,
            resource_id=spec.resource_id,
            hardware_uuid=spec.hardware_uuid,
            runtime_generation=spec.runtime_generation,
            holder_id=spec.holder_id,
            lease_id=spec.lease_id,
            fencing_token=spec.fencing_token,
            state="QUARANTINED",
            verified_at_ms=int(time.time() * 1000),
        )
        self.claims.save(claims)
        records = self.mining.store.load()
        record = records.get(spec.resource_id)
        if record is not None and record.hardware_uuid.casefold() == spec.hardware_uuid.casefold():
            record.state = "QUARANTINED"
            record.updated_at_ms = int(time.time() * 1000)
            self.mining.store.save(records)
        raise ExecutionControlError(error)

    def _write_claim(self, spec: RentalResourceSpec, state: str, verified_at_ms: int | None = None) -> None:
        claims = self.claims.load()
        claims[spec.resource_id] = RentalClaimRecord(
            session_id=spec.session_id,
            resource_id=spec.resource_id,
            hardware_uuid=spec.hardware_uuid,
            runtime_generation=spec.runtime_generation,
            holder_id=spec.holder_id,
            lease_id=spec.lease_id,
            fencing_token=spec.fencing_token,
            state=state,
            verified_at_ms=verified_at_ms if verified_at_ms is not None else int(time.time() * 1000),
        )
        self.claims.save(claims)

    def preempt_for_rental(self, spec: RentalResourceSpec) -> GpuQuiescenceProof:
        with _resource_transition_lock(spec.resource_id):
            claims = self.claims.load()
            previous_claim = claims.get(spec.resource_id)
            if previous_claim is not None:
                same = (
                    previous_claim.session_id == spec.session_id
                    and previous_claim.hardware_uuid.casefold() == spec.hardware_uuid.casefold()
                    and previous_claim.runtime_generation == spec.runtime_generation
                    and previous_claim.lease_id == spec.lease_id
                )
                if not same:
                    raise ExecutionControlError("rental_resource_claim_conflict")
                if previous_claim.state == "RENTAL_ACTIVE":
                    raise ExecutionControlError("rental_resource_already_active")
                if previous_claim.state == "QUIESCENT":
                    return self.probe.prove(spec.hardware_uuid)
                if previous_claim.state == "QUARANTINED":
                    raise ExecutionControlError("rental_resource_claim_quarantined")
                # PREEMPTING is a crash-recovery marker: resume the exact same
                # fenced transition rather than inventing a new local generation.

            records = self.mining.store.load()
            current = records.get(spec.resource_id)
            if current is not None:
                if current.hardware_uuid.casefold() != spec.hardware_uuid.casefold():
                    raise ExecutionControlError("rental_resource_hardware_identity_conflict")
                if current.runtime_generation > spec.runtime_generation:
                    raise ExecutionControlError("rental_resource_fence_stale")
                if current.state == "QUARANTINED":
                    raise ExecutionControlError("rental_resource_mining_quarantined")

            # Persist ownership intent before the first destructive action. If the
            # Agent crashes after this write, restart recovery remains fail-closed
            # and can resume only the exact session/resource/fence tuple.
            if previous_claim is None:
                self._write_claim(spec, "PREEMPTING")

            if current is not None and current.state == "MINING":
                if current.runtime_generation >= spec.runtime_generation:
                    self._quarantine(spec, "rental_resource_fence_not_newer_than_mining")
                expected = _record_identity(current)
                if expected is None:
                    self._quarantine(spec, "rental_miner_process_identity_missing")
                observed = self.mining.inspector.inspect(expected.pid)
                if observed is None:
                    # A previous attempt may have terminated the owned miner just
                    # before the Agent crashed. Quiescence below is the safety proof.
                    pass
                elif observed != expected:
                    self._quarantine(spec, "rental_miner_process_identity_mismatch")
                else:
                    self.mining.inspector.terminate(expected)
                    deadline = time.monotonic() + 30.0
                    while time.monotonic() < deadline:
                        observed = self.mining.inspector.inspect(expected.pid)
                        if observed is None:
                            break
                        if observed != expected:
                            self._quarantine(spec, "rental_miner_process_identity_mismatch")
                        time.sleep(0.1)
                    else:
                        self._quarantine(spec, "rental_miner_process_stop_unverified")

            if current is not None:
                current.runtime_generation = spec.runtime_generation
                current.state = "STOPPED"
                current.pid = None
                current.process_creation_token = None
                current.command_id = None
                current.updated_at_ms = int(time.time() * 1000)
            else:
                current = RuntimeRecord(
                    resource_id=spec.resource_id,
                    hardware_uuid=spec.hardware_uuid,
                    runtime_generation=spec.runtime_generation,
                    state="STOPPED",
                    updated_at_ms=int(time.time() * 1000),
                )
            records[spec.resource_id] = current
            self.mining.store.save(records)

            try:
                self.mining.binding_resolver(spec.hardware_uuid)
                proof = self.probe.prove(spec.hardware_uuid)
            except ExecutionControlError as exc:
                self._quarantine(spec, str(exc))

            self._write_claim(spec, "QUIESCENT", proof.verified_at_ms)
            return proof

    def mark_rental_active(self, spec: RentalResourceSpec) -> None:
        with _resource_transition_lock(spec.resource_id):
            claims = self.claims.load()
            claim = claims.get(spec.resource_id)
            if claim is None or claim.session_id != spec.session_id or claim.runtime_generation != spec.runtime_generation:
                raise ExecutionControlError("rental_resource_claim_missing")
            if claim.state == "QUARANTINED":
                raise ExecutionControlError("rental_resource_claim_quarantined")
            if claim.state != "QUIESCENT":
                raise ExecutionControlError("rental_resource_not_quiescent")
            claim.state = "RENTAL_ACTIVE"
            claim.verified_at_ms = int(time.time() * 1000)
            claims[spec.resource_id] = claim
            self.claims.save(claims)

    def claims_for_session(self, session_id: str) -> list[RentalClaimRecord]:
        return sorted(
            (claim for claim in self.claims.load().values() if claim.session_id == session_id),
            key=lambda claim: claim.resource_id,
        )

    def can_adopt_active(self, specs: list[RentalResourceSpec]) -> bool:
        if not specs:
            return False
        claims = self.claims.load()
        for spec in specs:
            claim = claims.get(spec.resource_id)
            if (
                claim is None
                or claim.state != "RENTAL_ACTIVE"
                or claim.session_id != spec.session_id
                or claim.runtime_generation != spec.runtime_generation
                or claim.hardware_uuid.casefold() != spec.hardware_uuid.casefold()
            ):
                return False
        return True

    def release_after_cleanup(self, session_id: str) -> list[RentalClaimRecord]:
        with self._lock:
            claims = self.claims.load()
            selected = sorted(
                (claim for claim in claims.values() if claim.session_id == session_id),
                key=lambda claim: claim.resource_id,
            )
            for claim in selected:
                with _resource_transition_lock(claim.resource_id):
                    if claim.state == "PREEMPTING":
                        raise ExecutionControlError("rental_resource_preemption_incomplete")
                    if claim.state == "QUARANTINED":
                        raise ExecutionControlError("rental_resource_claim_quarantined")
                    try:
                        self.probe.prove(claim.hardware_uuid)
                    except ExecutionControlError as exc:
                        spec = RentalResourceSpec(
                            claim.session_id,
                            claim.resource_id,
                            claim.hardware_uuid,
                            claim.runtime_generation,
                            claim.holder_id,
                            claim.lease_id,
                            claim.fencing_token,
                        )
                        self._quarantine(spec, str(exc))
            for claim in selected:
                claims.pop(claim.resource_id, None)
            self.claims.save(claims)
            return selected

    def assert_mining_allowed(self, resource_id: str, hardware_uuid: str) -> None:
        claim = self.claims.load().get(resource_id)
        if claim is None:
            return
        if claim.hardware_uuid.casefold() != hardware_uuid.casefold():
            raise ExecutionControlError("mining_resource_rental_identity_conflict")
        raise ExecutionControlError("mining_resource_owned_by_rental")


_DEFAULT_CLAIMS = RentalClaimStore()
_ORIGINAL_START: Any | None = None
_ORIGINAL_STOP: Any | None = None


def _assert_no_rental_claim(resource_id: str, hardware_uuid: str) -> None:
    claim = _DEFAULT_CLAIMS.load().get(resource_id)
    if claim is None:
        return
    if claim.hardware_uuid.casefold() != hardware_uuid.casefold():
        raise ExecutionControlError("mining_resource_rental_identity_conflict")
    raise ExecutionControlError("mining_resource_owned_by_rental")


def install_rental_mining_guard() -> None:
    """Serialize mining mutations against rental ownership for one resource."""
    global _ORIGINAL_START, _ORIGINAL_STOP
    if _ORIGINAL_START is not None:
        return
    original_start = GpuResourceSupervisor.start
    original_stop = GpuResourceSupervisor.stop
    _ORIGINAL_START = original_start
    _ORIGINAL_STOP = original_stop

    def guarded_start(self: GpuResourceSupervisor, payload: Any, command_id: str) -> ExecutionResult:
        if not isinstance(payload, dict):
            return original_start(self, payload, command_id)
        resource_id = payload.get("resourceId")
        hardware_uuid = payload.get("hardwareUuid")
        if not isinstance(resource_id, str) or not isinstance(hardware_uuid, str):
            return original_start(self, payload, command_id)
        with _resource_transition_lock(resource_id):
            _assert_no_rental_claim(resource_id, hardware_uuid)
            return original_start(self, payload, command_id)

    def guarded_stop(self: GpuResourceSupervisor, payload: Any) -> ExecutionResult:
        if not isinstance(payload, dict):
            return original_stop(self, payload)
        resource_id = payload.get("resourceId")
        hardware_uuid = payload.get("hardwareUuid")
        if not isinstance(resource_id, str) or not isinstance(hardware_uuid, str):
            return original_stop(self, payload)
        with _resource_transition_lock(resource_id):
            _assert_no_rental_claim(resource_id, hardware_uuid)
            return original_stop(self, payload)

    GpuResourceSupervisor.start = guarded_start  # type: ignore[method-assign]
    GpuResourceSupervisor.stop = guarded_stop  # type: ignore[method-assign]
