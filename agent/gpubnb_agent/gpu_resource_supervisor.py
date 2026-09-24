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
import hashlib
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
    _resolve_public_pool_addresses,
    _sha256,
    _validate_argument,
    _verified_binary,
)
from .mining_guard import miner_install_root
from .platform_info import find_nvidia_smi, run_command
from .storage import config_dir, require_private_directory

SCHEMA_VERSION = 1
MAX_GENERATION = 9_223_372_036_854_775_807
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
SAFE_GPU_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")
SAFE_WORKER = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
SAFE_WALLET = re.compile(r"^[A-Za-z0-9_.:+-]{3,256}$")
PCI_BDF = re.compile(r"^(?:[0-9A-Fa-f]{4,8}:)?([0-9A-Fa-f]{2}):([0-9A-Fa-f]{2})\.[0-7]$")
RESOURCE_STATES = {"MINING", "STOPPED", "QUARANTINED"}
WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
DEFAULT_MAX_TEMPERATURE_C = 85
MIN_MAX_TEMPERATURE_C = 85
MAX_MAX_TEMPERATURE_C = 98
THERMAL_WARNING_LEVELS = (85, 90, 94, 97)
WATCHDOG_INTERVAL_SECONDS = 5.0
MAX_SENSOR_FAILURES = 3
MAX_MINER_LOG_BYTES = 2 * 1024 * 1024
MAX_TELEMETRY_TAIL_BYTES = 256 * 1024
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
SHARES_TOKEN = re.compile(r"^(\d+)/(\d+)/(\d+)$")


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
    maximum_temperature_c: int
    maximum_power_watts: int
    resolved_pool_addresses: tuple[str, ...]


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


@dataclass(frozen=True)
class GpuMetrics:
    temperature_c: float
    power_watts: float | None
    utilization_percent: int | None


class GpuSensor(Protocol):
    def read(self, hardware_uuid: str) -> GpuMetrics: ...


@dataclass(frozen=True)
class MinerTelemetry:
    hashrate: float | None = None
    hashrate_unit: str | None = None
    accepted_shares: int | None = None
    stale_shares: int | None = None
    hardware_errors: int | None = None
    uptime_seconds: int | None = None
    pool_connected: bool = False


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
    maximum_temperature_c: int = DEFAULT_MAX_TEMPERATURE_C
    last_temperature_c: float | None = None
    last_power_watts: float | None = None
    last_utilization_percent: int | None = None
    last_sampled_at_ms: int | None = None
    last_warning_level: int | None = None
    last_stop_reason: str | None = None
    log_path: str | None = None
    last_hashrate: float | None = None
    last_hashrate_unit: str | None = None
    accepted_shares: int | None = None
    stale_shares: int | None = None
    hardware_errors: int | None = None
    uptime_seconds: int | None = None
    pool_connected: bool = False
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
        maximum_temperature_c = value.get("maximum_temperature_c", DEFAULT_MAX_TEMPERATURE_C)
        if (
            isinstance(maximum_temperature_c, bool)
            or not isinstance(maximum_temperature_c, int)
            or not MIN_MAX_TEMPERATURE_C <= maximum_temperature_c <= MAX_MAX_TEMPERATURE_C
        ):
            return None
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
            maximum_temperature_c=maximum_temperature_c,
            last_temperature_c=float(value["last_temperature_c"]) if isinstance(value.get("last_temperature_c"), (int, float)) and not isinstance(value.get("last_temperature_c"), bool) else None,
            last_power_watts=float(value["last_power_watts"]) if isinstance(value.get("last_power_watts"), (int, float)) and not isinstance(value.get("last_power_watts"), bool) else None,
            last_utilization_percent=value.get("last_utilization_percent") if isinstance(value.get("last_utilization_percent"), int) and not isinstance(value.get("last_utilization_percent"), bool) else None,
            last_sampled_at_ms=value.get("last_sampled_at_ms") if isinstance(value.get("last_sampled_at_ms"), int) and not isinstance(value.get("last_sampled_at_ms"), bool) else None,
            last_warning_level=value.get("last_warning_level") if isinstance(value.get("last_warning_level"), int) and not isinstance(value.get("last_warning_level"), bool) else None,
            last_stop_reason=value.get("last_stop_reason") if isinstance(value.get("last_stop_reason"), str) else None,
            log_path=value.get("log_path") if isinstance(value.get("log_path"), str) else None,
            last_hashrate=float(value["last_hashrate"]) if isinstance(value.get("last_hashrate"), (int, float)) and not isinstance(value.get("last_hashrate"), bool) else None,
            last_hashrate_unit=value.get("last_hashrate_unit") if isinstance(value.get("last_hashrate_unit"), str) else None,
            accepted_shares=value.get("accepted_shares") if isinstance(value.get("accepted_shares"), int) and not isinstance(value.get("accepted_shares"), bool) else None,
            stale_shares=value.get("stale_shares") if isinstance(value.get("stale_shares"), int) and not isinstance(value.get("stale_shares"), bool) else None,
            hardware_errors=value.get("hardware_errors") if isinstance(value.get("hardware_errors"), int) and not isinstance(value.get("hardware_errors"), bool) else None,
            uptime_seconds=value.get("uptime_seconds") if isinstance(value.get("uptime_seconds"), int) and not isinstance(value.get("uptime_seconds"), bool) else None,
            pool_connected=value.get("pool_connected") is True,
            updated_at_ms=int(value.get("updated_at_ms", 0)) if isinstance(value.get("updated_at_ms", 0), int) else 0,
        )


class SpawnedProcess(Protocol):
    @property
    def pid(self) -> int: ...

    def poll(self) -> int | None: ...

    def terminate_owned(self) -> None: ...


class ProcessLauncher(Protocol):
    def spawn(
        self,
        executable: Path,
        arguments: list[str],
        cwd: Path,
        log_path: Path | None = None,
    ) -> SpawnedProcess: ...


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
    def spawn(
        self,
        executable: Path,
        arguments: list[str],
        cwd: Path,
        log_path: Path | None = None,
    ) -> SpawnedProcess:
        flags = (
            subprocess.CREATE_NEW_PROCESS_GROUP | WINDOWS_CREATE_NO_WINDOW
            if os.name == "nt"
            else 0
        )
        log_handle = None
        stdout_target: Any = subprocess.DEVNULL
        stderr_target: Any = subprocess.DEVNULL
        try:
            if log_path is not None:
                try:
                    require_private_directory(log_path.parent)
                except RuntimeError as exc:
                    raise ExecutionControlError("miner_log_security_unavailable") from exc
                if log_path.exists() and log_path.stat().st_size > MAX_MINER_LOG_BYTES:
                    log_path.unlink()
                log_handle = open(log_path, "ab", buffering=0)
                stdout_target = log_handle
                stderr_target = log_handle
            child = subprocess.Popen(
                [str(executable), *arguments],
                cwd=str(cwd),
                stdin=subprocess.DEVNULL,
                stdout=stdout_target,
                stderr=stderr_target,
                shell=False,
                creationflags=flags,
                start_new_session=os.name != "nt",
            )
        except OSError as exc:
            raise ExecutionControlError("miner_process_spawn_failed") from exc
        finally:
            if log_handle is not None:
                log_handle.close()
        return _PopenHandle(child)


class NvidiaGpuSensor:
    def read(self, hardware_uuid: str) -> GpuMetrics:
        executable = find_nvidia_smi()
        if not executable:
            raise ExecutionControlError("resource_gpu_nvidia_smi_unavailable")
        result = run_command(
            [
                executable,
                "-i",
                hardware_uuid,
                "--query-gpu=temperature.gpu,power.draw,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            timeout=10,
        )
        if result.returncode != 0:
            raise ExecutionControlError("resource_gpu_thermal_sensor_unavailable")
        rows = [row for row in csv.reader(result.stdout.splitlines()) if row]
        if len(rows) != 1 or len(rows[0]) != 3:
            raise ExecutionControlError("resource_gpu_thermal_sensor_invalid")
        values = [value.strip() for value in rows[0]]
        try:
            temperature = float(values[0])
            power = None if values[1].upper() in {"N/A", "[N/A]"} else float(values[1])
            utilization = None if values[2].upper() in {"N/A", "[N/A]"} else int(float(values[2]))
        except ValueError as exc:
            raise ExecutionControlError("resource_gpu_thermal_sensor_invalid") from exc
        if not 0 <= temperature <= 150:
            raise ExecutionControlError("resource_gpu_thermal_sensor_invalid")
        if power is not None and power < 0:
            raise ExecutionControlError("resource_gpu_thermal_sensor_invalid")
        if utilization is not None and not 0 <= utilization <= 100:
            raise ExecutionControlError("resource_gpu_thermal_sensor_invalid")
        return GpuMetrics(temperature, power, utilization)


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



def _resource_log_path(resource_id: str) -> Path:
    digest = hashlib.sha256(resource_id.encode("utf-8")).hexdigest()[:24]
    return config_dir() / "mining-logs" / f"{digest}.log"


def _read_log_tail(path: Path) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            length = handle.tell()
            handle.seek(max(0, length - MAX_TELEMETRY_TAIL_BYTES))
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def _parse_uptime(value: str) -> int | None:
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
        total += amount * multiplier
        found = True
    return total if found else None


def parse_lolminer_telemetry(log: str) -> MinerTelemetry:
    hashrate: float | None = None
    accepted: int | None = None
    stale: int | None = None
    hardware: int | None = None
    uptime: int | None = None
    connected = False
    for raw in log.splitlines():
        line = ANSI_ESCAPE.sub("", raw).replace("\r", "").strip()
        if "Authorized worker:" in line or "Connected to:" in line:
            connected = True
        if line.startswith("Statistics (") and "Uptime:" in line:
            uptime = _parse_uptime(line.split("Uptime:", 1)[1].strip())
        if not line.startswith("GPU "):
            continue
        fields = line.split()
        share_index = next(
            (index for index, field in enumerate(fields) if SHARES_TOKEN.fullmatch(field)),
            None,
        )
        if share_index is None or share_index < 2:
            continue
        shares = SHARES_TOKEN.fullmatch(fields[share_index])
        if shares is None:
            continue
        try:
            candidate_hashrate = float(fields[share_index - 2])
        except ValueError:
            continue
        hashrate = candidate_hashrate
        accepted, stale, hardware = (int(shares.group(i)) for i in range(1, 4))
    return MinerTelemetry(
        hashrate=hashrate,
        hashrate_unit="MH/s" if hashrate is not None else None,
        accepted_shares=accepted,
        stale_shares=stale,
        hardware_errors=hardware,
        uptime_seconds=uptime,
        pool_connected=connected,
    )


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
        "walletAddress", "workerName", "performanceMode", "maximumTemperatureC",
        "maximumPowerWatts", "poolCredentialRef",
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
    maximum_temperature = payload.get("maximumTemperatureC", DEFAULT_MAX_TEMPERATURE_C)
    maximum_power = payload.get("maximumPowerWatts")
    if (
        isinstance(maximum_temperature, bool)
        or not isinstance(maximum_temperature, int)
        or not MIN_MAX_TEMPERATURE_C <= maximum_temperature <= MAX_MAX_TEMPERATURE_C
    ):
        raise ExecutionControlError("mining_maximum_temperature_invalid")
    if (
        isinstance(maximum_power, bool)
        or not isinstance(maximum_power, int)
        or not 5 <= maximum_power <= 1500
    ):
        raise ExecutionControlError("mining_maximum_power_invalid")
    resolved_pool_addresses = _resolve_public_pool_addresses(pool)
    return ResourceMiningSpec(
        resource_id,
        hardware_uuid,
        _positive_generation(payload.get("runtimeGeneration")),
        profile_id,
        pool,
        wallet,
        worker,
        performance,
        maximum_temperature,
        maximum_power,
        resolved_pool_addresses,
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
        "--tstop", str(spec.maximum_temperature_c),
    ]

    default, minimum = binding.power_default_watts, binding.power_min_watts
    if default is None or minimum is None or default <= 0 or minimum <= 0 or minimum > default:
        raise ExecutionControlError("resource_gpu_power_limits_unavailable")
    if spec.maximum_power_watts < minimum:
        raise ExecutionControlError("mining_maximum_power_below_firmware_minimum")
    ratio = {"ECO": 0.33, "BALANCED": 0.66, "FULL": 1.0}[spec.performance_mode]
    requested = min(default * ratio, float(spec.maximum_power_watts), default)
    target = round(max(minimum, requested))
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
        sensor: GpuSensor | None = None,
        event_sink: Any = None,
        watchdog_interval_seconds: float = WATCHDOG_INTERVAL_SECONDS,
        start_watchdog: bool = True,
    ) -> None:
        self.store = store or RuntimeStore()
        self.inspector = inspector or SystemProcessInspector()
        self.launcher = launcher or SystemLauncher()
        self.binding_resolver = binding_resolver or resolve_nvidia_binding
        self.sensor = sensor or NvidiaGpuSensor()
        self.event_sink = event_sink or (lambda _event: None)
        self.watchdog_interval_seconds = max(0.1, float(watchdog_interval_seconds))
        self._sensor_failures: dict[str, int] = {}
        self._watchdog_stop = threading.Event()
        self._watchdog_thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self.reconcile()
        if start_watchdog:
            self._watchdog_thread = threading.Thread(
                target=self._watchdog_loop,
                name="gpubnb-mining-thermal-watchdog",
                daemon=True,
            )
            self._watchdog_thread.start()

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
                    record.last_stop_reason = "miner_process_identity_mismatch"
                    outcome[resource_id] = record.state
                    changed = True
                else:
                    if (
                        not record.binary_sha256
                        or _sha256(Path(current.executable_path)) != record.binary_sha256
                    ):
                        record.state = "QUARANTINED"
                        record.last_stop_reason = "approved_miner_binary_hash_mismatch"
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
        if _resolve_public_pool_addresses(spec.pool_url) != spec.resolved_pool_addresses:
            raise ExecutionControlError("mining_pool_dns_rebinding_detected")

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

            log_path = _resource_log_path(spec.resource_id)
            child = self.launcher.spawn(executable, arguments, root, log_path)
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
                maximum_temperature_c=spec.maximum_temperature_c,
                last_stop_reason=None,
                log_path=str(log_path),
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

    def _warning_level(self, temperature_c: float) -> int | None:
        level: int | None = None
        for candidate in THERMAL_WARNING_LEVELS:
            if temperature_c >= candidate:
                level = candidate
        return level

    def _stop_owned_record(
        self,
        records: dict[str, RuntimeRecord],
        record: RuntimeRecord,
        reason: str,
    ) -> None:
        expected = _record_identity(record)
        if expected is None:
            record.state = "QUARANTINED"
            record.last_stop_reason = "miner_process_identity_missing"
            record.updated_at_ms = int(time.time() * 1000)
            self.store.save(records)
            raise ExecutionControlError("miner_process_identity_missing")
        observed = self.inspector.inspect(expected.pid)
        if observed is None:
            record.state = "STOPPED"
            record.pid = None
            record.process_creation_token = None
            record.last_stop_reason = reason
            record.updated_at_ms = int(time.time() * 1000)
            self.store.save(records)
            return
        if observed != expected:
            record.state = "QUARANTINED"
            record.last_stop_reason = "miner_process_identity_mismatch"
            record.updated_at_ms = int(time.time() * 1000)
            self.store.save(records)
            raise ExecutionControlError("miner_process_identity_mismatch")
        self.inspector.terminate(expected)
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            observed = self.inspector.inspect(expected.pid)
            if observed is None:
                break
            if observed != expected:
                record.state = "QUARANTINED"
                record.last_stop_reason = "miner_process_identity_mismatch"
                record.updated_at_ms = int(time.time() * 1000)
                self.store.save(records)
                raise ExecutionControlError("miner_process_identity_mismatch")
            time.sleep(0.1)
        else:
            raise ExecutionControlError("mining_resource_stop_unverified")
        record.state = "STOPPED"
        record.pid = None
        record.process_creation_token = None
        record.last_stop_reason = reason
        record.updated_at_ms = int(time.time() * 1000)
        self.store.save(records)

    def run_watchdog_once(self) -> dict[str, str]:
        outcome: dict[str, str] = {}
        with self._lock:
            records = self.store.load()
            for resource_id, record in records.items():
                if record.state != "MINING":
                    continue
                try:
                    metrics = self.sensor.read(record.hardware_uuid)
                except ExecutionControlError as exc:
                    failures = self._sensor_failures.get(resource_id, 0) + 1
                    self._sensor_failures[resource_id] = failures
                    self.event_sink({
                        "event": "mining_gpu_sensor_failure",
                        "resourceId": resource_id,
                        "hardwareUuid": record.hardware_uuid,
                        "consecutiveFailures": failures,
                        "detailCode": str(exc)[:96],
                    })
                    if failures >= MAX_SENSOR_FAILURES:
                        try:
                            self._stop_owned_record(records, record, "thermal_sensor_fail_closed")
                            outcome[resource_id] = "STOPPED"
                            self.event_sink({
                                "event": "mining_thermal_stop",
                                "resourceId": resource_id,
                                "hardwareUuid": record.hardware_uuid,
                                "reason": "thermal_sensor_fail_closed",
                            })
                        except ExecutionControlError:
                            outcome[resource_id] = record.state
                    continue

                self._sensor_failures.pop(resource_id, None)
                now_ms = int(time.time() * 1000)
                record.last_temperature_c = metrics.temperature_c
                record.last_power_watts = metrics.power_watts
                record.last_utilization_percent = metrics.utilization_percent
                record.last_sampled_at_ms = now_ms
                if record.log_path:
                    telemetry = parse_lolminer_telemetry(_read_log_tail(Path(record.log_path)))
                    record.last_hashrate = telemetry.hashrate
                    record.last_hashrate_unit = telemetry.hashrate_unit
                    record.accepted_shares = telemetry.accepted_shares
                    record.stale_shares = telemetry.stale_shares
                    record.hardware_errors = telemetry.hardware_errors
                    record.uptime_seconds = telemetry.uptime_seconds
                    record.pool_connected = telemetry.pool_connected
                warning_level = self._warning_level(metrics.temperature_c)
                if warning_level != record.last_warning_level:
                    record.last_warning_level = warning_level
                    if warning_level is not None:
                        self.event_sink({
                            "event": "mining_thermal_warning",
                            "resourceId": resource_id,
                            "hardwareUuid": record.hardware_uuid,
                            "temperatureC": metrics.temperature_c,
                            "warningLevelC": warning_level,
                            "maximumTemperatureC": record.maximum_temperature_c,
                        })
                record.updated_at_ms = now_ms

                if metrics.temperature_c >= record.maximum_temperature_c:
                    try:
                        self._stop_owned_record(records, record, "maximum_temperature_reached")
                        outcome[resource_id] = "STOPPED"
                        self.event_sink({
                            "event": "mining_thermal_stop",
                            "resourceId": resource_id,
                            "hardwareUuid": record.hardware_uuid,
                            "temperatureC": metrics.temperature_c,
                            "maximumTemperatureC": record.maximum_temperature_c,
                            "reason": "maximum_temperature_reached",
                        })
                    except ExecutionControlError:
                        outcome[resource_id] = record.state
                else:
                    outcome[resource_id] = "MINING"
                    self.store.save(records)
        return outcome

    def _watchdog_loop(self) -> None:
        while not self._watchdog_stop.wait(self.watchdog_interval_seconds):
            try:
                self.run_watchdog_once()
            except Exception as exc:
                self.event_sink({
                    "event": "mining_thermal_watchdog_error",
                    "type": type(exc).__name__,
                    "message": str(exc)[:160],
                })

    def shutdown(self) -> None:
        self._watchdog_stop.set()
        thread = self._watchdog_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=max(1.0, self.watchdog_interval_seconds + 0.5))

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {resource_id: asdict(record) for resource_id, record in self.store.load().items()}
