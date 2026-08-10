"""Outbound-only Developer Workspace gateway.

The host never listens on a public interface. code-server is bound to 127.0.0.1
through Docker and all renter traffic is relayed through authenticated GPUbnb API
requests. The API remains the only Internet-facing endpoint.

Mining/rental exclusivity, and surviving a crash or agent restart without ever
running a miner and a renter's workspace at once, are both enforced here rather
than left to the Tauri GUI - see mining_guard.py and _adopt_or_start_runtime /
_sweep_orphaned_containers below for why.
"""
from __future__ import annotations

import base64
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

import websocket

from .client import ApiClient, agent_request
from .mining_guard import ProcessInspector, WindowsProcessInspector, miner_install_root, stop_all_miners_and_verify
from .runner import gpu_passthrough_flags
from .storage import load_config, load_key
from .runtime_images import workspace_image

PINNED_DEVELOPER_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpubnb-developer@sha256:[a-f0-9]{64}$")
NETWORK_NAME = "gpubnb-workspace-internal"
CONTAINER_PREFIX = "gpubnb-dev-"
VOLUME_PREFIX = "gpubnb-workspace-"
HEALTH_TIMEOUT_SECONDS = 30.0
START_TIMEOUT_SECONDS = 120
RECONCILE_INTERVAL_SECONDS = 1.0
USAGE_REPORT_INTERVAL_SECONDS = 10.0


class DockerRunner(Protocol):
    def __call__(self, args: list[str], timeout: int = 30, check: bool = True) -> "subprocess.CompletedProcess[str]": ...


def _real_docker(args: list[str], timeout: int = 30, check: bool = True) -> "subprocess.CompletedProcess[str]":
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False, shell=False)
    if check and result.returncode != 0:
        raise RuntimeError(f"workspace_docker_failed:{args[0]}:{result.returncode}:{result.stderr[:500].strip()}")
    return result


def _real_health_check(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


@dataclass
class Runtime:
    session_id: str
    container_name: str
    volume_name: str
    port: int


def names_for_session(session_id: str) -> tuple[str, str]:
    suffix = re.sub(r"[^a-zA-Z0-9]", "", session_id)[-16:] or "session"
    return f"{CONTAINER_PREFIX}{suffix}", f"{VOLUME_PREFIX}{suffix}"


class GatewaySupervisor:
    def __init__(
        self,
        api: ApiClient,
        key: Any,
        machine_id: str,
        config: dict[str, Any],
        docker_runner: DockerRunner | None = None,
        process_inspector: ProcessInspector | None = None,
        health_check: Callable[[int], bool] | None = None,
        mining_guard: Callable[[], bool] | None = None,
    ) -> None:
        self.api = api
        self.key = key
        self.machine_id = machine_id
        self.config = config
        self.runtimes: dict[str, Runtime] = {}
        self.channels: dict[str, websocket.WebSocket] = {}
        self.session_channels: dict[str, set[str]] = {}
        self.usage_last_report: dict[str, float] = {}
        self.stop_event = threading.Event()
        self._docker_runner: DockerRunner = docker_runner or _real_docker
        self._process_inspector: ProcessInspector = process_inspector or WindowsProcessInspector()
        self._health_check: Callable[[int], bool] = health_check or _real_health_check
        # A distinct injection point from process_inspector, not just a convenience:
        # the real path resolves %LOCALAPPDATA%, which doesn't exist on the Linux/macOS
        # CI runners this same package is tested on (see ci.yml's rust/host-desktop
        # matrix - the Python agent has an equivalent one), so tests must be able to
        # bypass path resolution entirely, not just the process backend.
        self._mining_guard: Callable[[], bool] = mining_guard or (
            lambda: stop_all_miners_and_verify(miner_install_root(), self._process_inspector)
        )

    def _request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
        return agent_request(self.api, self.key, self.machine_id, path, method, body)

    def _docker(self, args: list[str], timeout: int = 30, check: bool = True) -> "subprocess.CompletedProcess[str]":
        return self._docker_runner(args, timeout=timeout, check=check)

    def _stop_mining_and_verify(self) -> bool:
        return self._mining_guard()

    def _ensure_network(self) -> None:
        inspect = self._docker(["network", "inspect", NETWORK_NAME], check=False)
        if inspect.returncode != 0:
            self._docker(["network", "create", "--internal", NETWORK_NAME])

    def _developer_image(self) -> str:
        image = workspace_image(self.config, "developer")
        if not PINNED_DEVELOPER_IMAGE.fullmatch(image):
            raise RuntimeError("developer_workspace_image_must_be_official_and_digest_pinned")
        return image

    def _container_running(self, container: str) -> bool:
        inspect = self._docker(["inspect", "--format", "{{.State.Running}}", container], check=False)
        return inspect.returncode == 0 and inspect.stdout.strip() == "true"

    def _discover_port(self, container: str) -> int | None:
        port_result = self._docker(["port", container, "3000/tcp"], check=False)
        if port_result.returncode != 0:
            return None
        match = re.search(r"127\.0\.0\.1:(\d+)", port_result.stdout)
        return int(match.group(1)) if match else None

    def _launch_container(self, container: str, volume: str, image: str) -> None:
        self._docker([
            "run", "-d", "--rm", "--name", container,
            "--network", NETWORK_NAME,
            "-p", "127.0.0.1::3000",
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=512", "--memory=4g", "--cpus=2",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=256m",
            "--tmpfs=/home/coder:rw,nosuid,size=512m",
            "--mount", f"type=volume,source={volume},target=/workspace",
            # code-server serves the renter's own workloads (ML frameworks, CUDA code,
            # not just nvidia-smi), so this needs "compute" - the healthcheck/diagnostic
            # paths that share gpu_passthrough_flags() only need "utility" and keep the
            # narrower default.
            *gpu_passthrough_flags("compute,utility"),
            "--entrypoint", "code-server", image,
            "--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace",
        ], timeout=START_TIMEOUT_SECONDS)

    def _wait_healthy(self, port: int, deadline: float | None = None) -> bool:
        deadline = deadline if deadline is not None else time.time() + HEALTH_TIMEOUT_SECONDS
        while time.time() < deadline:
            if self._health_check(port):
                return True
            time.sleep(0.5)
        return False

    def _start_runtime(self, session_id: str) -> Runtime:
        # Cheap, local, no side effects - reject a bad image before touching Docker
        # or mining at all.
        image = self._developer_image()
        # Never start a Developer runtime while a miner might still hold the GPU - and
        # never trust "no miner was in self.runtimes" for that, since self.runtimes is
        # only ever populated by *this* process and a miner started by a previous
        # process (or a previous session's cleanup that never ran) is invisible to it.
        if not self._stop_mining_and_verify():
            raise RuntimeError("workspace_start_blocked_mining_stop_unverified")
        self._ensure_network()
        container, volume = names_for_session(session_id)
        self._docker(["volume", "create", volume])
        self._launch_container(container, volume, image)
        port = self._discover_port(container)
        if port is None:
            self._cleanup_names(container, volume)
            raise RuntimeError("developer_workspace_loopback_port_missing")
        if not self._wait_healthy(port):
            self._cleanup_names(container, volume)
            raise RuntimeError("developer_workspace_health_timeout")
        runtime = Runtime(session_id, container, volume, port)
        self.runtimes[session_id] = runtime
        return runtime

    def _adopt_or_start_runtime(self, session_id: str) -> Runtime:
        """Idempotent across an agent restart: if a container from a previous agent
        process is already running for this exact session, adopt it (re-query its
        real port) instead of trying to `docker run --name` a duplicate - which would
        just fail on the name collision - or leaving it invisible to this process."""
        container, volume = names_for_session(session_id)
        if self._container_running(container):
            port = self._discover_port(container)
            if port is not None and self._health_check(port):
                runtime = Runtime(session_id, container, volume, port)
                self.runtimes[session_id] = runtime
                return runtime
            # Running but unhealthy/unreachable: don't adopt a broken container, and
            # don't leave it behind either - replace it with a fresh one.
            self._cleanup_names(container, volume)
        else:
            # Exists but not running (crashed; --rm may not have fired yet) - clear it
            # before starting fresh so the name isn't taken.
            self._docker(["rm", "-f", container], check=False)
        return self._start_runtime(session_id)

    def _cleanup_names(self, container: str, volume: str) -> bool:
        self._docker(["rm", "-f", container], check=False)
        inspect = self._docker(["inspect", container], check=False)
        self._docker(["volume", "rm", "-f", volume], check=False)
        volume_inspect = self._docker(["volume", "inspect", volume], check=False)
        return inspect.returncode != 0 and volume_inspect.returncode != 0

    def _close_session_channels(self, session_id: str) -> None:
        for channel_id in self.session_channels.pop(session_id, set()):
            ws = self.channels.pop(channel_id, None)
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

    def _stop_runtime(self, session_id: str) -> bool:
        self._close_session_channels(session_id)
        self.usage_last_report.pop(session_id, None)
        runtime = self.runtimes.pop(session_id, None)
        if runtime is None:
            container, volume = names_for_session(session_id)
            return self._cleanup_names(container, volume)
        return self._cleanup_names(runtime.container_name, runtime.volume_name)

    def _report_running_usage(self, runtime: Runtime) -> None:
        """Bill only signed, healthy time after the workspace became openable."""
        now = time.monotonic()
        previous = self.usage_last_report.setdefault(runtime.session_id, now)
        elapsed = int(now - previous)
        if elapsed < USAGE_REPORT_INTERVAL_SECONDS:
            return
        if not self._container_running(runtime.container_name) or not self._health_check(runtime.port):
            self.usage_last_report[runtime.session_id] = now
            return
        interval = max(1, min(30, elapsed))
        self._request(
            f"/agent/workspace-gateway/{runtime.session_id}/usage",
            "POST",
            {
                "machineId": self.machine_id,
                "counter": str(int(time.time() * 1000)),
                "intervalSeconds": interval,
                "available": True,
            },
        )
        self.usage_last_report[runtime.session_id] = now

    def _sweep_orphaned_containers(self, desired_session_ids: set[str]) -> None:
        """Containers matching our own naming convention that correspond to no
        session we were told about at all - not "ours but not adopted yet", but
        genuinely nobody's. Left behind by e.g. a session the API already forgot
        about while the agent was offline. Stopped and removed outright: unlike an
        orphaned miner, there is no safe "leave it alone" option for a container that
        is occupying the GPU and network namespace we need for a real rental."""
        listing = self._docker(["ps", "-a", "--filter", f"name=^{CONTAINER_PREFIX}", "--format", "{{.Names}}"], check=False)
        if listing.returncode != 0:
            return
        desired_containers = {names_for_session(session_id)[0] for session_id in desired_session_ids}
        adopted_containers = {runtime.container_name for runtime in self.runtimes.values()}
        for name in listing.stdout.splitlines():
            name = name.strip()
            if not name or name in desired_containers or name in adopted_containers:
                continue
            volume = VOLUME_PREFIX + name[len(CONTAINER_PREFIX):]
            self._cleanup_names(name, volume)

    @staticmethod
    def _expired(value: object) -> bool:
        if not isinstance(value, str):
            return True
        try:
            expires = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return True
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires <= datetime.now(timezone.utc)

    def _reconcile_sessions(self) -> None:
        desired = self._request(f"/agent/workspace-gateway/{self.machine_id}/desired")
        sessions = desired.get("sessions") or []
        keep_alive_ids = {
            str(session.get("id") or "")
            for session in sessions
            if str(session.get("status") or "") in {"READY", "RUNNING"}
        }
        self._sweep_orphaned_containers(keep_alive_ids)
        for session in sessions:
            session_id = str(session.get("id") or "")
            status = str(session.get("status") or "")
            metadata = session.get("connectionMetadata") if isinstance(session.get("connectionMetadata"), dict) else {}
            if status in {"STOP_REQUESTED", "STOPPING"} or self._expired(session.get("expiresAt")):
                cleaned = self._stop_runtime(session_id)
                self._request(f"/agent/workspace-gateway/{session_id}/stopped", "POST", {"machineId": self.machine_id, "cleaned": cleaned})
                continue
            if status not in {"READY", "RUNNING"}:
                continue
            existing = self.runtimes.get(session_id)
            if existing is not None and not self._container_running(existing.container_name):
                # Tracked but actually dead (e.g. it crashed since the last cycle,
                # and --rm already reclaimed it) - drop the stale entry so the next
                # branch below starts a real replacement instead of trusting a ghost.
                self.runtimes.pop(session_id, None)
                existing = None
            if existing is None:
                existing = self._adopt_or_start_runtime(session_id)
            if metadata.get("runtimeId") != existing.container_name or metadata.get("localPort") != existing.port:
                self._request(f"/agent/workspace-gateway/{session_id}/register", "POST", {"machineId": self.machine_id, "runtimeId": existing.container_name, "localPort": existing.port})
            if status in {"READY", "RUNNING"}:
                self._report_running_usage(existing)

    def _runtime_for(self, session_id: str) -> Runtime:
        runtime = self.runtimes.get(session_id)
        if runtime is None:
            raise RuntimeError("workspace_runtime_not_running")
        return runtime

    def _http(self, item: dict[str, Any]) -> None:
        request_id = str(item.get("id") or "")
        try:
            runtime = self._runtime_for(str(item.get("sessionId") or ""))
            path = str(item.get("path") or "/")
            if not path.startswith("/") or ".." in path:
                raise RuntimeError("invalid_relay_path")
            body = base64.b64decode(str(item.get("bodyBase64") or ""), validate=False)
            headers = {str(k): str(v) for k, v in (item.get("headers") or {}).items() if str(k).lower() not in {"host", "cookie", "authorization"}}
            req = urllib.request.Request(f"http://127.0.0.1:{runtime.port}{path}", data=body if body else None, method=str(item.get("method") or "GET"), headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=25)
                status, response_headers, data = response.status, dict(response.headers.items()), response.read(10 * 1024 * 1024)
            except urllib.error.HTTPError as exc:
                status, response_headers, data = exc.code, dict(exc.headers.items()), exc.read(10 * 1024 * 1024)
            payload = {"machineId": self.machine_id, "id": request_id, "status": status, "headers": response_headers, "bodyBase64": base64.b64encode(data).decode()}
        except Exception as exc:
            payload = {"machineId": self.machine_id, "id": request_id, "status": 502, "error": str(exc)[:200]}
        self._request("/agent/workspace-gateway/respond", "POST", payload)

    def _ws_reader(self, session_id: str, channel_id: str, ws: websocket.WebSocket) -> None:
        try:
            while not self.stop_event.is_set():
                opcode, data = ws.recv_data()
                if opcode == websocket.ABNF.OPCODE_CLOSE:
                    break
                raw = data.encode() if isinstance(data, str) else bytes(data)
                self._request("/agent/workspace-gateway/ws-frame", "POST", {"machineId": self.machine_id, "channelId": channel_id, "dataBase64": base64.b64encode(raw).decode(), "binary": opcode == websocket.ABNF.OPCODE_BINARY})
        except Exception:
            pass
        finally:
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            try:
                self._request("/agent/workspace-gateway/ws-frame", "POST", {"machineId": self.machine_id, "channelId": channel_id, "close": True})
            except Exception:
                pass

    def _ws_open(self, item: dict[str, Any]) -> None:
        session_id = str(item.get("sessionId") or "")
        runtime = self._runtime_for(session_id)
        channel_id = str(item.get("channelId") or "")
        path = str(item.get("path") or "/")
        if not channel_id or not path.startswith("/") or ".." in path:
            return
        headers = [f"{k}: {v}" for k, v in (item.get("headers") or {}).items() if str(k).lower() not in {"host", "origin", "cookie", "authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"}]
        ws = websocket.create_connection(f"ws://127.0.0.1:{runtime.port}{path}", header=headers, origin=f"http://127.0.0.1:{runtime.port}", timeout=10, enable_multithread=True)
        self.channels[channel_id] = ws
        self.session_channels.setdefault(session_id, set()).add(channel_id)
        threading.Thread(target=self._ws_reader, args=(session_id, channel_id, ws), daemon=True, name=f"gpubnb-ws-{channel_id[:8]}").start()

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")
        if kind == "http":
            self._http(item)
        elif kind == "ws_open":
            self._ws_open(item)
        elif kind == "ws_send":
            ws = self.channels.get(str(item.get("channelId") or ""))
            if ws:
                data = base64.b64decode(str(item.get("dataBase64") or ""))
                if item.get("binary"):
                    ws.send_binary(data)
                else:
                    ws.send(data.decode("utf-8"))
        elif kind == "ws_close":
            ws = self.channels.pop(str(item.get("channelId") or ""), None)
            if ws:
                ws.close()

    def run(self) -> None:
        last_reconcile = 0.0
        while not self.stop_event.is_set():
            try:
                if time.monotonic() - last_reconcile >= RECONCILE_INTERVAL_SECONDS:
                    self._reconcile_sessions()
                    last_reconcile = time.monotonic()
                item = self._request(f"/agent/workspace-gateway/{self.machine_id}/next")
                if item:
                    self._handle(item)
            except Exception:
                time.sleep(1)
            else:
                time.sleep(0.05)


def run_workspace_gateway_forever() -> None:
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str) or not machine_id:
        return
    api = ApiClient(str(config.get("apiUrl") or "https://gpubnb.netlify.app/api"), config.get("caFile"))
    GatewaySupervisor(api, load_key(), machine_id, config).run()
