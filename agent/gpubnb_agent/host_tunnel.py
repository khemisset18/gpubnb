"""Outbound QUIC Host tunnel lifecycle for Developer Workspace sessions.

The signed Host authority is single-use and short lived. This supervisor fetches a
fresh authority before every process start, stores bearer material with the same
hardened filesystem ACLs as the Agent private key, and never places the authority
on the process command line.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .client import ApiClient, agent_request
from .storage import _atomic_write, _secure_directory, config_dir

BACKOFF_BASE_SECONDS = 1.0
BACKOFF_MAX_SECONDS = 30.0
BACKOFF_JITTER_MIN = 0.75
BACKOFF_JITTER_SPAN = 0.50
PROCESS_STABLE_RESET_SECONDS = 30.0
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
SAFE_NONCE = re.compile(r"^[A-Fa-f0-9]{64}$")
SAFE_SIGNATURE = re.compile(r"^[A-Fa-f0-9]{128}$")


class ProcessLike(Protocol):
    def poll(self) -> int | None: ...
    def terminate(self) -> None: ...
    def kill(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int: ...


RequestFunc = Callable[[ApiClient, Any, str, str, str, dict[str, Any] | None], dict[str, Any]]
PopenFactory = Callable[..., ProcessLike]


@dataclass
class TunnelRuntime:
    session_id: str
    workspace_port: int
    process: ProcessLike
    authority_path: Path
    ca_path: Path
    started_at: float
    failures_before_start: int


@dataclass
class RetryState:
    failures: int = 0
    retry_at: float = 0.0


class HostTunnelSupervisor:
    def __init__(
        self,
        api: ApiClient,
        key: Any,
        machine_id: str,
        config: dict[str, Any],
        request_func: RequestFunc | None = None,
        popen_factory: PopenFactory | None = None,
        clock: Callable[[], float] | None = None,
        random_func: Callable[[], float] | None = None,
    ) -> None:
        self.api = api
        self.key = key
        self.machine_id = machine_id
        self.config = config
        self._request_func = request_func or agent_request
        self._popen = popen_factory or subprocess.Popen
        self._clock = clock or time.monotonic
        self._random = random_func or random.random
        self.runtimes: dict[str, TunnelRuntime] = {}
        self.retries: dict[str, RetryState] = {}

    def _request(self, path: str) -> dict[str, Any]:
        return self._request_func(self.api, self.key, self.machine_id, path, "GET", None)

    @staticmethod
    def _safe_session_dir(session_id: str) -> Path:
        digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:32]
        path = config_dir() / "data-plane" / digest
        _secure_directory(path)
        return path

    def _binary_path(self) -> Path:
        configured = str(
            os.environ.get("GPUBNB_HOST_TUNNEL_BINARY")
            or self.config.get("hostTunnelBinary")
            or ""
        ).strip()
        if configured:
            path = Path(configured).expanduser().resolve()
            if not path.is_file():
                raise RuntimeError("host_tunnel_binary_missing")
            return path

        executable_name = "gpubnb-host-tunnel.exe" if os.name == "nt" else "gpubnb-host-tunnel"
        if getattr(sys, "frozen", False):
            sibling = Path(sys.executable).resolve().with_name(executable_name)
            if sibling.is_file():
                return sibling
            raise RuntimeError("host_tunnel_sidecar_missing")

        repo_root = Path(__file__).resolve().parents[2]
        for profile in ("release", "debug"):
            candidate = repo_root / "services" / "edge" / "target" / profile / executable_name
            if candidate.is_file():
                return candidate
        raise RuntimeError("host_tunnel_binary_missing")

    def _validate_bootstrap(
        self, value: dict[str, Any], expected_session_id: str
    ) -> dict[str, Any]:
        protocol = value.get("protocol")
        edge_id = value.get("edgeId")
        edge_addr = value.get("edgeAddr")
        server_name = value.get("serverName")
        ca_cert = value.get("caCertPem")
        authority = value.get("authority")
        expires_at = value.get("authorityExpiresAtMs")
        if protocol != "gpubnb-dp/1":
            raise RuntimeError("host_tunnel_bootstrap_protocol_invalid")
        for name, field in (
            ("edge_id", edge_id),
            ("edge_addr", edge_addr),
            ("server_name", server_name),
            ("ca_cert", ca_cert),
        ):
            if not isinstance(field, str) or not field.strip():
                raise RuntimeError(f"host_tunnel_bootstrap_{name}_invalid")
        if not isinstance(edge_id, str) or SAFE_ID.fullmatch(edge_id) is None:
            raise RuntimeError("host_tunnel_bootstrap_edge_id_invalid")
        if not isinstance(ca_cert, str) or "-----BEGIN CERTIFICATE-----" not in ca_cert:
            raise RuntimeError("host_tunnel_bootstrap_ca_cert_invalid")
        if not isinstance(authority, dict) or authority.get("role") != "HOST":
            raise RuntimeError("host_tunnel_bootstrap_authority_invalid")
        if authority.get("edgeId") != edge_id:
            raise RuntimeError("host_tunnel_bootstrap_edge_scope_mismatch")
        signature = authority.get("signatureHex")
        if not isinstance(signature, str) or SAFE_SIGNATURE.fullmatch(signature) is None:
            raise RuntimeError("host_tunnel_bootstrap_signature_invalid")
        binding = authority.get("binding")
        if not isinstance(binding, dict):
            raise RuntimeError("host_tunnel_bootstrap_binding_invalid")
        if binding.get("protocolVersion") != 1:
            raise RuntimeError("host_tunnel_bootstrap_binding_protocol_invalid")
        if binding.get("sessionId") != expected_session_id:
            raise RuntimeError("host_tunnel_bootstrap_session_scope_mismatch")
        if binding.get("machineId") != self.machine_id:
            raise RuntimeError("host_tunnel_bootstrap_machine_scope_mismatch")
        for field_name in ("sessionId", "machineId", "bookingId", "renterUserId"):
            field = binding.get(field_name)
            if not isinstance(field, str) or SAFE_ID.fullmatch(field) is None:
                raise RuntimeError(f"host_tunnel_bootstrap_{field_name}_invalid")
        nonce = binding.get("nonce")
        if not isinstance(nonce, str) or SAFE_NONCE.fullmatch(nonce) is None:
            raise RuntimeError("host_tunnel_bootstrap_nonce_invalid")
        binding_expires = binding.get("expiresAtMs")
        binding_issued = binding.get("issuedAtMs")
        if (
            not isinstance(binding_issued, int)
            or not isinstance(binding_expires, int)
            or binding_expires <= binding_issued
        ):
            raise RuntimeError("host_tunnel_bootstrap_binding_time_invalid")
        if not isinstance(expires_at, int) or expires_at != binding_expires:
            raise RuntimeError("host_tunnel_bootstrap_expiry_invalid")
        serialized = json.dumps(value, separators=(",", ":"))
        if "PRIVATE KEY" in serialized:
            raise RuntimeError("host_tunnel_bootstrap_private_key_leak")
        return value

    def _fetch_bootstrap(self, session_id: str) -> dict[str, Any]:
        path = (
            f"/agent/workspace-gateway/{self.machine_id}/sessions/"
            f"{session_id}/data-plane-host"
        )
        return self._validate_bootstrap(self._request(path), session_id)

    def _write_bootstrap_files(
        self, session_id: str, bootstrap: dict[str, Any]
    ) -> tuple[Path, Path]:
        directory = self._safe_session_dir(session_id)
        authority_path = directory / "host-authority.json"
        ca_path = directory / "edge-ca.pem"
        _atomic_write(
            authority_path,
            json.dumps(bootstrap["authority"], separators=(",", ":")) + "\n",
        )
        _atomic_write(ca_path, str(bootstrap["caCertPem"]))
        return authority_path, ca_path

    @staticmethod
    def _remove_secret(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _cleanup_files(self, runtime: TunnelRuntime) -> None:
        self._remove_secret(runtime.authority_path)
        self._remove_secret(runtime.ca_path)
        try:
            runtime.authority_path.parent.rmdir()
        except OSError:
            pass

    def _record_failure(self, session_id: str) -> None:
        state = self.retries.setdefault(session_id, RetryState())
        state.failures += 1
        base = min(
            BACKOFF_MAX_SECONDS,
            BACKOFF_BASE_SECONDS * (2 ** min(state.failures - 1, 5)),
        )
        jitter = BACKOFF_JITTER_MIN + BACKOFF_JITTER_SPAN * self._random()
        state.retry_at = self._clock() + base * jitter

    def _reset_retry_if_stable(self, runtime: TunnelRuntime) -> None:
        if self._clock() - runtime.started_at >= PROCESS_STABLE_RESET_SECONDS:
            self.retries.pop(runtime.session_id, None)

    def _spawn(self, session_id: str, workspace_port: int) -> TunnelRuntime:
        bootstrap = self._fetch_bootstrap(session_id)
        authority_path, ca_path = self._write_bootstrap_files(session_id, bootstrap)
        binary = self._binary_path()
        env = os.environ.copy()
        env.update(
            {
                "GPUBNB_HOST_EDGE_ADDR": str(bootstrap["edgeAddr"]),
                "GPUBNB_HOST_EDGE_SERVER_NAME": str(bootstrap["serverName"]),
                "GPUBNB_HOST_EDGE_CA_CERT": str(ca_path),
                "GPUBNB_HOST_AUTHORITY": str(authority_path),
                "GPUBNB_HOST_WORKSPACE_PORT": str(workspace_port),
            }
        )
        creationflags = 0
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            creationflags = subprocess.CREATE_NO_WINDOW
        try:
            process = self._popen(
                [str(binary)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
                shell=False,
                close_fds=True,
                creationflags=creationflags,
            )
        except Exception:
            self._remove_secret(authority_path)
            self._remove_secret(ca_path)
            raise
        retry = self.retries.get(session_id, RetryState())
        return TunnelRuntime(
            session_id=session_id,
            workspace_port=workspace_port,
            process=process,
            authority_path=authority_path,
            ca_path=ca_path,
            started_at=self._clock(),
            failures_before_start=retry.failures,
        )

    def reconcile(self, session_id: str, workspace_port: int, enabled: bool) -> bool:
        if not enabled:
            self.stop(session_id)
            self.retries.pop(session_id, None)
            return False
        if workspace_port < 1 or workspace_port > 65535:
            raise RuntimeError("host_tunnel_workspace_port_invalid")

        current = self.runtimes.get(session_id)
        if current is not None:
            exit_code = current.process.poll()
            if exit_code is None and current.workspace_port == workspace_port:
                self._reset_retry_if_stable(current)
                return True
            self.runtimes.pop(session_id, None)
            if exit_code is None:
                self._stop_process(current.process)
            self._cleanup_files(current)
            if exit_code is not None:
                self._record_failure(session_id)
            else:
                self.retries.pop(session_id, None)

        state = self.retries.get(session_id)
        if state is not None and self._clock() < state.retry_at:
            return False

        try:
            runtime = self._spawn(session_id, workspace_port)
        except Exception:
            self._record_failure(session_id)
            raise
        self.runtimes[session_id] = runtime
        return True

    def reconcile_after_direct(
        self,
        session_id: str,
        workspace_port: int,
        direct_result: str,
        relay_policy: str,
    ) -> bool:
        """Keep Edge strictly behind a completed bounded direct attempt."""
        if direct_result in {"DIRECT_HOST", "DIRECT_SERVER_REFLEXIVE"}:
            self.stop(session_id)
            return False
        if direct_result not in {"DIRECT_FAILED", "AUTH_FAILED", "TIMEOUT", "REVOKED"}:
            raise RuntimeError("host_tunnel_direct_result_invalid")
        if direct_result == "REVOKED":
            self.stop(session_id)
            return False
        if relay_policy == "DIRECT_ONLY":
            self.stop(session_id)
            return False
        if relay_policy != "FALLBACK_ONLY":
            raise RuntimeError("host_tunnel_relay_policy_invalid")
        return self.reconcile(session_id, workspace_port, True)

    @staticmethod
    def _stop_process(process: ProcessLike) -> None:
        if process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=5.0)
            return
        except Exception:
            pass
        try:
            process.kill()
            process.wait(timeout=2.0)
        except Exception:
            pass

    def stop(self, session_id: str) -> None:
        runtime = self.runtimes.pop(session_id, None)
        if runtime is not None:
            self._stop_process(runtime.process)
            self._cleanup_files(runtime)
        self.retries.pop(session_id, None)

    def stop_except(self, desired_session_ids: set[str]) -> None:
        for session_id in list(self.runtimes):
            if session_id not in desired_session_ids:
                self.stop(session_id)
        for session_id in list(self.retries):
            if session_id not in desired_session_ids:
                self.retries.pop(session_id, None)

    def stop_all(self) -> None:
        for session_id in list(self.runtimes):
            self.stop(session_id)
        self.retries.clear()
