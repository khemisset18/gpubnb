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
WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
DEFAULT_THERMAL_STOP_CELSIUS = 85
MIN_THERMAL_STOP_CELSIUS = 85
MAX_THERMAL_STOP_CELSIUS = 98
THERMAL_QUARANTINE_CELSIUS = 98
THERMAL_SENSOR_FAILURE_LIMIT = 3
THERMAL_WARNING_THRESHOLDS = (85, 90, 94, 97)
MAX_MINER_OUTPUT_BYTES = 256 * 1024
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


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
    thermal_stop_celsius: int


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
    thermal_stop_celsius: int = DEFAULT_THERMAL_STOP_CELSIUS
    last_temperature_celsius: float | None = None
    thermal_warning_level: int | None = None
    thermal_sensor_failures: int = 0
    last_stop_reason: str | None = None
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
        thermal_stop = value.get("thermal_stop_celsius", DEFAULT_THERMAL_STOP_CELSIUS)
        sensor_failures = value.get("thermal_sensor_failures", 0)
        warning_level = value.get("thermal_warning_level")
        raw_temperature = value.get("last_temperature_celsius")
        if (
            not 0 <= generation <= MAX_GENERATION
            or state not in RESOURCE_STATES
            or SAFE_ID.fullmatch(resource_id) is None
            or SAFE_GPU_ID.fullmatch(hardware_uuid) is None
            or isinstance(thermal_stop, bool)
            or not isinstance(thermal_stop, int)
            or not MIN_THERMAL_STOP_CELSIUS <= thermal_stop <= MAX_THERMAL_STOP_CELSIUS
            or isinstance(sensor_failures, bool)
            or not isinstance(sensor_failures, int)
            or not 0 <= sensor_failures <= THERMAL_SENSOR_FAILURE_LIMIT
            or warning_level not in {None, *THERMAL_WARNING_THRESHOLDS}
            or (
                raw_temperature is not None
                and (
                    isinstance(raw_temperature, bool)
                    or not isinstance(raw_temperature, (int, float))
                    or not 0 <= float(raw_temperature) <= 150
                )
            )
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
            thermal_stop_celsius=thermal_stop,
            last_temperature_celsius=float(raw_temperature) if raw_temperature is not None else None,
            thermal_warning_level=warning_level,
            thermal_sensor_failures=sensor_failures,
            last_stop_reason=value.get("last_stop_reason") if isinstance(value.get("last_stop_reason"), str) else None,
            updated_at_ms=int(value.get("updated_at_ms", 0)) if isinstance(value.get("updated_at_ms", 0), int) else 0,
        )


class SpawnedProcess(Protocol):
    @property
    def pid(self) -> int: ...

    def poll(self) -> int | None: ...

    def terminate_owned(self) -> None: ...

    def output_tail(self) -> str: ...


class ProcessLauncher(Protocol):
    def spawn(self, executable: Path, arguments: list[str], cwd: Path) -> SpawnedProcess: ...


class ProcessInspector(Protocol):
    def inspect(self, pid: int) -> ProcessIdentity | None: ...

    def terminate(self, identity: ProcessIdentity) -> None: ...


class _BoundedOutput:
    def __init__(self, maximum_bytes: int = MAX_MINER_OUTPUT_BYTES) -> None:
        self.maximum_bytes = maximum_bytes
        self._buffer = bytearray()
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self._lock:
            self._buffer.extend(chunk)
            overflow = len(self._buffer) - self.maximum_bytes
            if overflow > 0:
                del self._buffer[:overflow]

    def text(self) -> str:
        with self._lock:
            return bytes(self._buffer).decode("utf-8", errors="replace")


def _drain_process_output(stream: Any, output: _BoundedOutput) -> None:
    try:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                return
            output.append(chunk)
    except (OSError, ValueError):
        return


class _PopenHandle:
    def __init__(self, process: subprocess.Popen[Any], stream: Any) -> None:
        self._process = process
        self._output = _BoundedOutput()
        self._reader = threading.Thread(
            target=_drain_process_output,
            args=(stream, self._output),
            name=f"gpubnb-miner-output-{process.pid}",
            daemon=True,
        )
        self._reader.start()

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

    def output_tail(self) -> str:
        return self._output.text()


class SystemLauncher:
    def spawn(self, executable: Path, arguments: list[str], cwd: Path) -> SpawnedProcess:
        flags = (
            subprocess.CREATE_NEW_PROCESS_GROUP | WINDOWS_CREATE_NO_WINDOW
            if os.name == "nt"
            else 0
        )
        try:
            child = subprocess.Popen(
                [str(executable), *arguments],
                cwd=str(cwd),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                shell=False,
                creationflags=flags,
                start_new_session=os.name != "nt",
            )
        except OSError as exc:
            raise ExecutionControlError("miner_process_spawn_failed") from exc
        if child.stdout is None:
            try:
                child.kill()
            except OSError:
                pass
            raise ExecutionControlError("miner_output_capture_unavailable")
        return _PopenHandle(child, child.stdout)


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
            result = run_command(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                timeout=10,
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
            result = run_command(
                ["taskkill", "/PID", str(identity.pid), "/F", "/T"],
                timeout=10,
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
        "thermalStopCelsius",
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
    thermal_stop = payload.get("thermalStopCelsius", DEFAULT_THERMAL_STOP_CELSIUS)
    if not isinstance(pool, str):
        raise ExecutionControlError("mining_pool_url_invalid")
    if not isinstance(wallet, str) or SAFE_WALLET.fullmatch(wallet) is None:
        raise ExecutionControlError("mining_wallet_invalid")
    if not isinstance(worker, str) or SAFE_WORKER.fullmatch(worker) is None:
        raise ExecutionControlError("mining_worker_invalid")
    if performance not in {"ECO", "BALANCED", "FULL"}:
        raise ExecutionControlError("mining_performance_mode_invalid")
    if (
        isinstance(thermal_stop, bool)
        or not isinstance(thermal_stop, int)
        or not MIN_THERMAL_STOP_CELSIUS <= thermal_stop <= MAX_THERMAL_STOP_CELSIUS
    ):
        raise ExecutionControlError("mining_thermal_stop_invalid")
    return ResourceMiningSpec(
        resource_id,
        hardware_uuid,
        _positive_generation(payload.get("runtimeGeneration")),
        profile_id,
        _validate_pool_url(pool),
        wallet,
        worker,
        performance,
        thermal_stop,
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


@dataclass(frozen=True)
class GpuRuntimeMetrics:
    hardware_uuid: str
    device_name: str | None
    utilization_percent: float | None
    memory_used_mib: float | None
    temperature_celsius: float
    power_watts: float | None


def _optional_float(value: str) -> float | None:
    normalized = value.strip()
    if normalized.upper() in {"N/A", "[N/A]", ""}:
        return None
    try:
        result = float(normalized)
    except ValueError as exc:
        raise ExecutionControlError("resource_gpu_telemetry_invalid") from exc
    if not result >= 0:
        raise ExecutionControlError("resource_gpu_telemetry_invalid")
    return result


def read_nvidia_runtime_metrics(hardware_uuid: str) -> GpuRuntimeMetrics:
    executable = find_nvidia_smi()
    if not executable:
        raise ExecutionControlError("resource_gpu_nvidia_smi_unavailable")
    query = "uuid,name,utilization.gpu,memory.used,temperature.gpu,power.draw"
    result = run_command(
        [executable, f"--query-gpu={query}", "--format=csv,noheader,nounits"],
        timeout=12,
    )
    if result.returncode != 0:
        raise ExecutionControlError("resource_gpu_telemetry_unavailable")
    matches: list[GpuRuntimeMetrics] = []
    for values in csv.reader(line for line in result.stdout.splitlines() if line.strip()):
        fields = [field.strip() for field in values]
        if len(fields) != 6 or fields[0].casefold() != hardware_uuid.casefold():
            continue
        temperature = _optional_float(fields[4])
        if temperature is None or temperature > 150:
            raise ExecutionControlError("resource_gpu_temperature_invalid")
        matches.append(
            GpuRuntimeMetrics(
                hardware_uuid=hardware_uuid,
                device_name=fields[1] or None,
                utilization_percent=_optional_float(fields[2]),
                memory_used_mib=_optional_float(fields[3]),
                temperature_celsius=temperature,
                power_watts=_optional_float(fields[5]),
            )
        )
    if len(matches) != 1:
        raise ExecutionControlError(
            "resource_gpu_identity_not_unique" if matches else "resource_gpu_not_present"
        )
    return matches[0]


def _parse_uptime_seconds(value: str) -> int | None:
    total = 0
    found = False
    for token in value.split():
        if len(token) < 2:
            continue
        suffix = token[-1]
        multiplier = {"h": 3600, "m": 60, "s": 1}.get(suffix)
        if multiplier is None:
            continue
        try:
            amount = int(token[:-1])
        except ValueError:
            continue
        if amount < 0:
            return None
        total += amount * multiplier
        found = True
    return total if found else None


def _parse_share_triplet(value: str) -> tuple[int, int, int] | None:
    try:
        parts = tuple(int(item) for item in value.split("/"))
    except ValueError:
        return None
    if len(parts) != 3 or any(item < 0 for item in parts):
        return None
    return parts[0], parts[1], parts[2]


def parse_lolminer_output(output: str) -> dict[str, Any]:
    session = output.rsplit("Setup Miner...", 1)[-1]
    telemetry: dict[str, Any] = {
        "hashrate": None,
        "hashrateUnit": None,
        "acceptedShares": None,
        "staleShares": None,
        "hardwareErrors": None,
        "uptimeSeconds": None,
        "poolConnected": "Authorized worker:" in session or "Connected to:" in session,
    }
    for raw_line in session.splitlines():
        line = ANSI_ESCAPE.sub("", raw_line).replace("\r", "").strip()
        if line.startswith("Statistics (") and "Uptime:" in line:
            telemetry["uptimeSeconds"] = _parse_uptime_seconds(line.split("Uptime:", 1)[1].strip())
            continue
        fields = line.split()
        if len(fields) < 8 or fields[0] != "GPU" or not fields[1].isdigit():
            continue
        share_index = next(
            (index for index, field in enumerate(fields) if _parse_share_triplet(field) is not None),
            None,
        )
        if share_index is None or share_index < 4:
            continue
        try:
            hashrate = float(fields[share_index - 2])
        except ValueError:
            continue
        shares = _parse_share_triplet(fields[share_index])
        if shares is None or hashrate < 0:
            continue
        telemetry["hashrate"] = hashrate
        # Current approved lolMiner profiles expose the primary performance
        # column in MH/s. Association to the physical GPU comes from the exact
        # UUID-bound process record, never from lolMiner's local GPU index.
        telemetry["hashrateUnit"] = "MH/s"
        telemetry["acceptedShares"], telemetry["staleShares"], telemetry["hardwareErrors"] = shares
    return telemetry


def read_nvidia_temperature(hardware_uuid: str) -> float:
    executable = find_nvidia_smi()
    if not executable:
        raise ExecutionControlError("resource_gpu_nvidia_smi_unavailable")
    result = run_command(
        [executable, "--query-gpu=uuid,temperature.gpu", "--format=csv,noheader,nounits"],
        timeout=12,
    )
    if result.returncode != 0:
        raise ExecutionControlError("resource_gpu_temperature_unavailable")
    matches: list[float] = []
    for values in csv.reader(line for line in result.stdout.splitlines() if line.strip()):
        fields = [field.strip() for field in values]
        if len(fields) != 2 or fields[0].casefold() != hardware_uuid.casefold():
            continue
        try:
            temperature = float(fields[1])
        except ValueError as exc:
            raise ExecutionControlError("resource_gpu_temperature_invalid") from exc
        if not 0 <= temperature <= 150:
            raise ExecutionControlError("resource_gpu_temperature_invalid")
        matches.append(temperature)
    if len(matches) != 1:
        raise ExecutionControlError(
            "resource_gpu_identity_not_unique" if matches else "resource_gpu_not_present"
        )
    return matches[0]


def _thermal_warning_level(temperature_celsius: float) -> int | None:
    level: int | None = None
    for threshold in THERMAL_WARNING_THRESHOLDS:
        if temperature_celsius >= threshold:
            level = threshold
    return level


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
        temperature_reader: Any = None,
    ) -> None:
        self.store = store or RuntimeStore()
        self.inspector = inspector or SystemProcessInspector()
        self.launcher = launcher or SystemLauncher()
        self.binding_resolver = binding_resolver or resolve_nvidia_binding
        self.temperature_reader = temperature_reader or read_nvidia_temperature
        self.metrics_reader = read_nvidia_runtime_metrics
        self._process_handles: dict[str, SpawnedProcess] = {}
        self._lock = threading.RLock()
        self.reconcile()

    def _terminate_and_verify(self, expected: ProcessIdentity, timeout_seconds: float = 30.0) -> None:
        self.inspector.terminate(expected)
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            observed = self.inspector.inspect(expected.pid)
            if observed is None:
                return
            if observed != expected:
                raise ExecutionControlError("miner_process_identity_mismatch")
            time.sleep(0.1)
        raise ExecutionControlError("mining_resource_stop_unverified")

    @staticmethod
    def _clear_process(record: RuntimeRecord) -> None:
        record.pid = None
        record.process_creation_token = None

    @staticmethod
    def _binary_integrity_ok(record: RuntimeRecord) -> bool:
        if not record.executable_path or not record.binary_sha256:
            return False
        try:
            return _sha256(Path(record.executable_path)) == record.binary_sha256
        except (OSError, ExecutionControlError):
            return False

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
                    record.last_stop_reason = "PROCESS_IDENTITY_MISSING"
                    outcome[resource_id] = record.state
                    changed = True
                    continue
                current = self.inspector.inspect(expected.pid)
                if current is None:
                    record.state = "STOPPED"
                    record.last_stop_reason = "PROCESS_MISSING"
                    self._clear_process(record)
                    outcome[resource_id] = record.state
                    changed = True
                    continue
                if current != expected:
                    record.state = "QUARANTINED"
                    record.last_stop_reason = "PROCESS_IDENTITY_MISMATCH"
                    outcome[resource_id] = record.state
                    changed = True
                    continue
                if not self._binary_integrity_ok(record):
                    try:
                        self._terminate_and_verify(expected)
                        self._clear_process(record)
                    except ExecutionControlError:
                        pass
                    record.state = "QUARANTINED"
                    record.last_stop_reason = "BINARY_INTEGRITY"
                    record.updated_at_ms = int(time.time() * 1000)
                    outcome[resource_id] = record.state
                    changed = True
                    continue
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
        temperature = self.temperature_reader(spec.hardware_uuid)
        if temperature >= THERMAL_QUARANTINE_CELSIUS:
            raise ExecutionControlError("resource_gpu_temperature_quarantine_threshold")
        if temperature >= spec.thermal_stop_celsius:
            raise ExecutionControlError("resource_gpu_temperature_above_limit")

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
                    if (
                        current.state == "MINING"
                        and expected is not None
                        and observed == expected
                        and self._binary_integrity_ok(current)
                    ):
                        return ExecutionResult("mining_resource_already_running")
                    raise ExecutionControlError("mining_runtime_generation_replay")
                if current.state == "MINING":
                    expected = _record_identity(current)
                    observed = self.inspector.inspect(expected.pid) if expected else None
                    if expected is not None and observed == expected:
                        raise ExecutionControlError("mining_resource_runtime_busy")
                    if observed is not None:
                        current.state = "QUARANTINED"
                        current.last_stop_reason = "PROCESS_IDENTITY_MISMATCH"
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
                thermal_stop_celsius=spec.thermal_stop_celsius,
                last_temperature_celsius=temperature,
                thermal_warning_level=_thermal_warning_level(temperature),
                updated_at_ms=int(time.time() * 1000),
            )
            self.store.save(records)
            self._process_handles[spec.resource_id] = child
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
                current.last_stop_reason = "PROCESS_IDENTITY_MISSING"
                current.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                raise ExecutionControlError("miner_process_identity_missing")
            observed = self.inspector.inspect(expected.pid)
            if observed is None:
                current.state = "STOPPED"
                current.last_stop_reason = "PROCESS_MISSING"
                self._clear_process(current)
                current.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                return ExecutionResult("mining_resource_already_stopped")
            if observed != expected:
                current.state = "QUARANTINED"
                current.last_stop_reason = "PROCESS_IDENTITY_MISMATCH"
                current.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                raise ExecutionControlError("miner_process_identity_mismatch")

            self._terminate_and_verify(expected)
            self._process_handles.pop(spec.resource_id, None)
            current.state = "STOPPED"
            current.last_stop_reason = "CONTROL_STOP"
            self._clear_process(current)
            current.updated_at_ms = int(time.time() * 1000)
            self.store.save(records)
            return ExecutionResult("mining_resource_stop_verified")

    def poll_thermal_safety(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        with self._lock:
            records = self.store.load()
            changed = False
            for resource_id, record in records.items():
                if record.state != "MINING":
                    continue

                expected = _record_identity(record)
                if expected is None:
                    record.state = "QUARANTINED"
                    record.last_stop_reason = "PROCESS_IDENTITY_MISSING"
                    record.updated_at_ms = int(time.time() * 1000)
                    events.append({
                        "event": "mining_resource_quarantined",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "reason": record.last_stop_reason,
                    })
                    changed = True
                    continue

                observed = self.inspector.inspect(expected.pid)
                if observed is None:
                    record.state = "STOPPED"
                    record.last_stop_reason = "PROCESS_MISSING"
                    self._clear_process(record)
                    record.updated_at_ms = int(time.time() * 1000)
                    events.append({
                        "event": "mining_resource_stopped",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "reason": record.last_stop_reason,
                    })
                    changed = True
                    continue
                if observed != expected:
                    record.state = "QUARANTINED"
                    record.last_stop_reason = "PROCESS_IDENTITY_MISMATCH"
                    record.updated_at_ms = int(time.time() * 1000)
                    events.append({
                        "event": "mining_resource_quarantined",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "reason": record.last_stop_reason,
                    })
                    changed = True
                    continue

                if not self._binary_integrity_ok(record):
                    try:
                        self._terminate_and_verify(expected)
                        self._clear_process(record)
                    except ExecutionControlError:
                        pass
                    record.state = "QUARANTINED"
                    record.last_stop_reason = "BINARY_INTEGRITY"
                    record.updated_at_ms = int(time.time() * 1000)
                    events.append({
                        "event": "mining_resource_quarantined",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "reason": record.last_stop_reason,
                    })
                    changed = True
                    continue

                try:
                    temperature = float(self.temperature_reader(record.hardware_uuid))
                except (ExecutionControlError, OSError, TypeError, ValueError):
                    record.thermal_sensor_failures = min(
                        THERMAL_SENSOR_FAILURE_LIMIT,
                        record.thermal_sensor_failures + 1,
                    )
                    record.updated_at_ms = int(time.time() * 1000)
                    changed = True
                    if record.thermal_sensor_failures >= THERMAL_SENSOR_FAILURE_LIMIT:
                        try:
                            self._terminate_and_verify(expected)
                            self._clear_process(record)
                        except ExecutionControlError:
                            pass
                        record.state = "QUARANTINED"
                        record.last_stop_reason = "THERMAL_SENSOR_UNAVAILABLE"
                        events.append({
                            "event": "mining_resource_quarantined",
                            "resourceId": resource_id,
                            "hardwareUuid": record.hardware_uuid,
                            "reason": record.last_stop_reason,
                            "sensorFailures": record.thermal_sensor_failures,
                        })
                    continue

                if not 0 <= temperature <= 150:
                    record.thermal_sensor_failures = min(
                        THERMAL_SENSOR_FAILURE_LIMIT,
                        record.thermal_sensor_failures + 1,
                    )
                    changed = True
                    continue

                previous_warning = record.thermal_warning_level
                record.last_temperature_celsius = temperature
                record.thermal_sensor_failures = 0
                record.thermal_warning_level = _thermal_warning_level(temperature)
                record.updated_at_ms = int(time.time() * 1000)
                changed = True

                if (
                    record.thermal_warning_level is not None
                    and record.thermal_warning_level != previous_warning
                    and (
                        previous_warning is None
                        or record.thermal_warning_level > previous_warning
                    )
                ):
                    events.append({
                        "event": "mining_thermal_warning",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "temperatureC": temperature,
                        "warningLevelC": record.thermal_warning_level,
                        "stopCelsius": record.thermal_stop_celsius,
                    })

                if temperature >= THERMAL_QUARANTINE_CELSIUS:
                    try:
                        self._terminate_and_verify(expected)
                        self._clear_process(record)
                    except ExecutionControlError:
                        pass
                    record.state = "QUARANTINED"
                    record.last_stop_reason = "THERMAL_QUARANTINE"
                    events.append({
                        "event": "mining_thermal_stop",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "temperatureC": temperature,
                        "stopCelsius": record.thermal_stop_celsius,
                        "reason": record.last_stop_reason,
                    })
                    continue

                if temperature >= record.thermal_stop_celsius:
                    self._terminate_and_verify(expected)
                    self._clear_process(record)
                    record.state = "STOPPED"
                    record.last_stop_reason = "THERMAL_LIMIT"
                    events.append({
                        "event": "mining_thermal_stop",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "temperatureC": temperature,
                        "stopCelsius": record.thermal_stop_celsius,
                        "reason": record.last_stop_reason,
                    })

            if changed:
                self.store.save(records)
        return events

    def telemetry_snapshot(self) -> list[dict[str, Any]]:
        samples: list[dict[str, Any]] = []
        with self._lock:
            records = self.store.load()
            for resource_id, record in records.items():
                if record.state != "MINING":
                    continue
                try:
                    metrics = self.metrics_reader(record.hardware_uuid)
                except (ExecutionControlError, OSError, TypeError, ValueError):
                    continue
                miner = {
                    "hashrate": None,
                    "hashrateUnit": None,
                    "acceptedShares": None,
                    "staleShares": None,
                    "hardwareErrors": None,
                    "uptimeSeconds": None,
                    "poolConnected": False,
                }
                handle = self._process_handles.get(resource_id)
                if handle is not None:
                    miner = parse_lolminer_output(handle.output_tail())
                samples.append({
                    "resourceId": resource_id,
                    "hardwareUuid": record.hardware_uuid,
                    "runtimeGeneration": record.runtime_generation,
                    "profileId": record.profile_id,
                    "processPid": record.pid,
                    "temperatureC": metrics.temperature_celsius,
                    "powerWatts": metrics.power_watts,
                    "gpuUtilizationPercent": metrics.utilization_percent,
                    "memoryUsedMiB": metrics.memory_used_mib,
                    "deviceName": metrics.device_name,
                    "thermalStopCelsius": record.thermal_stop_celsius,
                    **miner,
                })
        return samples

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {resource_id: asdict(record) for resource_id, record in self.store.load().items()}

