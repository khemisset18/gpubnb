"""Outbound-only Developer Workspace gateway.

The host never listens on a public interface. The renter workspace stays on a
per-session Docker internal network with no Internet route. A separate hardened
TCP proxy, which has neither the GPU nor the workspace volume, is the only
container published on 127.0.0.1. All renter traffic is then relayed through
authenticated GPUbnb API requests. The API remains the only Internet-facing
endpoint.

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
from .runner import DEVELOPER_HOME_TMPFS, gpu_passthrough_flags
from .storage import load_config, load_key
from .runtime_images import workspace_image

PINNED_DEVELOPER_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpubnb-developer@sha256:[a-f0-9]{64}$")
CONTAINER_PREFIX = "gpubnb-dev-"
PROXY_PREFIX = "gpubnb-dev-proxy-"
VOLUME_PREFIX = "gpubnb-workspace-"
INTERNAL_NETWORK_PREFIX = "gpubnb-workspace-internal-"
GATEWAY_NETWORK_NAME = "gpubnb-workspace-gateway"
HEALTH_TIMEOUT_SECONDS = 30.0
START_TIMEOUT_SECONDS = 120
PORT_DISCOVERY_TIMEOUT_SECONDS = 10.0
RECONCILE_INTERVAL_SECONDS = 1.0
USAGE_REPORT_INTERVAL_SECONDS = 10.0
WS_MAX_FRAME_BYTES = 4 * 1024 * 1024


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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_RELAY_OPENER = urllib.request.build_opener(_NoRedirect)


@dataclass
class Runtime:
    session_id: str
    container_name: str
    proxy_name: str
    volume_name: str
    network_name: str
    port: int


def _session_suffix(session_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "", session_id)[-16:] or "session"


def names_for_session(session_id: str) -> tuple[str, str]:
    suffix = _session_suffix(session_id)
    return f"{CONTAINER_PREFIX}{suffix}", f"{VOLUME_PREFIX}{suffix}"


def proxy_name_for_session(session_id: str) -> str:
    return f"{PROXY_PREFIX}{_session_suffix(session_id)}"


def network_name_for_session(session_id: str) -> str:
    return f"{INTERNAL_NETWORK_PREFIX}{_session_suffix(session_id)}"


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
        error_callback: Callable[[Exception], None] | None = None,
    ) -> None:
        self.api = api
        self.key = key
        self.machine_id = machine_id
        self.config = config
        self.runtimes: dict[str, Runtime] = {}
        self.channels: dict[str, websocket.WebSocket] = {}
        self.session_channels: dict[str, set[str]] = {}
        self.usage_last_report: dict[str, float] = {}
        self.start_failures: dict[str, int] = {}
        self.start_retry_at: dict[str, float] = {}
        self.stop_event = threading.Event()
        self._error_callback = error_callback
        self._last_error_signature: str | None = None
        self._last_error_reported_at = 0.0
        self._docker_runner: DockerRunner = docker_runner or _real_docker
        self._process_inspector: ProcessInspector = process_inspector or WindowsProcessInspector()
        self._health_check: Callable[[int], bool] = health_check or _real_health_check
        self._mining_guard: Callable[[], bool] = mining_guard or (
            lambda: stop_all_miners_and_verify(miner_install_root(), self._process_inspector)
        )

    def _request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
        return agent_request(self.api, self.key, self.machine_id, path, method, body)

    def _docker(self, args: list[str], timeout: int = 30, check: bool = True) -> "subprocess.CompletedProcess[str]":
        return self._docker_runner(args, timeout=timeout, check=check)

    def _stop_mining_and_verify(self) -> bool:
        return self._mining_guard()

    def _ensure_networks(self, internal_network: str) -> None:
        internal = self._docker(["network", "inspect", internal_network], check=False)
        if internal.returncode != 0:
            self._docker(["network", "create", "--internal", internal_network])
        gateway = self._docker(["network", "inspect", GATEWAY_NETWORK_NAME], check=False)
        if gateway.returncode != 0:
            self._docker(["network", "create", GATEWAY_NETWORK_NAME])

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
        match = re.search(r"(?:127\.0\.0\.1|\[::1\]|::1):(\d+)", port_result.stdout)
        return int(match.group(1)) if match else None

    @staticmethod
    def _single_line(value: str, limit: int = 500) -> str:
        return re.sub(r"[\x00-\x20\x7f]+", " ", value).strip()[:limit]

    def _container_exit_error(self, container: str) -> RuntimeError:
        state = self._docker([
            "inspect", "--format",
            "exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}",
            container,
        ], check=False)
        logs = self._docker(["logs", "--tail", "100", container], check=False)
        state_text = self._single_line(state.stdout or state.stderr) or "state_unavailable"
        log_text = self._single_line(f"{logs.stdout}\n{logs.stderr}") or "no_container_logs"
        return RuntimeError(f"developer_workspace_container_exited:{state_text}:logs={log_text}")

    def _launch_workspace_container(
        self, container: str, volume: str, internal_network: str, image: str
    ) -> None:
        self._docker([
            "run", "-d", "--name", container,
            "--network", internal_network,
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=512", "--memory=4g", "--cpus=2",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=256m",
            DEVELOPER_HOME_TMPFS,
            "--mount", f"type=volume,source={volume},target=/workspace",
            *gpu_passthrough_flags("compute,utility"),
            "--entrypoint", "code-server", image,
            "--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace",
        ], timeout=START_TIMEOUT_SECONDS)

    def _launch_proxy_container(
        self, proxy: str, workspace: str, internal_network: str, image: str
    ) -> None:
        self._docker([
            "run", "-d", "--name", proxy,
            "--network", GATEWAY_NETWORK_NAME,
            "-p", "127.0.0.1::3000",
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=64", "--memory=128m", "--cpus=0.25",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=16m,mode=1777",
            "--user=1000:1000", "--no-healthcheck",
            "--env", f"GPUBNB_TARGET={workspace}",
            "--entrypoint", "node", image,
            "/usr/local/lib/gpubnb/loopback-proxy.js",
        ], timeout=START_TIMEOUT_SECONDS)
        self._docker(["network", "connect", internal_network, proxy])

    def _wait_healthy(self, port: int, deadline: float | None = None) -> bool:
        deadline = deadline if deadline is not None else time.time() + HEALTH_TIMEOUT_SECONDS
        while time.time() < deadline:
            if self._health_check(port):
                return True
            time.sleep(0.5)
        return False

    def _start_runtime(self, session_id: str) -> Runtime:
        image = self._developer_image()
        if not self._stop_mining_and_verify():
            raise RuntimeError("workspace_start_blocked_mining_stop_unverified")
        container, volume = names_for_session(session_id)
        proxy = proxy_name_for_session(session_id)
        internal_network = network_name_for_session(session_id)
        self._ensure_networks(internal_network)
        self._docker(["volume", "create", volume])
        self._launch_workspace_container(container, volume, internal_network, image)
        if not self._container_running(container):
            error = self._container_exit_error(container)
            self._cleanup_names(container, volume)
            raise error
        try:
            self._launch_proxy_container(proxy, container, internal_network, image)
        except Exception:
            self._cleanup_names(container, volume)
            raise

        port = None
        port_deadline = time.time() + PORT_DISCOVERY_TIMEOUT_SECONDS
        while time.time() < port_deadline:
            if not self._container_running(container):
                error = self._container_exit_error(container)
                self._cleanup_names(container, volume)
                raise error
            if not self._container_running(proxy):
                error = self._container_exit_error(proxy)
                self._cleanup_names(container, volume)
                raise error
            port = self._discover_port(proxy)
            if port is not None:
                break
            time.sleep(0.2)
        if port is None:
            self._cleanup_names(container, volume)
            raise RuntimeError("developer_workspace_loopback_proxy_port_missing")
        if not self._wait_healthy(port):
            failed = next(
                (name for name in (container, proxy) if not self._container_running(name)),
                None,
            )
            if failed is not None:
                error = self._container_exit_error(failed)
                self._cleanup_names(container, volume)
                raise error
            self._cleanup_names(container, volume)
            raise RuntimeError("developer_workspace_health_timeout")
        runtime = Runtime(session_id, container, proxy, volume, internal_network, port)
        self.runtimes[session_id] = runtime
        return runtime

    def _adopt_or_start_runtime(self, session_id: str) -> Runtime:
        container, volume = names_for_session(session_id)
        proxy = proxy_name_for_session(session_id)
        internal_network = network_name_for_session(session_id)
        if self._container_running(container) and self._container_running(proxy):
            port = self._discover_port(proxy)
            if port is not None and self._health_check(port):
                runtime = Runtime(
                    session_id, container, proxy, volume, internal_network, port
                )
                self.runtimes[session_id] = runtime
                return runtime
        self._cleanup_names(container, volume)
        return self._start_runtime(session_id)

    def _cleanup_names(self, container: str, volume: str) -> bool:
        suffix = container[len(CONTAINER_PREFIX):]
        proxy = f"{PROXY_PREFIX}{suffix}"
        internal_network = f"{INTERNAL_NETWORK_PREFIX}{suffix}"
        self._docker(["rm", "-f", proxy], check=False)
        self._docker(["rm", "-f", container], check=False)
        proxy_inspect = self._docker(["inspect", proxy], check=False)
        workspace_inspect = self._docker(["inspect", container], check=False)
        self._docker(["volume", "rm", "-f", volume], check=False)
        volume_inspect = self._docker(["volume", "inspect", volume], check=False)
        self._docker(["network", "rm", internal_network], check=False)
        network_inspect = self._docker(
            ["network", "inspect", internal_network], check=False
        )
        return all(
            item.returncode != 0
            for item in (
                proxy_inspect,
                workspace_inspect,
                volume_inspect,
                network_inspect,
            )
        )

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
        self.start_failures.pop(session_id, None)
        self.start_retry_at.pop(session_id, None)
        runtime = self.runtimes.pop(session_id, None)
        if runtime is None:
            container, volume = names_for_session(session_id)
            return self._cleanup_names(container, volume)
        return self._cleanup_names(runtime.container_name, runtime.volume_name)

    def _report_running_usage(self, runtime: Runtime) -> None:
        now = time.monotonic()
        previous = self.usage_last_report.setdefault(runtime.session_id, now)
        elapsed = int(now - previous)
        if elapsed < USAGE_REPORT_INTERVAL_SECONDS:
            return
        if (
            not self._container_running(runtime.container_name)
            or not self._container_running(runtime.proxy_name)
            or not self._health_check(runtime.port)
        ):
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
        desired_workspaces = {
            names_for_session(session_id)[0] for session_id in desired_session_ids
        }
        desired_proxies = {
            proxy_name_for_session(session_id) for session_id in desired_session_ids
        }
        desired_volumes = {
            names_for_session(session_id)[1] for session_id in desired_session_ids
        }
        desired_networks = {
            network_name_for_session(session_id) for session_id in desired_session_ids
        }
        adopted_workspaces = {
            runtime.container_name for runtime in self.runtimes.values()
        }
        adopted_proxies = {runtime.proxy_name for runtime in self.runtimes.values()}
        adopted_volumes = {runtime.volume_name for runtime in self.runtimes.values()}
        adopted_networks = {runtime.network_name for runtime in self.runtimes.values()}

        listing = self._docker(
            [
                "ps", "-a", "--filter", f"name=^{CONTAINER_PREFIX}",
                "--format", "{{.Names}}",
            ],
            check=False,
        )
        if listing.returncode == 0:
            for name in listing.stdout.splitlines():
                name = name.strip()
                if not name or name.startswith(PROXY_PREFIX):
                    continue
                if name in desired_workspaces or name in adopted_workspaces:
                    continue
                volume = VOLUME_PREFIX + name[len(CONTAINER_PREFIX):]
                self._cleanup_names(name, volume)

        proxy_listing = self._docker(
            [
                "ps", "-a", "--filter", f"name=^{PROXY_PREFIX}",
                "--format", "{{.Names}}",
            ],
            check=False,
        )
        if proxy_listing.returncode == 0:
            for proxy in proxy_listing.stdout.splitlines():
                proxy = proxy.strip()
                if not proxy or proxy in desired_proxies or proxy in adopted_proxies:
                    continue
                suffix = proxy[len(PROXY_PREFIX):]
                self._cleanup_names(
                    f"{CONTAINER_PREFIX}{suffix}", f"{VOLUME_PREFIX}{suffix}"
                )

        volume_listing = self._docker(
            [
                "volume", "ls", "--filter", f"name=^{VOLUME_PREFIX}",
                "--format", "{{.Name}}",
            ],
            check=False,
        )
        if volume_listing.returncode == 0:
            for volume in volume_listing.stdout.splitlines():
                volume = volume.strip()
                if not volume or volume in desired_volumes or volume in adopted_volumes:
                    continue
                suffix = volume[len(VOLUME_PREFIX):]
                self._cleanup_names(
                    f"{CONTAINER_PREFIX}{suffix}", volume
                )

        network_listing = self._docker(
            [
                "network", "ls", "--filter", f"name=^{INTERNAL_NETWORK_PREFIX}",
                "--format", "{{.Name}}",
            ],
            check=False,
        )
        if network_listing.returncode == 0:
            for network in network_listing.stdout.splitlines():
                network = network.strip()
                if (
                    not network
                    or network in desired_networks
                    or network in adopted_networks
                ):
                    continue
                self._docker(["network", "rm", network], check=False)

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
            if existing is not None and (
                not self._container_running(existing.container_name)
                or not self._container_running(existing.proxy_name)
            ):
                self.runtimes.pop(session_id, None)
                existing = None
            if existing is None:
                if time.monotonic() < self.start_retry_at.get(session_id, 0.0):
                    continue
                try:
                    existing = self._adopt_or_start_runtime(session_id)
                except Exception:
                    failures = self.start_failures.get(session_id, 0) + 1
                    self.start_failures[session_id] = failures
                    self.start_retry_at[session_id] = time.monotonic() + min(
                        60.0, 5.0 * (2 ** min(failures - 1, 4))
                    )
                    raise
                else:
                    self.start_failures.pop(session_id, None)
                    self.start_retry_at.pop(session_id, None)
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
                response = _RELAY_OPENER.open(req, timeout=25)
                status, response_headers, data = response.status, dict(response.headers.items()), response.read(10 * 1024 * 1024)
            except urllib.error.HTTPError as exc:
                status, response_headers, data = exc.code, dict(exc.headers.items()), exc.read(10 * 1024 * 1024)
            payload = {"machineId": self.machine_id, "id": request_id, "status": status, "headers": response_headers, "bodyBase64": base64.b64encode(data).decode()}
        except Exception as exc:
            payload = {"machineId": self.machine_id, "id": request_id, "status": 502, "error": str(exc)[:200]}
        self._request("/agent/workspace-gateway/respond", "POST", payload)

    def _ws_reader(self, session_id: str, channel_id: str, ws: websocket.WebSocket) -> None:
        frame_count = 0
        try:
            while not self.stop_event.is_set():
                opcode, data = ws.recv_data()
                if opcode == websocket.ABNF.OPCODE_CLOSE:
                    break
                raw = data.encode() if isinstance(data, str) else bytes(data)
                if len(raw) > WS_MAX_FRAME_BYTES:
                    raise RuntimeError(
                        f"ws_frame_too_large:channel={channel_id[:8]}:len={len(raw)}:max={WS_MAX_FRAME_BYTES}"
                    )
                frame_count += 1
                if frame_count == 1:
                    self._report_error(RuntimeError(f"ws_channel_first_frame:channel={channel_id[:8]}:opcode={opcode}:len={len(raw)}"))
                self._request("/agent/workspace-gateway/ws-frame", "POST", {"machineId": self.machine_id, "channelId": channel_id, "dataBase64": base64.b64encode(raw).decode(), "binary": opcode == websocket.ABNF.OPCODE_BINARY})
        except Exception as exc:
            self._report_error(exc)
        finally:
            self._report_error(RuntimeError(f"ws_channel_closed:channel={channel_id[:8]}:frames={frame_count}"))
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            try:
                self._request("/agent/workspace-gateway/ws-frame", "POST", {"machineId": self.machine_id, "channelId": channel_id, "close": True})
            except Exception:
                pass

    def _ws_open(self, item: dict[str, Any]) -> None:
        request_id = str(item.get("id") or "")
        session_id = str(item.get("sessionId") or "")
        channel_id = str(item.get("channelId") or "")
        path = str(item.get("path") or "/")
        ws: websocket.WebSocket | None = None

        def report_failure(error: Exception) -> None:
            self._report_error(error)
            if not request_id:
                return
            try:
                self._request(
                    "/agent/workspace-gateway/respond",
                    "POST",
                    {
                        "machineId": self.machine_id,
                        "id": request_id,
                        "status": 502,
                        "error": str(error)[:200],
                    },
                )
            except Exception as report_exc:
                self._report_error(report_exc)

        try:
            if not channel_id or not path.startswith("/") or ".." in path:
                raise RuntimeError(
                    f"ws_channel_open_rejected:path={path[:80]!r}:channel_present={bool(channel_id)}"
                )
            runtime = self._runtime_for(session_id)
            headers = [f"{k}: {v}" for k, v in (item.get("headers") or {}).items() if str(k).lower() not in {"host", "origin", "cookie", "authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"}]
            ws = websocket.create_connection(f"ws://127.0.0.1:{runtime.port}{path}", header=headers, origin=f"http://127.0.0.1:{runtime.port}", timeout=10, enable_multithread=True)
            self.channels[channel_id] = ws
            self.session_channels.setdefault(session_id, set()).add(channel_id)
            reader = threading.Thread(target=self._ws_reader, args=(session_id, channel_id, ws), daemon=True, name=f"gpubnb-ws-{channel_id[:8]}")
            reader.start()
        except Exception as exc:
            self.channels.pop(channel_id, None)
            self.session_channels.get(session_id, set()).discard(channel_id)
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            report_failure(exc)
            return

        self._report_error(RuntimeError(f"ws_channel_opened:channel={channel_id[:8]}:path={path[:60]!r}"))
        if request_id:
            def report_open_ack() -> None:
                try:
                    self._request(
                        "/agent/workspace-gateway/respond",
                        "POST",
                        {"machineId": self.machine_id, "id": request_id, "status": 101},
                    )
                except Exception as exc:
                    self._report_error(
                        RuntimeError(
                            f"ws_open_ack_report_failed:channel={channel_id[:8]}:{str(exc)[:180]}"
                        )
                    )

            threading.Thread(
                target=report_open_ack,
                daemon=True,
                name=f"gpubnb-ws-ack-{channel_id[:8]}",
            ).start()

    def _handle(self, item: dict[str, Any]) -> None:
        kind = item.get("kind")
        if kind == "http":
            self._http(item)
        elif kind == "ws_open":
            self._ws_open(item)
        elif kind == "ws_send":
            channel_id = str(item.get("channelId") or "")
            ws = self.channels.get(channel_id)
            if ws:
                try:
                    data = base64.b64decode(str(item.get("dataBase64") or ""))
                    if item.get("binary"):
                        ws.send_binary(data)
                    else:
                        ws.send(data.decode("utf-8"))
                except Exception as exc:
                    self._report_error(exc)
                    self.channels.pop(channel_id, None)
                    self.session_channels.get(str(item.get("sessionId") or ""), set()).discard(channel_id)
                    try:
                        ws.close()
                    except Exception:
                        pass
        elif kind == "ws_close":
            ws = self.channels.pop(str(item.get("channelId") or ""), None)
            if ws:
                ws.close()

    def _report_error(self, error: Exception) -> None:
        if self._error_callback is None:
            return
        now = time.monotonic()
        signature = f"{type(error).__name__}:{str(error)[:300]}"
        if (
            signature != self._last_error_signature
            or now - self._last_error_reported_at >= 30
        ):
            self._error_callback(error)
            self._last_error_signature = signature
            self._last_error_reported_at = now

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
            except Exception as exc:
                self._report_error(exc)
                time.sleep(1)
            else:
                self._last_error_signature = None
                time.sleep(0.05)


def run_workspace_gateway_forever(
    stop_event: threading.Event | None = None,
    error_callback: Callable[[Exception], None] | None = None,
) -> None:
    config = load_config()
    machine_id = config.get("machineId")
    if not isinstance(machine_id, str) or not machine_id:
        raise RuntimeError("workspace_gateway_machine_not_linked")
    api = ApiClient(str(config.get("apiUrl") or "https://gpubnb.netlify.app/api"), config.get("caFile"))
    supervisor = GatewaySupervisor(
        api,
        load_key(),
        machine_id,
        config,
        error_callback=error_callback,
    )
    if stop_event is not None:
        supervisor.stop_event = stop_event
    supervisor.run()
