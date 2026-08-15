"""Resource-scoped GPU mining supervisor.

The always-running Agent is the authority for direct mining mutations.  This module
keeps one durable runtime record per MiningResource and never identifies a process
by PID alone.  A process is owned only when PID, creation token and canonical
approved executable path all match the record persisted when GPUbnb spawned it.

v1 deliberately qualifies NVIDIA + lolMiner only.  Unknown vendors/profiles fail
closed rather than silently falling back to machine-wide mining.
"""
from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

from .execution_control import (
    LOL_ALGORITHMS,
    ExecutionControlError,
    ExecutionResult,
    _sha256,
    _validate_argument,
    _validate_pool_url,
    _verified_binary,
)
from .mining_guard import miner_install_root
from .platform_info import find_nvidia_smi, run_command
from .storage import config_dir

SCHEMA_VERSION = 1
MAX_GENERATION = 9_223_372_036_854_775_807
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
SAFE_GPU_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")
SAFE_WORKER = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
SAFE_WALLET = re.compile(r"^[A-Za-z0-9_.:+-]{3,256}$")
PCI_BDF = re.compile(r"^(?:[0-9A-Fa-f]{4,8}:)?([0-9A-Fa-f]{2}):([0-9A-Fa-f]{2})\.[0-7]$")
RESOURCE_STATES = {"MINING", "STOPPED", "QUARANTINED"}


@dataclass(frozen=True)
class ResourceMiningSpec:
    resource_id: str
    hardware_uuid: str
    runtime_generation: int
    profile_id: str
    pool_url: str
    wallet_address: str
    worker_name: str
    performance_mode: str


@dataclass(frozen=True)
class ResourceStopSpec:
    resource_id: str
    hardware_uuid: str
    runtime_generation: int


@dataclass(frozen=True)
class GpuBinding:
    hardware_uuid: str
    pci_selector: str
    power_default_watts: float | None
    power_min_watts: float | None


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    executable_path: str
    creation_token: str


@dataclass
class RuntimeRecord:
    resource_id: str
    hardware_uuid: str
    runtime_generation: int
    state: str
    profile_id: str | None = None
    command_id: str | None = None
    pid: int | None = None
    executable_path: str | None = None
    binary_sha256: str | None = None
    process_creation_token: str | None = None
    updated_at_ms: int = 0

    @classmethod
    def parse(cls, resource_id: str, value: Any) -> "RuntimeRecord | None":
        if not isinstance(value, dict):
            return None
        try:
            generation = int(value["runtime_generation"])
            state = str(value["state"])
            hardware_uuid = str(value["hardware_uuid"])
        except (KeyError, TypeError, ValueError):
            return None
        if (
            not 0 <= generation <= MAX_GENERATION
            or state not in RESOURCE_STATES
            or SAFE_ID.fullmatch(resource_id) is None
            or SAFE_GPU_ID.fullmatch(hardware_uuid) is None
        ):
            return None
        pid = value.get("pid")
        return cls(
            resource_id=resource_id,
            hardware_uuid=hardware_uuid,
            runtime_generation=generation,
            state=state,
            profile_id=value.get("profile_id") if isinstance(value.get("profile_id"), str) else None,
            command_id=value.get("command_id") if isinstance(value.get("command_id"), str) else None,
            pid=pid if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 else None,
            executable_path=value.get("executable_path") if isinstance(value.get("executable_path"), str) else None,
            binary_sha256=value.get("binary_sha256") if isinstance(value.get("binary_sha256"), str) else None,
            process_creation_token=value.get("process_creation_token") if isinstance(value.get("process_creation_token"), str) else None,
            updated_at_ms=int(value.get("updated_at_ms", 0)) if isinstance(value.get("updated_at_ms", 0), int) else 0,
        )


class SpawnedProcess(Protocol):
    @property
    def pid(self) -> int: ...

    def poll(self) -> int | None: ...

    def terminate_owned(self) -> None: ...


class ProcessLauncher(Protocol):
    def spawn(self, executable: Path, arguments: list[str], cwd: Path) -> SpawnedProcess: ...


class ProcessInspector(Protocol):
    def inspect(self, pid: int) -> ProcessIdentity | None: ...

    def terminate(self, identity: ProcessIdentity) -> None: ...


class _PopenHandle:
    def __init__(self, process: subprocess.Popen[Any]) -> None:
        self._process = process

    @property
    def pid(self) -> int:
        return int(self._process.pid)

    def poll(self) -> int | None:
        return self._process.poll()

    def terminate_owned(self) -> None:
        try:
            self._process.kill()
        except OSError:
            pass


class SystemLauncher:
    def spawn(self, executable: Path, arguments: list[str], cwd: Path) -> SpawnedProcess:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        try:
            child = subprocess.Popen(
                [str(executable), *arguments],
                cwd=str(cwd),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                creationflags=flags,
                start_new_session=os.name != "nt",
            )
        except OSError as exc:
            raise ExecutionControlError("miner_process_spawn_failed") from exc
        return _PopenHandle(child)


class SystemProcessInspector:
    def inspect(self, pid: int) -> ProcessIdentity | None:
        if pid <= 0:
            return None
        if os.name == "nt":
            command = (
                f"$p=Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\" | "
                "Select-Object -First 1 ProcessId,ExecutablePath,CreationDate;"
                "if($null -eq $p){exit 3};$p|ConvertTo-Json -Compress"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                shell=False,
            )
            if result.returncode != 0:
                return None
            try:
                value = json.loads(result.stdout)
                path = str(value["ExecutablePath"])
                token = str(value["CreationDate"])
                returned_pid = int(value["ProcessId"])
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                raise ExecutionControlError("miner_process_identity_unreadable")
            if returned_pid != pid or not path or not token:
                raise ExecutionControlError("miner_process_identity_unreadable")
            try:
                canonical = str(Path(path).resolve(strict=True))
            except OSError as exc:
                raise ExecutionControlError("miner_process_identity_unreadable") from exc
            return ProcessIdentity(pid, canonical, token)

        proc = Path("/proc") / str(pid)
        try:
            executable = str((proc / "exe").resolve(strict=True))
            raw_stat = (proc / "stat").read_text(encoding="ascii")
        except (FileNotFoundError, ProcessLookupError):
            return None
        except OSError as exc:
            raise ExecutionControlError("miner_process_identity_unreadable") from exc
        end = raw_stat.rfind(")")
        if end < 0:
            raise ExecutionControlError("miner_process_identity_unreadable")
        fields = raw_stat[end + 2 :].split()
        if len(fields) <= 19:
            raise ExecutionControlError("miner_process_identity_unreadable")
        return ProcessIdentity(pid, executable, fields[19])

    def terminate(self, identity: ProcessIdentity) -> None:
        current = self.inspect(identity.pid)
        if current is None:
            return
        if current != identity:
            raise ExecutionControlError("miner_process_identity_mismatch")
        if os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/PID", str(identity.pid), "/F", "/T"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                shell=False,
            )
            if result.returncode not in {0, 128}:
                raise ExecutionControlError("miner_process_stop_failed")
        else:
            try:
                os.kill(identity.pid, 9)
            except ProcessLookupError:
                return
            except OSError as exc:
                raise ExecutionControlError("miner_process_stop_failed") from exc


class RuntimeStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (config_dir() / "gpu-resource-runtime-v1.json")
        self._lock = threading.RLock()

    def load(self) -> dict[str, RuntimeRecord]:
        with self._lock:
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {}
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise ExecutionControlError("gpu_resource_runtime_state_corrupt") from exc
            if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
                raise ExecutionControlError("gpu_resource_runtime_state_schema_invalid")
            resources = raw.get("resources")
            if not isinstance(resources, dict):
                raise ExecutionControlError("gpu_resource_runtime_state_corrupt")
            parsed: dict[str, RuntimeRecord] = {}
            for resource_id, value in resources.items():
                if not isinstance(resource_id, str):
                    raise ExecutionControlError("gpu_resource_runtime_state_corrupt")
                record = RuntimeRecord.parse(resource_id, value)
                if record is None:
                    raise ExecutionControlError("gpu_resource_runtime_state_corrupt")
                parsed[resource_id] = record
            return parsed

    def save(self, records: dict[str, RuntimeRecord]) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(prefix=".gpu-runtime-", dir=self.path.parent, text=True)
            try:
                if os.name != "nt":
                    os.fchmod(fd, 0o600)
                payload = {
                    "schemaVersion": SCHEMA_VERSION,
                    "resources": {
                        resource_id: asdict(record)
                        for resource_id, record in sorted(records.items())
                    },
                }
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
                if os.name != "nt":
                    self.path.chmod(0o600)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)


def _positive_generation(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_GENERATION:
        raise ExecutionControlError("mining_runtime_generation_invalid")
    return value


def _required_text(payload: dict[str, Any], name: str, pattern: re.Pattern[str], error: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ExecutionControlError(error)
    return value


def parse_resource_start(payload: Any) -> ResourceMiningSpec:
    if not isinstance(payload, dict):
        raise ExecutionControlError("mining_command_payload_invalid")
    allowed = {
        "resourceId", "hardwareUuid", "runtimeGeneration", "profileId", "poolUrl",
        "walletAddress", "workerName", "performanceMode", "poolCredentialRef",
    }
    if set(payload) - allowed:
        raise ExecutionControlError("mining_command_payload_unknown_field")
    if payload.get("poolCredentialRef") not in {None, ""}:
        raise ExecutionControlError("miner_secret_resolution_required")
    resource_id = _required_text(payload, "resourceId", SAFE_ID, "mining_resource_id_invalid")
    hardware_uuid = _required_text(payload, "hardwareUuid", SAFE_GPU_ID, "mining_hardware_uuid_invalid")
    profile_id = payload.get("profileId")
    if not isinstance(profile_id, str) or profile_id not in LOL_ALGORITHMS:
        raise ExecutionControlError("mining_profile_not_resource_gpu_approved")
    pool = payload.get("poolUrl")
    wallet = payload.get("walletAddress")
    worker = payload.get("workerName")
    performance = payload.get("performanceMode", "BALANCED")
    if not isinstance(pool, str):
        raise ExecutionControlError("mining_pool_url_invalid")
    if not isinstance(wallet, str) or SAFE_WALLET.fullmatch(wallet) is None:
        raise ExecutionControlError("mining_wallet_invalid")
    if not isinstance(worker, str) or SAFE_WORKER.fullmatch(worker) is None:
        raise ExecutionControlError("mining_worker_invalid")
    if performance not in {"ECO", "BALANCED", "FULL"}:
        raise ExecutionControlError("mining_performance_mode_invalid")
    return ResourceMiningSpec(
        resource_id,
        hardware_uuid,
        _positive_generation(payload.get("runtimeGeneration")),
        profile_id,
        _validate_pool_url(pool),
        wallet,
        worker,
        performance,
    )


def parse_resource_stop(payload: Any) -> ResourceStopSpec:
    if not isinstance(payload, dict) or set(payload) != {"resourceId", "hardwareUuid", "runtimeGeneration"}:
        raise ExecutionControlError("mining_stop_payload_invalid")
    return ResourceStopSpec(
        _required_text(payload, "resourceId", SAFE_ID, "mining_resource_id_invalid"),
        _required_text(payload, "hardwareUuid", SAFE_GPU_ID, "mining_hardware_uuid_invalid"),
        _positive_generation(payload.get("runtimeGeneration")),
    )


def resolve_nvidia_binding(hardware_uuid: str) -> GpuBinding:
    executable = find_nvidia_smi()
    if not executable:
        raise ExecutionControlError("resource_gpu_nvidia_smi_unavailable")
    query = "uuid,pci.bus_id,power.default_limit,power.min_limit"
    result = run_command([executable, f"--query-gpu={query}", "--format=csv,noheader,nounits"], timeout=12)
    if result.returncode != 0:
        raise ExecutionControlError("resource_gpu_inventory_unavailable")
    matches: list[GpuBinding] = []
    for values in csv.reader(line for line in result.stdout.splitlines() if line.strip()):
        fields = [field.strip() for field in values]
        if len(fields) != 4 or fields[0].casefold() != hardware_uuid.casefold():
            continue
        pci = PCI_BDF.fullmatch(fields[1])
        if pci is None:
            raise ExecutionControlError("resource_gpu_pci_identity_invalid")
        try:
            default = None if fields[2].upper() in {"N/A", "[N/A]"} else float(fields[2])
            minimum = None if fields[3].upper() in {"N/A", "[N/A]"} else float(fields[3])
        except ValueError as exc:
            raise ExecutionControlError("resource_gpu_power_limits_invalid") from exc
        matches.append(GpuBinding(hardware_uuid, f"{pci.group(1)}:{pci.group(2)}", default, minimum))
    if len(matches) != 1:
        raise ExecutionControlError("resource_gpu_identity_not_unique" if matches else "resource_gpu_not_present")
    return matches[0]


def build_resource_arguments(spec: ResourceMiningSpec, binding: GpuBinding) -> list[str]:
    user = f"{spec.wallet_address}.{spec.worker_name}"
    _validate_argument(user, "miner_argument_invalid")
    algorithm = LOL_ALGORITHMS.get(spec.profile_id)
    if algorithm is None:
        raise ExecutionControlError("mining_profile_not_resource_gpu_approved")
    arguments = [
        "--algo", algorithm,
        "--pool", spec.pool_url,
        "--user", user,
        "--devicesbypcie", "on",
        "--devices", binding.pci_selector,
    ]
    if spec.performance_mode != "FULL":
        default, minimum = binding.power_default_watts, binding.power_min_watts
        if default is None or minimum is None or default <= 0 or minimum <= 0 or minimum > default:
            raise ExecutionControlError("resource_gpu_power_limits_unavailable")
        ratio = 0.66 if spec.performance_mode == "BALANCED" else 0.33
        target = round(max(minimum, min(default, default * ratio)))
        arguments.extend(["--pl", str(target)])
    return arguments


def _record_identity(record: RuntimeRecord) -> ProcessIdentity | None:
    if record.pid is None or not record.executable_path or not record.process_creation_token:
        return None
    return ProcessIdentity(record.pid, record.executable_path, record.process_creation_token)


class GpuResourceSupervisor:
    def __init__(
        self,
        *,
        store: RuntimeStore | None = None,
        inspector: ProcessInspector | None = None,
        launcher: ProcessLauncher | None = None,
        binding_resolver: Any = None,
    ) -> None:
        self.store = store or RuntimeStore()
        self.inspector = inspector or SystemProcessInspector()
        self.launcher = launcher or SystemLauncher()
        self.binding_resolver = binding_resolver or resolve_nvidia_binding
        self._lock = threading.RLock()
        self.reconcile()

    def reconcile(self) -> dict[str, str]:
        with self._lock:
            records = self.store.load()
            changed = False
            outcome: dict[str, str] = {}
            for resource_id, record in records.items():
                if record.state != "MINING":
                    outcome[resource_id] = record.state
                    continue
                expected = _record_identity(record)
                if expected is None:
                    record.state = "QUARANTINED"
                    outcome[resource_id] = record.state
                    changed = True
                    continue
                current = self.inspector.inspect(expected.pid)
                if current is None:
                    record.state = "STOPPED"
                    record.pid = None
                    record.process_creation_token = None
                    outcome[resource_id] = record.state
                    changed = True
                elif current != expected:
                    record.state = "QUARANTINED"
                    outcome[resource_id] = record.state
                    changed = True
                else:
                    outcome[resource_id] = "MINING"
            if changed:
                self.store.save(records)
            return outcome

    def start(self, payload: Any, command_id: str) -> ExecutionResult:
        spec = parse_resource_start(payload)
        if SAFE_ID.fullmatch(command_id) is None:
            raise ExecutionControlError("mining_command_id_invalid")
        binding = self.binding_resolver(spec.hardware_uuid)
        root = miner_install_root()
        executable = _verified_binary(spec.profile_id, root)
        binary_sha = _sha256(executable)
        arguments = build_resource_arguments(spec, binding)

        with self._lock:
            records = self.store.load()
            current = records.get(spec.resource_id)
            if current is not None:
                if current.hardware_uuid.casefold() != spec.hardware_uuid.casefold():
                    raise ExecutionControlError("mining_resource_hardware_identity_conflict")
                if spec.runtime_generation < current.runtime_generation:
                    raise ExecutionControlError("mining_runtime_generation_stale")
                if current.state == "QUARANTINED":
                    raise ExecutionControlError("mining_resource_quarantined")
                if spec.runtime_generation == current.runtime_generation:
                    expected = _record_identity(current)
                    observed = self.inspector.inspect(expected.pid) if expected else None
                    if current.state == "MINING" and expected is not None and observed == expected:
                        return ExecutionResult("mining_resource_already_running")
                    raise ExecutionControlError("mining_runtime_generation_replay")
                if current.state == "MINING":
                    expected = _record_identity(current)
                    observed = self.inspector.inspect(expected.pid) if expected else None
                    if expected is not None and observed == expected:
                        raise ExecutionControlError("mining_resource_runtime_busy")
                    if observed is not None:
                        current.state = "QUARANTINED"
                        self.store.save(records)
                        raise ExecutionControlError("miner_process_identity_mismatch")

            for other_id, other in records.items():
                if other_id == spec.resource_id or other.state != "MINING":
                    continue
                if other.hardware_uuid.casefold() != spec.hardware_uuid.casefold():
                    continue
                expected = _record_identity(other)
                if expected is not None and self.inspector.inspect(expected.pid) == expected:
                    raise ExecutionControlError("resource_gpu_already_owned")

            child = self.launcher.spawn(executable, arguments, root)
            time.sleep(0.05)
            if child.poll() is not None:
                raise ExecutionControlError("miner_process_exited_during_start")
            identity: ProcessIdentity | None = None
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                identity = self.inspector.inspect(child.pid)
                if identity is not None:
                    break
                time.sleep(0.05)
            if identity is None:
                child.terminate_owned()
                raise ExecutionControlError("miner_process_identity_unavailable")
            try:
                canonical_executable = str(executable.resolve(strict=True))
            except OSError as exc:
                child.terminate_owned()
                raise ExecutionControlError("approved_miner_binary_missing") from exc
            if identity.executable_path != canonical_executable:
                child.terminate_owned()
                raise ExecutionControlError("miner_process_identity_mismatch")

            records[spec.resource_id] = RuntimeRecord(
                resource_id=spec.resource_id,
                hardware_uuid=spec.hardware_uuid,
                runtime_generation=spec.runtime_generation,
                state="MINING",
                profile_id=spec.profile_id,
                command_id=command_id,
                pid=identity.pid,
                executable_path=identity.executable_path,
                binary_sha256=binary_sha,
                process_creation_token=identity.creation_token,
                updated_at_ms=int(time.time() * 1000),
            )
            self.store.save(records)
            return ExecutionResult("mining_resource_started_verified")

    def stop(self, payload: Any) -> ExecutionResult:
        spec = parse_resource_stop(payload)
        with self._lock:
            records = self.store.load()
            current = records.get(spec.resource_id)
            if current is None:
                return ExecutionResult("mining_resource_already_stopped")
            if current.hardware_uuid.casefold() != spec.hardware_uuid.casefold():
                raise ExecutionControlError("mining_resource_hardware_identity_conflict")
            if spec.runtime_generation < current.runtime_generation:
                raise ExecutionControlError("mining_runtime_generation_stale")
            if spec.runtime_generation > current.runtime_generation:
                raise ExecutionControlError("mining_runtime_generation_future")
            if current.state == "STOPPED":
                return ExecutionResult("mining_resource_already_stopped")
            if current.state == "QUARANTINED":
                raise ExecutionControlError("mining_resource_quarantined")
            expected = _record_identity(current)
            if expected is None:
                current.state = "QUARANTINED"
                current.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                raise ExecutionControlError("miner_process_identity_missing")
            observed = self.inspector.inspect(expected.pid)
            if observed is None:
                current.state = "STOPPED"
                current.pid = None
                current.process_creation_token = None
                current.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                return ExecutionResult("mining_resource_already_stopped")
            if observed != expected:
                current.state = "QUARANTINED"
                current.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                raise ExecutionControlError("miner_process_identity_mismatch")

            self.inspector.terminate(expected)
            deadline = time.monotonic() + 30.0
            while time.monotonic() < deadline:
                observed = self.inspector.inspect(expected.pid)
                if observed is None:
                    break
                if observed != expected:
                    current.state = "QUARANTINED"
                    current.updated_at_ms = int(time.time() * 1000)
                    self.store.save(records)
                    raise ExecutionControlError("miner_process_identity_mismatch")
                time.sleep(0.1)
            else:
                raise ExecutionControlError("mining_resource_stop_unverified")

            current.state = "STOPPED"
            current.pid = None
            current.process_creation_token = None
            current.updated_at_ms = int(time.time() * 1000)
            self.store.save(records)
            return ExecutionResult("mining_resource_stop_verified")

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {resource_id: asdict(record) for resource_id, record in self.store.load().items()}
