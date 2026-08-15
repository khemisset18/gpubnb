"""Fail-closed direct execution adapters for control-channel mutations.

Remote control messages never provide an executable or arbitrary argv. The Agent
reconstructs an approved command from a tiny baked-in manifest that mirrors the
Host Rust runtime, verifies the installed binary SHA-256, and persists local
runtime identity for idempotent stop/start handling.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .mining_guard import (
    WindowsProcessInspector,
    find_running_miners,
    miner_install_root,
    stop_all_miners_and_verify,
)
from .storage import config_dir
from .workspace_gateway import (
    names_for_session,
    network_name_for_session,
    proxy_name_for_session,
)

SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
SAFE_WORKER = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
SAFE_WALLET = re.compile(r"^[A-Za-z0-9_.:+-]{3,256}$")
ALLOWED_STRATUM_SCHEMES = {"stratum+tcp", "stratum+ssl", "stratum+tls"}
MAX_ARGUMENT_LEN = 512

# Mirrors apps/host-desktop/src-tauri/src/approved_miner_manifest.rs. A parity
# test protects this table from silently drifting away from the Rust runtime.
APPROVED_BINARIES: dict[str, dict[str, tuple[str, str]]] = {
    "xmrig_randomx": {
        "Windows": ("xmrig.exe", "6fa80698d7268f6e88aa88c06fb27ee99e1bcee747c2e76911e6206a5b1aeeb3"),
        "Linux": ("xmrig", "b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49"),
        "Darwin-x86_64": ("xmrig", "3bf7a353daa4af0f4d2aa4c5a0294fd14d3a330b0abf2e2e4dd23e14650aa527"),
        "Darwin-arm64": ("xmrig", "c66f9881bed79a550e18d54b9ae5cf03b91a0e881efdbf7962db2e58de0b4f7b"),
    },
    "lolminer_blake3": {
        "Windows": ("lolMiner.exe", "45d54e54e0bfcae4f983a8c5db88d1e3fed1618b26d4461c76af8027c4ec4616"),
        "Linux": ("lolMiner", "23c3719c7f949d6074fd3505928116df52de0e95e18a0a9e8c966b276b08e4ee"),
    },
    "lolminer_etchash": {
        "Windows": ("lolMiner.exe", "45d54e54e0bfcae4f983a8c5db88d1e3fed1618b26d4461c76af8027c4ec4616"),
        "Linux": ("lolMiner", "23c3719c7f949d6074fd3505928116df52de0e95e18a0a9e8c966b276b08e4ee"),
    },
    "lolminer_octopus": {
        "Windows": ("lolMiner.exe", "45d54e54e0bfcae4f983a8c5db88d1e3fed1618b26d4461c76af8027c4ec4616"),
        "Linux": ("lolMiner", "23c3719c7f949d6074fd3505928116df52de0e95e18a0a9e8c966b276b08e4ee"),
    },
}

LOL_ALGORITHMS = {
    "lolminer_blake3": "ALEPH",
    "lolminer_etchash": "ETCHASH",
    "lolminer_octopus": "OCTOPUS",
}


class ExecutionControlError(RuntimeError):
    pass


@dataclass(frozen=True)
class MiningLaunchSpec:
    resource_id: str
    profile_id: str
    pool_url: str
    wallet_address: str
    worker_name: str
    performance_mode: str


@dataclass(frozen=True)
class ExecutionResult:
    detail_code: str


def _platform_key() -> str:
    system = platform.system()
    if system == "Darwin":
        machine = platform.machine().lower()
        return "Darwin-arm64" if machine in {"arm64", "aarch64"} else "Darwin-x86_64"
    return system


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verified_binary(profile_id: str, root: Path | None = None) -> Path:
    platform_manifest = APPROVED_BINARIES.get(profile_id, {}).get(_platform_key())
    if platform_manifest is None:
        raise ExecutionControlError("approved_miner_platform_unsupported")
    file_name, expected_sha = platform_manifest
    install_root = root or miner_install_root()
    try:
        canonical_root = install_root.resolve(strict=True)
        candidate = (canonical_root / file_name).resolve(strict=True)
    except OSError as exc:
        raise ExecutionControlError("approved_miner_binary_missing") from exc
    if not candidate.is_file() or candidate.parent != canonical_root:
        raise ExecutionControlError("approved_miner_binary_path_invalid")
    if _sha256(candidate) != expected_sha:
        raise ExecutionControlError("approved_miner_binary_hash_mismatch")
    return candidate


def _validate_argument(value: str, error: str) -> str:
    if not value or len(value) > MAX_ARGUMENT_LEN or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ExecutionControlError(error)
    return value


def _validate_pool_url(value: str) -> str:
    _validate_argument(value, "mining_pool_url_invalid")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ExecutionControlError("mining_pool_url_invalid") from exc
    if parsed.scheme not in ALLOWED_STRATUM_SCHEMES or not parsed.hostname:
        raise ExecutionControlError("mining_pool_url_invalid")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ExecutionControlError("mining_pool_credentials_not_allowed")
    if parsed.port is None or not 1 <= parsed.port <= 65535:
        raise ExecutionControlError("mining_pool_port_invalid")
    host = parsed.hostname.rstrip(".")
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(record[4][0])
                for record in socket.getaddrinfo(host, parsed.port, type=socket.SOCK_STREAM)
            }
        except (OSError, ValueError) as exc:
            raise ExecutionControlError("mining_pool_dns_resolution_failed") from exc
    if not addresses or any(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
        for address in addresses
    ):
        raise ExecutionControlError("mining_pool_address_not_public")
    return value


def parse_mining_launch_spec(payload: Any) -> MiningLaunchSpec:
    if not isinstance(payload, dict):
        raise ExecutionControlError("mining_command_payload_invalid")
    allowed = {
        "resourceId", "profileId", "poolUrl", "walletAddress", "workerName",
        "performanceMode", "poolCredentialRef",
    }
    if set(payload) - allowed:
        raise ExecutionControlError("mining_command_payload_unknown_field")
    if payload.get("poolCredentialRef") not in {None, ""}:
        # Secret resolution belongs in a dedicated broker; raw or unresolved
        # credentials never cross this control channel.
        raise ExecutionControlError("miner_secret_resolution_required")
    resource_id = payload.get("resourceId")
    profile_id = payload.get("profileId")
    pool_url = payload.get("poolUrl")
    wallet = payload.get("walletAddress")
    worker = payload.get("workerName")
    performance = payload.get("performanceMode", "BALANCED")
    if not isinstance(resource_id, str) or SAFE_ID.fullmatch(resource_id) is None:
        raise ExecutionControlError("mining_resource_id_invalid")
    if profile_id not in APPROVED_BINARIES:
        raise ExecutionControlError("mining_profile_not_approved")
    if not isinstance(pool_url, str):
        raise ExecutionControlError("mining_pool_url_invalid")
    if not isinstance(wallet, str) or SAFE_WALLET.fullmatch(wallet) is None:
        raise ExecutionControlError("mining_wallet_invalid")
    if not isinstance(worker, str) or SAFE_WORKER.fullmatch(worker) is None:
        raise ExecutionControlError("mining_worker_invalid")
    if performance not in {"ECO", "BALANCED", "FULL"}:
        raise ExecutionControlError("mining_performance_mode_invalid")
    return MiningLaunchSpec(
        resource_id=resource_id,
        profile_id=profile_id,
        pool_url=_validate_pool_url(pool_url),
        wallet_address=wallet,
        worker_name=worker,
        performance_mode=performance,
    )


def _gpu_power_limit_arguments(mode: str) -> list[str]:
    result = subprocess.run(
        [
            "nvidia-smi", "--query-gpu=power.default_limit,power.min_limit",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True, text=True, timeout=15, check=False, shell=False,
    )
    if result.returncode != 0:
        raise ExecutionControlError("gpu_power_limit_unavailable")
    percent = {"ECO": 33, "BALANCED": 66, "FULL": 100}[mode]
    targets: list[str] = []
    for raw in result.stdout.splitlines():
        if not raw.strip():
            continue
        try:
            default_raw, minimum_raw = raw.split(",", 1)
            default = float(default_raw.strip())
            minimum = float(minimum_raw.strip())
        except (ValueError, TypeError) as exc:
            raise ExecutionControlError("gpu_power_limit_invalid") from exc
        if default <= 0 or minimum <= 0 or minimum > default:
            raise ExecutionControlError("gpu_power_limit_invalid")
        requested = default * percent / 100.0
        targets.append(str(round(max(minimum, min(default, requested)))))
    if not targets:
        raise ExecutionControlError("gpu_power_limit_invalid")
    return ["--pl", ",".join(targets)]


def build_miner_arguments(spec: MiningLaunchSpec) -> list[str]:
    user = f"{spec.wallet_address}.{spec.worker_name}"
    _validate_argument(user, "miner_argument_invalid")
    if spec.profile_id == "xmrig_randomx":
        return ["--algo=randomx", f"--url={spec.pool_url}", f"--user={user}"]
    algorithm = LOL_ALGORITHMS.get(spec.profile_id)
    if algorithm is None:
        raise ExecutionControlError("mining_profile_not_approved")
    return [
        "--algo", algorithm,
        "--pool", spec.pool_url,
        "--user", user,
        *_gpu_power_limit_arguments(spec.performance_mode),
    ]


def _state_path() -> Path:
    return config_dir() / "miner-runtime-state.json"


def _load_state() -> dict[str, Any]:
    try:
        value = json.loads(_state_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise ExecutionControlError("miner_runtime_state_corrupt") from exc
    return value if isinstance(value, dict) else {}


def _save_state(value: dict[str, Any]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".miner-runtime-", dir=path.parent, text=True)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def start_mining(payload: Any, command_id: str) -> ExecutionResult:
    spec = parse_mining_launch_spec(payload)
    root = miner_install_root()
    inspector = WindowsProcessInspector()
    running = find_running_miners(root, inspector)
    state = _load_state()
    if running:
        if (
            len(running) == 1
            and state.get("resourceId") == spec.resource_id
            and state.get("profileId") == spec.profile_id
            and state.get("pid") == running[0].get("pid")
        ):
            return ExecutionResult("mining_already_running")
        raise ExecutionControlError("miner_already_running")
    executable = _verified_binary(spec.profile_id, root)
    arguments = build_miner_arguments(spec)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    try:
        child = subprocess.Popen(
            [str(executable), *arguments],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
            creationflags=flags,
            start_new_session=os.name != "nt",
        )
    except OSError as exc:
        raise ExecutionControlError("miner_process_spawn_failed") from exc
    try:
        child.wait(timeout=0.25)
    except subprocess.TimeoutExpired:
        pass
    else:
        raise ExecutionControlError("miner_process_exited_during_start")
    _save_state({
        "schemaVersion": 1,
        "pid": child.pid,
        "resourceId": spec.resource_id,
        "profileId": spec.profile_id,
        "commandId": command_id,
    })
    return ExecutionResult("mining_started_verified")


def stop_mining() -> ExecutionResult:
    root = miner_install_root()
    if not stop_all_miners_and_verify(root, WindowsProcessInspector()):
        raise ExecutionControlError("mining_stop_unverified")
    _save_state({"schemaVersion": 1})
    return ExecutionResult("mining_stop_verified")


def _docker(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True,
        timeout=30, check=False, shell=False,
    )


def _docker_absent(kind: str, name: str) -> bool:
    result = _docker([kind, "inspect", name]) if kind in {"volume", "network"} else _docker(["inspect", name])
    return result.returncode != 0


def stop_rental(payload: Any) -> ExecutionResult:
    if not isinstance(payload, dict):
        raise ExecutionControlError("stop_rental_payload_invalid")
    session_id = payload.get("sessionId")
    if not isinstance(session_id, str) or SAFE_ID.fullmatch(session_id) is None:
        raise ExecutionControlError("stop_rental_session_id_invalid")

    container, volume = names_for_session(session_id)
    proxy = proxy_name_for_session(session_id)
    network = network_name_for_session(session_id)
    for name in (proxy, container):
        _docker(["rm", "-f", name])
    _docker(["volume", "rm", "-f", volume])
    _docker(["network", "rm", network])

    if not (
        _docker_absent("container", proxy)
        and _docker_absent("container", container)
        and _docker_absent("volume", volume)
        and _docker_absent("network", network)
    ):
        raise ExecutionControlError("rental_cleanup_unverified")
    return ExecutionResult("rental_cleanup_verified")
