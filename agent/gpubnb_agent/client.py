"""HTTPS API client, signed heartbeat protocol, and file transfer."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import base58
from nacl.signing import SigningKey

from . import __version__
from .platform_info import gpu_inventory, system_inventory
from .storage import detect_hardware_change, load_counter, save_counter, save_machine_fingerprint
from .telemetry import telemetry_snapshot

MAX_RETRIES = 3
RETRY_BACKOFF = 2.0
EMPTY_BODY_SHA256 = hashlib.sha256(b"").hexdigest()
COUNTER_REPLAY_RESYNC_LIMIT = 64


class ApiClient:
    def __init__(self, api_url: str, ca_file: str | None = None) -> None:
        self.api_url = api_url.rstrip("/")
        if self.api_url.startswith("http://") and "localhost" not in self.api_url and "127.0.0.1" not in self.api_url:
            raise RuntimeError("Une API distante doit utiliser HTTPS")
        self.context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()

    def request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None, headers: dict[str, str] | None = None, timeout: int = 12) -> dict[str, Any]:
        data = None if body is None else canonical_json_bytes(body)
        request = urllib.request.Request(
            self.api_url + path,
            data=data,
            method=method,
            headers={"content-type": "application/json", "user-agent": f"gpubnb-agent/{__version__}", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=self.context) as response:
                if response.status == 204:
                    return {}
                return json.loads(response.read(1_000_000).decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode(errors="replace")
            raise RuntimeError(f"API HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"API inaccessible: {exc.reason}") from exc

    def request_with_retry(self, path: str, method: str = "GET", body: dict[str, Any] | None = None, headers: dict[str, str] | None = None, timeout: int = 12) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                return self.request(path, method, body, headers, timeout)
            except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as exc:
                last_error = exc
                if attempt < MAX_RETRIES - 1:
                    wait = min(30, RETRY_BACKOFF ** attempt)
                    time.sleep(wait)
        raise last_error  # type: ignore[misc]

    def health(self) -> dict[str, Any]:
        return self.request("/health")

    def link(self, code: str, public_key: str, inventory: dict[str, Any]) -> dict[str, Any]:
        return self.request("/agent/link", "POST", {"code": code, "publicKey": public_key, "inventory": inventory})

    def upload_file(self, path: str, job_id: str, file_path: str, key: SigningKey, machine_id: str, kind: str = "result") -> dict[str, Any]:
        data = Path(file_path).read_bytes()
        sha256 = hashlib.sha256(data).hexdigest()
        # The HTTP URL carries authenticated artifact metadata in its query string, but
        # the API's request-signature protocol canonicalizes the registered route path.
        # Sign only that route path while still sending the full URL below.
        signature_path = path.split("?", 1)[0]
        signed = signed_headers_for_body_sha256(key, machine_id, "POST", signature_path, sha256)
        headers = {"content-type": "application/octet-stream", "x-artifact-kind": kind, "x-artifact-sha256": sha256, "x-artifact-size": str(len(data)), **signed}
        request = urllib.request.Request(self.api_url + path, data=data, method="POST", headers={"user-agent": f"gpubnb-agent/{__version__}", **headers})
        try:
            with urllib.request.urlopen(request, timeout=120, context=self.context) as response:
                return json.loads(response.read(1_000_000).decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode(errors="replace")
            raise RuntimeError(f"Upload HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Upload échoué: {exc.reason}") from exc

    def download_file(self, path: str, dest_path: str, expected_sha256: str | None = None) -> dict[str, Any]:
        request = urllib.request.Request(self.api_url + path, method="GET", headers={"user-agent": f"gpubnb-agent/{__version__}"})
        try:
            with urllib.request.urlopen(request, timeout=120, context=self.context) as response:
                data = response.read(100_000_000)
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode(errors="replace")
            raise RuntimeError(f"Download HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Download échoué: {exc.reason}") from exc
        if expected_sha256:
            actual = hashlib.sha256(data).hexdigest()
            if actual != expected_sha256:
                raise RuntimeError(f"Intégrité compromise: attendu {expected_sha256}, obtenu {actual}")
        Path(dest_path).write_bytes(data)
        return {"downloaded": True, "path": dest_path, "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def canonical_json_bytes(body: dict[str, Any] | None) -> bytes:
    """Serialize request JSON exactly as ApiClient.request sends it."""
    if body is None:
        return b""
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def request_body_sha256(body: dict[str, Any] | None) -> str:
    return hashlib.sha256(canonical_json_bytes(body)).hexdigest()


def signed_headers_for_body_sha256(key: SigningKey, machine_id: str, method: str, path: str, body_sha256: str) -> dict[str, str]:
    """Build legacy and v2 signatures given an already-computed body hash. Shared by
    signed_headers (JSON bodies) and raw-bytes callers like artifact upload, which
    can't reuse canonical_json_bytes since their payload was never a JSON dict."""
    epoch = int(time.time() * 1000)
    nonce = secrets.token_urlsafe(18)
    legacy_canonical = f"{method.upper()}|{path}|{machine_id}|{epoch}"
    legacy_signature = base58.b58encode(key.sign(legacy_canonical.encode()).signature).decode()
    v2_canonical = f"{method.upper()}|{path}|{machine_id}|{epoch}|{nonce}|{body_sha256}"
    v2_signature = base58.b58encode(key.sign(v2_canonical.encode()).signature).decode()
    return {
        "x-agent-machine-id": machine_id,
        "x-agent-timestamp": str(epoch),
        "x-agent-signature": legacy_signature,
        "x-agent-signature-version": "2",
        "x-agent-nonce": nonce,
        "x-agent-body-sha256": body_sha256,
        "x-agent-signature-v2": v2_signature,
    }


def signed_headers(key: SigningKey, machine_id: str, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, str]:
    """Build legacy and v2 signatures during the migration window."""
    return signed_headers_for_body_sha256(key, machine_id, method, path, request_body_sha256(body))


def agent_request(client: ApiClient, key: SigningKey, machine_id: str, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    # Each attempt must carry its own signature: the server treats a signed
    # request as single-use, so retrying with headers computed once up front
    # gets every retry rejected as a replay instead of actually retrying.
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return client.request(path, method, body, signed_headers(key, machine_id, method, path, body))
        except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES - 1:
                time.sleep(min(30, RETRY_BACKOFF ** attempt))
    raise last_error  # type: ignore[misc]


def heartbeat(client: ApiClient, key: SigningKey, machine_id: str) -> dict[str, Any]:
    # Collect the comparatively slow Windows inventory before requesting the
    # short-lived server challenge or timestamping the heartbeat. Otherwise a
    # cold hardware scan can consume the entire validity window before send.
    gpus = gpu_inventory()
    if not gpus:
        raise RuntimeError("Le heartbeat exige au moins un GPU détecté")
    # The legacy heartbeat schema carries one primary GPU. The complete validated
    # multi-GPU snapshot is attached under telemetry for the v2 server migration.
    gpu = gpus[0]
    session_id = None
    probe = True
    sys_info = system_inventory()
    telemetry = telemetry_snapshot()
    current_fp = sys_info.get("machineFingerprint") or ""
    hw_changed, previous_fp = detect_hardware_change(current_fp)
    if current_fp:
        save_machine_fingerprint(current_fp)
    if hw_changed and previous_fp:
        print(f"AVERTISSEMENT: Empreinte matérielle modifiée (ancienne: {previous_fp[:16]}...)")
    challenge_path = f"/agent/challenge/{machine_id}"
    counter = load_counter()
    # Every attempt below is signed once and used once: the server-issued challenge
    # is single-use (redis GETDEL) and every signature is anti-replay-locked on first
    # use (verifyAgentRequest/V2). Reusing headers computed before a failed attempt —
    # what request_with_retry does — gets every retry rejected instead of recovering
    # from a transient failure. So a retry here means a fully fresh attempt: new
    # challenge, new timestamp/nonce, new signature, not just a resend.
    last_error: Exception | None = None
    network_attempt = 0
    resync_attempt = 0
    while network_attempt < MAX_RETRIES:
        counter += 1
        try:
            challenge = client.request(
                challenge_path,
                headers=signed_headers(key, machine_id, "GET", challenge_path),
            )["challenge"]
            timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            fields = [
                machine_id, str(counter), challenge, timestamp, gpu["gpuUuid"], gpu["gpuModel"],
                str(gpu["vramMiB"]), gpu["driverVersion"], str(gpu["gpuUtilization"]),
                str(gpu["memoryUsedMiB"]), str(gpu["temperatureC"]), str(probe).lower(), "",
            ]
            signature = base58.b58encode(key.sign("|".join(fields).encode()).signature).decode()
            payload = {
                "machineId": machine_id,
                "counter": counter,
                "challenge": challenge,
                "timestamp": timestamp,
                **gpu,
                "cudaProbeOk": probe,
                "gpuVendor": gpu.get("gpuVendor"),
                "sessionId": session_id,
                "signature": signature,
                "agentVersion": __version__,
                "hardwareChanged": hw_changed,
                "telemetry": telemetry,
                **sys_info,
            }
            result = client.request(
                "/agent/heartbeat", "POST", payload,
                signed_headers(key, machine_id, "POST", "/agent/heartbeat", payload),
            )
            save_counter(counter)
            return result
        except (urllib.error.URLError, RuntimeError, TimeoutError, OSError) as exc:
            last_error = exc
            if "counter_replay" in str(exc) and resync_attempt < COUNTER_REPLAY_RESYNC_LIMIT:
                # The local counter file fell behind the server's last accepted
                # value (crash/uninstall wiped ProgramData before the last
                # successful save could land, or two agent instances raced).
                # `counter` is now burned — the server has already seen an
                # equal-or-higher value for this key, so it can never be reused —
                # persist it immediately and try the next value right away instead
                # of retrying the exact same doomed counter forever, which is what
                # left the agent stuck offline after every reinstall.
                save_counter(counter)
                resync_attempt += 1
                continue
            network_attempt += 1
            if network_attempt < MAX_RETRIES:
                time.sleep(min(30, RETRY_BACKOFF ** network_attempt))
    raise last_error  # type: ignore[misc]
