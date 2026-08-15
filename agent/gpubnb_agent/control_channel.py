"""Persistent, resumable QUIC control channel for GPUbnb Hosts.

This module transports bounded control messages only. Durable GPU job ownership,
leases and execution remain in the existing HTTPS job protocol during migration.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import random
import re
import secrets
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from aioquic.asyncio import connect
from aioquic.quic.configuration import QuicConfiguration
from nacl.signing import SigningKey

from .storage import load_control_channel_state, save_control_channel_state

PROTOCOL_VERSION = 1
ALPN = "gpubnb-control/1"
AUTH_DOMAIN = "gpubnb-control-gateway-auth-v1"
MAX_FRAME_BYTES = 256 * 1024
MAX_COMMAND_PAYLOAD_BYTES = 48 * 1024
MAX_COMMAND_LIFETIME_MS = 15 * 60 * 1000
MAX_CLOCK_SKEW_MS = 2 * 60 * 1000
RESULT_CACHE_SIZE = 64
ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
DNS_RE = re.compile(r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
DETAIL_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")
KNOWN_KINDS = {
    "PREPARE_RENTAL", "START_RENTAL", "STOP_RENTAL", "START_MINING",
    "STOP_MINING", "REFRESH_INVENTORY", "RUN_DIAGNOSTIC", "QUARANTINE",
}
LEASE_REQUIRED_KINDS = {"PREPARE_RENTAL", "START_RENTAL"}
TERMINAL_ACKS = {"SUCCEEDED", "FAILED", "REJECTED"}


class ControlChannelError(RuntimeError):
    pass


class ControlChannelFenced(ControlChannelError):
    pass


@dataclass(frozen=True)
class ControlChannelAssignment:
    enabled: bool
    protocol_version: int = PROTOCOL_VERSION
    host: str | None = None
    port: int = 4443
    server_name: str | None = None
    fallback_poll_seconds: int = 120

    @classmethod
    def parse(cls, value: Any) -> "ControlChannelAssignment":
        if not isinstance(value, dict):
            return cls(enabled=False)
        allowed = {"enabled", "protocolVersion", "host", "port", "serverName", "fallbackPollSeconds"}
        if set(value) - allowed:
            raise ControlChannelError("control_assignment_unknown_field")
        enabled = value.get("enabled")
        version = value.get("protocolVersion", PROTOCOL_VERSION)
        fallback = value.get("fallbackPollSeconds", 120)
        if not isinstance(enabled, bool):
            raise ControlChannelError("control_assignment_enabled_invalid")
        if version != PROTOCOL_VERSION:
            raise ControlChannelError("control_assignment_protocol_unsupported")
        if isinstance(fallback, bool) or not isinstance(fallback, int) or not 30 <= fallback <= 900:
            raise ControlChannelError("control_assignment_fallback_invalid")
        if not enabled:
            return cls(enabled=False, fallback_poll_seconds=fallback)
        host = value.get("host")
        port = value.get("port", 4443)
        server_name = value.get("serverName") or host
        if not isinstance(host, str) or not _valid_host(host):
            raise ControlChannelError("control_assignment_host_invalid")
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ControlChannelError("control_assignment_port_invalid")
        if not isinstance(server_name, str) or not _valid_host(server_name):
            raise ControlChannelError("control_assignment_server_name_invalid")
        return cls(True, PROTOCOL_VERSION, host, port, server_name, fallback)


def _valid_host(value: str) -> bool:
    if not value or value != value.strip() or "/" in value or "://" in value:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return DNS_RE.fullmatch(value) is not None


@dataclass(frozen=True)
class ControlCommandResult:
    status: str
    detail_code: str | None = None

    def normalized(self) -> "ControlCommandResult":
        status = self.status.upper()
        if status not in TERMINAL_ACKS:
            raise ControlChannelError("control_command_result_status_invalid")
        if self.detail_code is not None and DETAIL_RE.fullmatch(self.detail_code) is None:
            raise ControlChannelError("control_command_result_detail_invalid")
        return ControlCommandResult(status, self.detail_code)


@dataclass(frozen=True)
class ControlCommand:
    command_id: str
    machine_id: str
    sequence: int
    kind: str
    issued_at_ms: int
    expires_at_ms: int
    lease: dict[str, str] | None
    payload: Any


def build_client_hello(
    key: SigningKey,
    machine_id: str,
    last_acked_command_sequence: int,
    *,
    issued_at_ms: int | None = None,
    nonce: str | None = None,
) -> dict[str, Any]:
    if ID_RE.fullmatch(machine_id) is None or last_acked_command_sequence < 0:
        raise ControlChannelError("control_client_hello_identity_invalid")
    issued = int(time.time() * 1000) if issued_at_ms is None else int(issued_at_ms)
    active_nonce = nonce or secrets.token_hex(24)
    if not 32 <= len(active_nonce) <= 128 or not all(c in "0123456789abcdefABCDEF" for c in active_nonce):
        raise ControlChannelError("control_nonce_invalid")
    canonical = (
        f"{AUTH_DOMAIN}\n{PROTOCOL_VERSION}\n{machine_id}\n1\n{issued}\n"
        f"{active_nonce}\n{last_acked_command_sequence}"
    ).encode()
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "machineId": machine_id,
        "keyVersion": 1,
        "issuedAtMs": issued,
        "nonce": active_nonce,
        "lastAckedCommandSequence": last_acked_command_sequence,
        "signatureHex": key.sign(canonical).signature.hex(),
    }


def encode_frame(message: dict[str, Any], max_bytes: int = MAX_FRAME_BYTES) -> bytes:
    raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    if not raw or len(raw) > max_bytes:
        raise ControlChannelError("control_frame_size_invalid")
    return struct.pack(">I", len(raw)) + raw


async def read_frame(reader: asyncio.StreamReader, max_bytes: int = MAX_FRAME_BYTES) -> dict[str, Any]:
    size = struct.unpack(">I", await reader.readexactly(4))[0]
    if size == 0 or size > max_bytes:
        raise ControlChannelError("control_frame_size_invalid")
    try:
        value = json.loads((await reader.readexactly(size)).decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ControlChannelError("control_frame_json_invalid") from exc
    if not isinstance(value, dict):
        raise ControlChannelError("control_frame_object_required")
    return value


async def write_frame(writer: asyncio.StreamWriter, message: dict[str, Any]) -> None:
    writer.write(encode_frame(message))
    await writer.drain()


def validate_server_hello(message: dict[str, Any]) -> dict[str, Any]:
    if set(message) != {"type", "hello"} or message.get("type") != "SERVER_HELLO":
        raise ControlChannelError("control_server_hello_invalid")
    hello = message.get("hello")
    expected = {
        "protocolVersion", "gatewayId", "region", "connectionId",
        "presenceTtlSeconds", "heartbeatTimeoutSeconds", "resumedAfterCommandSequence",
    }
    if not isinstance(hello, dict) or set(hello) != expected or hello.get("protocolVersion") != PROTOCOL_VERSION:
        raise ControlChannelError("control_server_hello_shape_invalid")
    for field in ("gatewayId", "connectionId"):
        if not isinstance(hello.get(field), str) or ID_RE.fullmatch(hello[field]) is None:
            raise ControlChannelError(f"control_server_{field}_invalid")
    if not isinstance(hello.get("region"), str) or re.fullmatch(r"[a-z0-9][a-z0-9-]{1,31}", hello["region"]) is None:
        raise ControlChannelError("control_server_region_invalid")
    ttl, timeout, resume = hello["presenceTtlSeconds"], hello["heartbeatTimeoutSeconds"], hello["resumedAfterCommandSequence"]
    if isinstance(ttl, bool) or not isinstance(ttl, int) or not 15 <= ttl <= 300:
        raise ControlChannelError("control_server_presence_ttl_invalid")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 10 <= timeout < ttl:
        raise ControlChannelError("control_server_heartbeat_timeout_invalid")
    if isinstance(resume, bool) or not isinstance(resume, int) or resume < 0:
        raise ControlChannelError("control_server_resume_sequence_invalid")
    return hello


def _valid_fence(token: Any) -> bool:
    return (
        isinstance(token, str) and token.isdigit() and not token.startswith("0")
        and len(token) <= 19 and 0 < int(token) <= 9_223_372_036_854_775_807
    )


def _validate_lease(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"resourceId", "holderId", "leaseId", "fencingToken"}:
        raise ControlChannelError("control_command_lease_shape_invalid")
    for field in ("resourceId", "holderId", "leaseId"):
        if not isinstance(value.get(field), str) or ID_RE.fullmatch(value[field]) is None:
            raise ControlChannelError(f"control_command_lease_{field}_invalid")
    if not _valid_fence(value.get("fencingToken")):
        raise ControlChannelError("control_command_fencing_token_invalid")
    return {key: value[key] for key in ("resourceId", "holderId", "leaseId", "fencingToken")}


def validate_command(message: dict[str, Any], machine_id: str, now_ms: int | None = None) -> ControlCommand:
    if set(message) != {"type", "command"} or message.get("type") != "COMMAND":
        raise ControlChannelError("control_command_message_invalid")
    raw = message.get("command")
    allowed = {"protocolVersion", "commandId", "machineId", "sequence", "kind", "issuedAtMs", "expiresAtMs", "lease", "payload"}
    required = allowed - {"lease"}
    if not isinstance(raw, dict) or set(raw) - allowed or not required.issubset(raw):
        raise ControlChannelError("control_command_shape_invalid")
    if raw.get("protocolVersion") != PROTOCOL_VERSION:
        raise ControlChannelError("control_command_protocol_unsupported")
    command_id, command_machine, kind = raw.get("commandId"), raw.get("machineId"), raw.get("kind")
    if not isinstance(command_id, str) or ID_RE.fullmatch(command_id) is None:
        raise ControlChannelError("control_command_id_invalid")
    if command_machine != machine_id:
        raise ControlChannelError("control_command_machine_mismatch")
    if kind not in KNOWN_KINDS:
        raise ControlChannelError("control_command_kind_invalid")
    sequence, issued, expires = raw.get("sequence"), raw.get("issuedAtMs"), raw.get("expiresAtMs")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0:
        raise ControlChannelError("control_command_sequence_invalid")
    if any(isinstance(v, bool) or not isinstance(v, int) for v in (issued, expires)):
        raise ControlChannelError("control_command_time_invalid")
    current = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if expires <= issued or expires - issued > MAX_COMMAND_LIFETIME_MS or issued > current + MAX_CLOCK_SKEW_MS or current >= expires:
        raise ControlChannelError("control_command_time_window_invalid")
    payload = raw.get("payload")
    if len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()) > MAX_COMMAND_PAYLOAD_BYTES:
        raise ControlChannelError("control_command_payload_too_large")
    lease = _validate_lease(raw["lease"]) if raw.get("lease") is not None else None
    if kind in LEASE_REQUIRED_KINDS and lease is None:
        raise ControlChannelError("control_command_lease_required")
    return ControlCommand(command_id, machine_id, sequence, kind, issued, expires, lease, payload)


def classify_command_action(command: ControlCommand) -> str:
    if command.kind in {"PREPARE_RENTAL", "START_RENTAL", "RUN_DIAGNOSTIC"}:
        return "WAKE_JOB"
    if command.kind == "REFRESH_INVENTORY":
        return "WAKE_HEARTBEAT"
    return "REJECT"


def reconnect_delay(attempt: int, random_value: float | None = None) -> float:
    ceiling = min(60.0, float(2 ** max(0, min(int(attempt), 8))))
    sample = random.random() if random_value is None else max(0.0, min(1.0, random_value))
    return max(0.25, ceiling * sample)


class _TerminalState:
    def __init__(self) -> None:
        raw = load_control_channel_state()
        value = raw.get("lastAckedCommandSequence")
        self.last_acked_sequence = value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
        self.results: list[dict[str, Any]] = []
        for item in raw.get("terminalResults", []) if isinstance(raw.get("terminalResults"), list) else []:
            if isinstance(item, dict) and item.get("status") in TERMINAL_ACKS:
                self.results.append(item)
        self.results = self.results[-RESULT_CACHE_SIZE:]

    def cached(self, command_id: str, sequence: int) -> ControlCommandResult | None:
        for item in reversed(self.results):
            if item.get("commandId") == command_id and item.get("sequence") == sequence:
                detail = item.get("detailCode") if isinstance(item.get("detailCode"), str) else None
                return ControlCommandResult(str(item["status"]), detail)
        return None

    def remember(self, command: ControlCommand, result: ControlCommandResult) -> None:
        result = result.normalized()
        if command.sequence < self.last_acked_sequence:
            raise ControlChannelError("control_terminal_sequence_regression")
        cached = self.cached(command.command_id, command.sequence)
        if cached is not None and cached != result:
            raise ControlChannelError("control_terminal_result_conflict")
        if cached is None:
            self.results.append({"commandId": command.command_id, "sequence": command.sequence, "status": result.status, "detailCode": result.detail_code})
            self.results = self.results[-RESULT_CACHE_SIZE:]
        self.last_acked_sequence = max(self.last_acked_sequence, command.sequence)
        save_control_channel_state({"schemaVersion": 1, "lastAckedCommandSequence": self.last_acked_sequence, "terminalResults": self.results})


class ControlChannelSupervisor:
    def __init__(
        self,
        *,
        machine_id: str,
        key: SigningKey,
        command_handler: Callable[[ControlCommand], ControlCommandResult],
        event_sink: Callable[[dict[str, Any]], None],
        ca_file: str | None = None,
    ) -> None:
        if ID_RE.fullmatch(machine_id) is None:
            raise ControlChannelError("control_machine_id_invalid")
        self.machine_id, self.key = machine_id, key
        self.command_handler, self.emit = command_handler, event_sink
        self.ca_file = str(Path(ca_file).expanduser()) if ca_file else None
        self._assignment = ControlChannelAssignment(False)
        self._lock = threading.Lock()
        self._connected, self._stop = threading.Event(), threading.Event()
        self._thread: threading.Thread | None = None
        self._state = _TerminalState()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._thread_main, name="gpubnb-control-channel", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._connected.clear()

    def update_assignment(self, value: Any) -> None:
        assignment = ControlChannelAssignment.parse(value)
        with self._lock:
            changed, self._assignment = assignment != self._assignment, assignment
        if changed:
            self.emit({"event": "control_channel_assignment", "enabled": assignment.enabled, "host": assignment.host if assignment.enabled else None, "port": assignment.port if assignment.enabled else None})

    def is_connected(self) -> bool:
        return self._connected.is_set()

    def fallback_poll_seconds(self) -> int:
        return self._snapshot().fallback_poll_seconds

    def _snapshot(self) -> ControlChannelAssignment:
        with self._lock:
            return self._assignment

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._supervise())
        except Exception as exc:  # final containment: legacy HTTPS stays available
            self._connected.clear()
            self.emit({"event": "control_channel_supervisor_failed", "message": str(exc)[:300]})

    async def _supervise(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            assignment = self._snapshot()
            if not assignment.enabled:
                self._connected.clear()
                attempt = 0
                await asyncio.sleep(0.5)
                continue
            try:
                await self._run_session(assignment)
                attempt = 0
            except ControlChannelFenced as exc:
                self._connected.clear()
                self.emit({"event": "control_channel_fenced", "message": str(exc)[:200]})
                await asyncio.sleep(1)
            except Exception as exc:
                self._connected.clear()
                self.emit({"event": "control_channel_disconnected", "type": type(exc).__name__, "message": str(exc)[:300]})
                delay = reconnect_delay(attempt)
                attempt = min(attempt + 1, 8)
                await asyncio.sleep(delay)

    async def _run_session(self, assignment: ControlChannelAssignment) -> None:
        assert assignment.host is not None
        configuration = QuicConfiguration(is_client=True, alpn_protocols=[ALPN], server_name=assignment.server_name or assignment.host, idle_timeout=90.0)
        if self.ca_file:
            configuration.load_verify_locations(cafile=self.ca_file)
        async with connect(assignment.host, assignment.port, configuration=configuration, wait_connected=True) as protocol:
            reader, writer = await protocol.create_stream()
            await write_frame(writer, build_client_hello(self.key, self.machine_id, self._state.last_acked_sequence))
            hello = validate_server_hello(await asyncio.wait_for(read_frame(reader), 10))
            if hello["resumedAfterCommandSequence"] != self._state.last_acked_sequence:
                raise ControlChannelError("control_server_resume_sequence_mismatch")
            self._connected.set()
            self.emit({"event": "control_channel_connected", "gatewayId": hello["gatewayId"], "region": hello["region"], "connectionId": hello["connectionId"], "resumedAfter": hello["resumedAfterCommandSequence"]})
            interval = max(5.0, min(15.0, hello["heartbeatTimeoutSeconds"] / 3.0))
            heartbeat_sequence, loop = 0, asyncio.get_running_loop()
            next_heartbeat = loop.time() + interval
            read_task = asyncio.create_task(read_frame(reader))
            try:
                while not self._stop.is_set() and self._snapshot() == assignment:
                    done, _ = await asyncio.wait({read_task}, timeout=max(0.0, next_heartbeat - loop.time()))
                    if read_task in done:
                        await self._handle_message(writer, read_task.result())
                        read_task = asyncio.create_task(read_frame(reader))
                    if loop.time() >= next_heartbeat:
                        heartbeat_sequence += 1
                        await write_frame(writer, {"type": "HEARTBEAT", "sequence": heartbeat_sequence, "observed_at_ms": int(time.time() * 1000)})
                        next_heartbeat = loop.time() + interval
            finally:
                read_task.cancel()
                self._connected.clear()
                writer.close()

    async def _handle_message(self, writer: asyncio.StreamWriter, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        if message_type == "COMMAND":
            command = validate_command(message, self.machine_id)
            cached = self._state.cached(command.command_id, command.sequence)
            if command.sequence <= self._state.last_acked_sequence:
                if cached is None:
                    raise ControlChannelError("control_command_replay_without_terminal_state")
                await self._send_ack(writer, command, cached)
                return
            await self._send_ack(writer, command, ControlCommandResult("ACCEPTED"))
            try:
                result = (await asyncio.to_thread(self.command_handler, command)).normalized()
            except Exception as exc:
                result = ControlCommandResult("FAILED", _safe_detail(type(exc).__name__))
            # Persist terminal state before network ACK: a crash after the side effect
            # replays the terminal result instead of executing the command twice.
            self._state.remember(command, result)
            await self._send_ack(writer, command, result)
            return
        if message_type == "ACK_RECEIPT":
            if set(message) != {"type", "command_id", "sequence"}:
                raise ControlChannelError("control_ack_receipt_invalid")
            return
        if message_type == "FENCE":
            allowed = {"REPLACED_CONNECTION", "PRESENCE_OWNERSHIP_LOST", "GATEWAY_DRAINING", "PROTOCOL_VIOLATION"}
            if set(message) != {"type", "reason"} or message.get("reason") not in allowed:
                raise ControlChannelError("control_fence_invalid")
            raise ControlChannelFenced(str(message["reason"]))
        raise ControlChannelError("control_gateway_message_unknown")

    async def _send_ack(self, writer: asyncio.StreamWriter, command: ControlCommand, result: ControlCommandResult) -> None:
        message: dict[str, Any] = {"type": "COMMAND_ACK", "command_id": command.command_id, "sequence": command.sequence, "status": result.status}
        if result.detail_code:
            message["detail_code"] = result.detail_code
        await write_frame(writer, message)


def _safe_detail(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value)[:96].strip("_")
    return value or "command_failed"
