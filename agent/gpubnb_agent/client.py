"""HTTPS API client and signed heartbeat protocol."""
from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

import base58
from nacl.signing import SigningKey

from . import __version__
from .platform_info import gpu_inventory, system_inventory
from .storage import load_counter, save_counter


class ApiClient:
    def __init__(self, api_url: str, ca_file: str | None = None) -> None:
        self.api_url = api_url.rstrip("/")
        if self.api_url.startswith("http://") and "localhost" not in self.api_url and "127.0.0.1" not in self.api_url:
            raise RuntimeError("Une API distante doit utiliser HTTPS")
        self.context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()

    def request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(
            self.api_url + path,
            data=data,
            method=method,
            headers={"content-type": "application/json", "user-agent": f"gpubnb-agent/{__version__}", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=12, context=self.context) as response:
                return json.loads(response.read(1_000_000).decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode(errors="replace")
            raise RuntimeError(f"API HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"API inaccessible: {exc.reason}") from exc

    def health(self) -> dict[str, Any]:
        return self.request("/health")

    def link(self, code: str, public_key: str, inventory: dict[str, Any]) -> dict[str, Any]:
        return self.request("/agent/link", "POST", {"code": code, "publicKey": public_key, "inventory": inventory})


def signed_headers(key: SigningKey, machine_id: str, method: str, path: str) -> dict[str, str]:
    epoch = int(time.time() * 1000)
    canonical = f"{method.upper()}|{path}|{machine_id}|{epoch}"
    signature = base58.b58encode(key.sign(canonical.encode()).signature).decode()
    return {"x-agent-timestamp": str(epoch), "x-agent-signature": signature}


def heartbeat(client: ApiClient, key: SigningKey, machine_id: str) -> dict[str, Any]:
    challenge_path = f"/agent/challenge/{machine_id}"
    challenge = client.request(challenge_path, headers=signed_headers(key, machine_id, "GET", challenge_path))["challenge"]
    gpus = gpu_inventory()
    if len(gpus) != 1:
        raise RuntimeError("Le heartbeat exige exactement un GPU NVIDIA détecté")
    gpu = gpus[0]
    counter = load_counter() + 1
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    session_id = None
    probe = bool(gpu["cudaVersion"])
    fields = [
        machine_id, str(counter), challenge, timestamp, gpu["gpuUuid"], gpu["gpuModel"],
        str(gpu["vramMiB"]), gpu["driverVersion"], str(gpu["gpuUtilization"]),
        str(gpu["memoryUsedMiB"]), str(gpu["temperatureC"]), str(probe).lower(), "",
    ]
    signature = base58.b58encode(key.sign("|".join(fields).encode()).signature).decode()
    payload = {
        "machineId": machine_id, "counter": counter, "challenge": challenge,
        "timestamp": timestamp, **gpu, "cudaProbeOk": probe, "sessionId": session_id,
        "signature": signature, "agentVersion": __version__, **system_inventory(),
    }
    result = client.request("/agent/heartbeat", "POST", payload)
    save_counter(counter)
    return result
