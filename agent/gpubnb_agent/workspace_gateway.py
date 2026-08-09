"""Outbound-only Developer Workspace gateway.

The host never listens on a public interface. code-server is bound to 127.0.0.1
through Docker and all renter traffic is relayed through authenticated GPUbnb API
requests. The API remains the only Internet-facing endpoint.
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
from typing import Any

import websocket

from .client import ApiClient, agent_request
from .storage import load_config, load_key

PINNED_DEVELOPER_IMAGE = re.compile(r"^ghcr\.io/(?:khemisset18|gpubnb)/gpubnb-developer@sha256:[a-f0-9]{64}$")
NETWORK_NAME = "gpubnb-workspace-internal"


@dataclass
class Runtime:
    session_id: str
    container_name: str
    volume_name: str
    port: int


class GatewaySupervisor:
    def __init__(self, api: ApiClient, key: Any, machine_id: str, config: dict[str, Any]) -> None:
        self.api = api
        self.key = key
        self.machine_id = machine_id
        self.config = config
        self.runtimes: dict[str, Runtime] = {}
        self.channels: dict[str, websocket.WebSocket] = {}
        self.stop_event = threading.Event()

    def _request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
        return agent_request(self.api, self.key, self.machine_id, path, method, body)

    def _docker(self, args: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False, shell=False)
        if check and result.returncode != 0:
            raise RuntimeError(f"workspace_docker_failed:{args[0]}:{result.returncode}:{result.stderr[:500].strip()}")
        return result

    def _ensure_network(self) -> None:
        inspect = self._docker(["network", "inspect", NETWORK_NAME], check=False)
        if inspect.returncode != 0:
            self._docker(["network", "create", "--internal", NETWORK_NAME])

    def _developer_image(self) -> str:
        images = self.config.get("workspaceImages") if isinstance(self.config.get("workspaceImages"), dict) else {}
        image = str(images.get("developer") or "")
        if not PINNED_DEVELOPER_IMAGE.fullmatch(image):
            raise RuntimeError("developer_workspace_image_must_be_official_and_digest_pinned")
        return image

    def _start_runtime(self, session_id: str) -> Runtime:
        self._ensure_network()
        image = self._developer_image()
        suffix = re.sub(r"[^a-zA-Z0-9]", "", session_id)[-16:] or "session"
        container = f"gpubnb-dev-{suffix}"
        volume = f"gpubnb-workspace-{suffix}"
        self._docker(["volume", "create", volume])
        self._docker([
            "run", "-d", "--rm", "--name", container,
            "--network", NETWORK_NAME,
            "-p", "127.0.0.1::3000",
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=512", "--memory=4g", "--cpus=2",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=256m",
            "--tmpfs=/home/coder:rw,nosuid,size=512m",
            "--mount", f"type=volume,source={volume},target=/workspace",
            "--entrypoint", "code-server", image,
            "--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace",
        ], timeout=120)
        port_result = self._docker(["port", container, "3000/tcp"])
        match = re.search(r"127\.0\.0\.1:(\d+)", port_result.stdout)
        if not match:
            self._cleanup_names(container, volume)
            raise RuntimeError("developer_workspace_loopback_port_missing")
        port = int(match.group(1))
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
                    if 200 <= response.status < 500:
                        runtime = Runtime(session_id, container, volume, port)
                        self.runtimes[session_id] = runtime
                        return runtime
            except Exception:
                time.sleep(0.5)
        self._cleanup_names(container, volume)
        raise RuntimeError("developer_workspace_health_timeout")

    def _cleanup_names(self, container: str, volume: str) -> bool:
        self._docker(["rm", "-f", container], check=False)
        inspect = self._docker(["inspect", container], check=False)
        self._docker(["volume", "rm", "-f", volume], check=False)
        volume_inspect = self._docker(["volume", "inspect", volume], check=False)
        return inspect.returncode != 0 and volume_inspect.returncode != 0

    def _stop_runtime(self, session_id: str) -> bool:
        runtime = self.runtimes.pop(session_id, None)
        if runtime is None:
            suffix = re.sub(r"[^a-zA-Z0-9]", "", session_id)[-16:] or "session"
            return self._cleanup_names(f"gpubnb-dev-{suffix}", f"gpubnb-workspace-{suffix}")
        for channel_id, ws in list(self.channels.items()):
            try:
                ws.close()
            except Exception:
                pass
            self.channels.pop(channel_id, None)
        return self._cleanup_names(runtime.container_name, runtime.volume_name)

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
        for session in desired.get("sessions") or []:
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
            if existing is None:
                existing = self._start_runtime(session_id)
            if metadata.get("runtimeId") != existing.container_name or metadata.get("localPort") != existing.port:
                self._request(f"/agent/workspace-gateway/{session_id}/register", "POST", {"machineId": self.machine_id, "runtimeId": existing.container_name, "localPort": existing.port})

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

    def _ws_reader(self, channel_id: str, ws: websocket.WebSocket) -> None:
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
            try:
                self._request("/agent/workspace-gateway/ws-frame", "POST", {"machineId": self.machine_id, "channelId": channel_id, "close": True})
            except Exception:
                pass

    def _ws_open(self, item: dict[str, Any]) -> None:
        runtime = self._runtime_for(str(item.get("sessionId") or ""))
        channel_id = str(item.get("channelId") or "")
        path = str(item.get("path") or "/")
        if not channel_id or not path.startswith("/") or ".." in path:
            return
        headers = [f"{k}: {v}" for k, v in (item.get("headers") or {}).items() if str(k).lower() not in {"host", "origin", "cookie", "authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"}]
        ws = websocket.create_connection(f"ws://127.0.0.1:{runtime.port}{path}", header=headers, origin=f"http://127.0.0.1:{runtime.port}", timeout=10, enable_multithread=True)
        self.channels[channel_id] = ws
        threading.Thread(target=self._ws_reader, args=(channel_id, ws), daemon=True, name=f"gpubnb-ws-{channel_id[:8]}").start()

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
                if time.monotonic() - last_reconcile >= 1.0:
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
