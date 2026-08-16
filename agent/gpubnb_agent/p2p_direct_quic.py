"""Authenticated direct QUIC sessions over a Candidate Discovery UDP socket.

TLS certificate verification is supplied by the caller's QuicConfiguration.
The rendezvous ephemeral Ed25519 keys additionally authenticate a bounded
application handshake before any workload stream may be exposed.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import socket
import struct
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import base58
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.asyncio.server import QuicServer
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.connection import QuicConnection
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from .p2p_connectivity import Candidate, P2PError, VerifiedRendezvousTicket, _parse_endpoint

DIRECT_PROTOCOL_VERSION = 1
DIRECT_AUTH_DOMAIN = "gpubnb-p2p-direct-auth-v1"
DIRECT_ALPN = "gpubnb-p2p-direct/1"
MAX_AUTH_FRAME_BYTES = 4_096
MAX_DIRECT_ATTEMPTS = 8
MAX_PUNCH_PACKETS = 3
MAX_ATTEMPT_TIMEOUT_MS = 5_000
MAX_TOTAL_TIMEOUT_MS = 15_000
PUNCH_PACKET = b"GPUBNB-P2P-PUNCH-V1"


class DirectResultCode(str, Enum):
    DIRECT_HOST = "DIRECT_HOST"
    DIRECT_SERVER_REFLEXIVE = "DIRECT_SERVER_REFLEXIVE"
    DIRECT_FAILED = "DIRECT_FAILED"
    AUTH_FAILED = "AUTH_FAILED"
    TIMEOUT = "TIMEOUT"
    REVOKED = "REVOKED"


@dataclass(frozen=True)
class DirectMetrics:
    candidate_kind: str | None
    success: bool
    latency_ms: int
    attempts: int
    fallback_required: bool
    failure_code: str | None
    reconnect: bool = False

    def as_telemetry(self) -> dict[str, Any]:
        return {
            "candidateKind": self.candidate_kind,
            "success": self.success,
            "latencyMs": max(0, self.latency_ms),
            "attempts": self.attempts,
            "fallbackRequired": self.fallback_required,
            "failureCode": self.failure_code,
            "reconnect": self.reconnect,
        }


@dataclass
class ReplayCache:
    """Bounded in-memory replay cache; entries never outlive their ticket."""

    max_entries: int = 1_024
    _entries: dict[str, int] = field(default_factory=dict)

    def consume(self, key: str, expires_at_ms: int, now_ms: int) -> bool:
        self._entries = {item: expiry for item, expiry in self._entries.items() if expiry > now_ms}
        if key in self._entries:
            return False
        if len(self._entries) >= self.max_entries:
            oldest = min(self._entries, key=self._entries.__getitem__)
            del self._entries[oldest]
        self._entries[key] = expires_at_ms
        return True


AuthorityCheck = Callable[[str, str], bool | Awaitable[bool]]


def _ticket_value(ticket: VerifiedRendezvousTicket, name: str) -> str:
    value = ticket.claims[name]
    if not isinstance(value, str):
        raise P2PError("p2p_direct_ticket_invalid")
    return value


def _assert_live(ticket: VerifiedRendezvousTicket, now_ms: int, authority_check: AuthorityCheck | None = None) -> None:
    expires = ticket.claims.get("expiresAtMs")
    if not isinstance(expires, int) or now_ms >= expires:
        raise P2PError("p2p_direct_ticket_expired")
    if authority_check is not None:
        verdict = authority_check(_ticket_value(ticket, "leaseId"), _ticket_value(ticket, "fencingToken"))
        if asyncio.iscoroutine(verdict):
            raise P2PError("p2p_direct_authority_async_invalid")
        if verdict is not True:
            raise P2PError("p2p_direct_revoked")


async def _assert_live_async(ticket: VerifiedRendezvousTicket, authority_check: AuthorityCheck | None) -> None:
    now_ms = int(time.time() * 1_000)
    expires = ticket.claims.get("expiresAtMs")
    if not isinstance(expires, int) or now_ms >= expires:
        raise P2PError("p2p_direct_ticket_expired")
    if authority_check is not None:
        verdict = authority_check(_ticket_value(ticket, "leaseId"), _ticket_value(ticket, "fencingToken"))
        if asyncio.iscoroutine(verdict):
            verdict = await verdict
        if verdict is not True:
            raise P2PError("p2p_direct_revoked")


def _canonical(ticket: VerifiedRendezvousTicket, stage: str, initiator: str, responder: str, *challenges: str) -> bytes:
    values = [
        DIRECT_AUTH_DOMAIN,
        str(DIRECT_PROTOCOL_VERSION),
        stage,
        _ticket_value(ticket, "sessionId"),
        _ticket_value(ticket, "machineId"),
        _ticket_value(ticket, "leaseId"),
        _ticket_value(ticket, "fencingToken"),
        _ticket_value(ticket, "nonce"),
        initiator,
        responder,
        *challenges,
    ]
    return ("\n".join(values) + "\n").encode()


def _sign(key: SigningKey, payload: bytes) -> str:
    return key.sign(payload).signature.hex()


def _verify(key: VerifyKey, payload: bytes, signature: Any) -> None:
    if not isinstance(signature, str) or len(signature) != 128:
        raise P2PError("p2p_direct_auth_failed")
    try:
        key.verify(payload, bytes.fromhex(signature))
    except (BadSignatureError, ValueError, TypeError) as exc:
        raise P2PError("p2p_direct_auth_failed") from exc


def _ephemeral_verify_key(ticket: VerifiedRendezvousTicket, role: str) -> VerifyKey:
    field_name = "hostEphemeralKeyBase58" if role == "HOST" else "renterEphemeralKeyBase58"
    try:
        return VerifyKey(base58.b58decode(_ticket_value(ticket, field_name)))
    except (ValueError, TypeError) as exc:
        raise P2PError("p2p_direct_ticket_invalid") from exc


def _validate_local_key(ticket: VerifiedRendezvousTicket, role: str, key: SigningKey) -> None:
    if bytes(key.verify_key) != bytes(_ephemeral_verify_key(ticket, role)):
        raise P2PError("p2p_direct_local_key_mismatch")


async def _write_frame(writer: asyncio.StreamWriter, value: Mapping[str, Any]) -> None:
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    if not raw or len(raw) > MAX_AUTH_FRAME_BYTES:
        raise P2PError("p2p_direct_frame_size_invalid")
    writer.write(struct.pack("!I", len(raw)) + raw)
    await writer.drain()


async def _read_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    size = struct.unpack("!I", await reader.readexactly(4))[0]
    if not 1 <= size <= MAX_AUTH_FRAME_BYTES:
        raise P2PError("p2p_direct_frame_size_invalid")
    try:
        value = json.loads((await reader.readexactly(size)).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise P2PError("p2p_direct_frame_invalid") from exc
    if not isinstance(value, dict):
        raise P2PError("p2p_direct_frame_invalid")
    return value


def _challenge(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise P2PError("p2p_direct_auth_failed")
    try:
        bytes.fromhex(value)
    except ValueError as exc:
        raise P2PError("p2p_direct_auth_failed") from exc
    return value


async def renter_handshake(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    ticket: VerifiedRendezvousTicket,
    renter_key: SigningKey,
    authority_check: AuthorityCheck | None = None,
) -> None:
    """Authenticate both peers; return only after the Host's READY proof."""
    _validate_local_key(ticket, "RENTER", renter_key)
    await _assert_live_async(ticket, authority_check)
    client_challenge = secrets.token_hex(32)
    hello = _canonical(ticket, "HELLO", "RENTER", "HOST", client_challenge)
    await _write_frame(writer, {
        "type": "HELLO", "version": DIRECT_PROTOCOL_VERSION, "role": "RENTER",
        "challenge": client_challenge, "signature": _sign(renter_key, hello),
    })
    response = await _read_frame(reader)
    if set(response) != {"type", "version", "role", "challenge", "signature"} or response.get("type") != "CHALLENGE" or response.get("version") != DIRECT_PROTOCOL_VERSION or response.get("role") != "HOST":
        raise P2PError("p2p_direct_auth_failed")
    host_challenge = _challenge(response["challenge"])
    _verify(_ephemeral_verify_key(ticket, "HOST"), _canonical(ticket, "CHALLENGE", "RENTER", "HOST", client_challenge, host_challenge), response["signature"])
    await _assert_live_async(ticket, authority_check)
    finish = _canonical(ticket, "FINISH", "RENTER", "HOST", client_challenge, host_challenge)
    await _write_frame(writer, {"type": "FINISH", "version": DIRECT_PROTOCOL_VERSION, "role": "RENTER", "signature": _sign(renter_key, finish)})
    ready = await _read_frame(reader)
    if set(ready) != {"type", "version", "role", "signature"} or ready.get("type") != "READY" or ready.get("version") != DIRECT_PROTOCOL_VERSION or ready.get("role") != "HOST":
        raise P2PError("p2p_direct_auth_failed")
    _verify(_ephemeral_verify_key(ticket, "HOST"), _canonical(ticket, "READY", "RENTER", "HOST", client_challenge, host_challenge), ready["signature"])
    await _assert_live_async(ticket, authority_check)


async def host_handshake(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    ticket: VerifiedRendezvousTicket,
    host_key: SigningKey,
    replay_cache: ReplayCache,
    authority_check: AuthorityCheck | None = None,
) -> None:
    _validate_local_key(ticket, "HOST", host_key)
    await _assert_live_async(ticket, authority_check)
    hello = await _read_frame(reader)
    if set(hello) != {"type", "version", "role", "challenge", "signature"} or hello.get("type") != "HELLO" or hello.get("version") != DIRECT_PROTOCOL_VERSION or hello.get("role") != "RENTER":
        raise P2PError("p2p_direct_auth_failed")
    client_challenge = _challenge(hello["challenge"])
    _verify(_ephemeral_verify_key(ticket, "RENTER"), _canonical(ticket, "HELLO", "RENTER", "HOST", client_challenge), hello["signature"])
    now_ms = int(time.time() * 1_000)
    replay_key = f"{_ticket_value(ticket, 'nonce')}:{client_challenge}"
    if not replay_cache.consume(replay_key, int(ticket.claims["expiresAtMs"]), now_ms):
        raise P2PError("p2p_direct_replay")
    host_challenge = secrets.token_hex(32)
    response = _canonical(ticket, "CHALLENGE", "RENTER", "HOST", client_challenge, host_challenge)
    await _write_frame(writer, {"type": "CHALLENGE", "version": DIRECT_PROTOCOL_VERSION, "role": "HOST", "challenge": host_challenge, "signature": _sign(host_key, response)})
    finish = await _read_frame(reader)
    if set(finish) != {"type", "version", "role", "signature"} or finish.get("type") != "FINISH" or finish.get("version") != DIRECT_PROTOCOL_VERSION or finish.get("role") != "RENTER":
        raise P2PError("p2p_direct_auth_failed")
    _verify(_ephemeral_verify_key(ticket, "RENTER"), _canonical(ticket, "FINISH", "RENTER", "HOST", client_challenge, host_challenge), finish["signature"])
    await _assert_live_async(ticket, authority_check)
    await _write_frame(writer, {"type": "READY", "version": DIRECT_PROTOCOL_VERSION, "role": "HOST", "signature": _sign(host_key, _canonical(ticket, "READY", "RENTER", "HOST", client_challenge, host_challenge))})


@dataclass
class DirectQuicSession:
    protocol: QuicConnectionProtocol
    transport: asyncio.DatagramTransport
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    candidate_kind: str
    authenticated: bool = True

    async def close(self) -> None:
        self.authenticated = False
        self.writer.close()
        self.protocol.close()
        try:
            await asyncio.wait_for(self.protocol.wait_closed(), 1.0)
        except asyncio.TimeoutError:
            pass
        self.transport.close()


class _ReservedClientHub(asyncio.DatagramProtocol):
    """Own one UDP transport while individual QUIC attempts come and go."""

    def __init__(self) -> None:
        self.transport: asyncio.DatagramTransport | None = None
        self.active: QuicConnectionProtocol | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, addr: tuple[Any, ...]) -> None:
        if data == PUNCH_PACKET:
            return
        if self.active is not None:
            self.active.datagram_received(data, addr)


class ReservedSocketQuicClient:
    """Run bounded sequential QUIC attempts without ever rebinding UDP."""

    def __init__(
        self,
        hub: _ReservedClientHub,
        transport: asyncio.DatagramTransport,
        configuration: QuicConfiguration,
        ticket: VerifiedRendezvousTicket,
        renter_key: SigningKey,
        authority_check: AuthorityCheck | None,
        family: int,
    ) -> None:
        self._hub = hub
        self._transport = transport
        self._configuration = configuration
        self._ticket = ticket
        self._renter_key = renter_key
        self._authority_check = authority_check
        self._family = family
        self._closed = False

    @classmethod
    async def open(
        cls,
        reserved_socket: socket.socket,
        configuration: QuicConfiguration,
        ticket: VerifiedRendezvousTicket,
        renter_key: SigningKey,
        authority_check: AuthorityCheck | None = None,
    ) -> "ReservedSocketQuicClient":
        if configuration.verify_mode is None or configuration.verify_mode == 0:
            raise P2PError("p2p_direct_tls_verification_required")
        if DIRECT_ALPN not in configuration.alpn_protocols:
            raise P2PError("p2p_direct_alpn_invalid")
        _validate_local_key(ticket, "RENTER", renter_key)
        await _assert_live_async(ticket, authority_check)
        family = reserved_socket.family
        reserved_socket.setblocking(False)
        loop = asyncio.get_running_loop()
        hub = _ReservedClientHub()
        transport, _protocol = await loop.create_datagram_endpoint(lambda: hub, sock=reserved_socket)
        return cls(hub, transport, configuration, ticket, renter_key, authority_check, family)  # type: ignore[arg-type]

    async def attempt(self, _socket: socket.socket, candidate: Candidate) -> DirectQuicSession:
        if self._closed:
            raise P2PError("p2p_direct_transport_closed")
        peer_candidates = self._ticket.candidates_for_peer("RENTER")
        if candidate not in peer_candidates or candidate.kind not in {"HOST", "SERVER_REFLEXIVE"}:
            raise P2PError("p2p_direct_endpoint_not_authorized")
        await _assert_live_async(self._ticket, self._authority_check)
        destination = _socket_address(candidate, self._family)
        for _ in range(MAX_PUNCH_PACKETS):
            self._transport.sendto(PUNCH_PACKET, destination)
        quic = QuicConnection(configuration=self._configuration)
        protocol = QuicConnectionProtocol(quic)
        protocol.connection_made(self._transport)
        self._hub.active = protocol
        try:
            protocol.connect(destination)
            await protocol.wait_connected()
            reader, writer = await protocol.create_stream()
            await renter_handshake(reader, writer, self._ticket, self._renter_key, self._authority_check)
            return DirectQuicSession(protocol, self._transport, reader, writer, candidate.kind)
        except BaseException:
            if self._hub.active is protocol:
                self._hub.active = None
            waiter = protocol._connected_waiter
            if waiter is not None:
                protocol._connected_waiter = None
                waiter.cancel()
            protocol.close()
            raise

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._hub.active = None
            self._transport.close()


def _socket_address(candidate: Candidate, family: int) -> tuple[Any, ...]:
    address, port = _parse_endpoint(candidate.endpoint)
    if family == socket.AF_INET6:
        host = f"::ffff:{address}" if address.version == 4 else str(address)
        return (host, port, 0, 0)
    if address.version != 4:
        raise P2PError("p2p_direct_endpoint_family_invalid")
    return (str(address), port)


async def punch_signed_candidates(
    reserved_socket: socket.socket,
    ticket: VerifiedRendezvousTicket,
    local_role: str,
) -> int:
    """Send a bounded simultaneous-open hint only to signed direct endpoints."""
    reserved_socket.setblocking(False)
    loop = asyncio.get_running_loop()
    sent = 0
    for candidate in ticket.candidates_for_peer(local_role):
        if candidate.kind not in {"HOST", "SERVER_REFLEXIVE"}:
            continue
        destination = _socket_address(candidate, reserved_socket.family)
        for _ in range(MAX_PUNCH_PACKETS):
            await loop.sock_sendto(reserved_socket, PUNCH_PACKET, destination)
            sent += 1
        if sent >= MAX_DIRECT_ATTEMPTS * MAX_PUNCH_PACKETS:
            break
    return sent


async def connect_reserved_socket(
    reserved_socket: socket.socket,
    candidate: Candidate,
    configuration: QuicConfiguration,
    ticket: VerifiedRendezvousTicket,
    renter_key: SigningKey,
    authority_check: AuthorityCheck | None = None,
) -> DirectQuicSession:
    """Transfer the exact discovery socket into aioquic without rebinding it."""
    client = await ReservedSocketQuicClient.open(
        reserved_socket, configuration, ticket, renter_key, authority_check
    )
    try:
        return await client.attempt(reserved_socket, candidate)
    except BaseException:
        client.close()
        raise


Connector = Callable[[socket.socket, Candidate], Awaitable[DirectQuicSession]]
Fallback = Callable[[], bool | Awaitable[bool]]


@dataclass(frozen=True)
class DirectConnectOutcome:
    code: DirectResultCode
    session: DirectQuicSession | None
    metrics: DirectMetrics


async def connect_direct_first(
    reserved_socket: socket.socket,
    ticket: VerifiedRendezvousTicket,
    connector: Connector,
    *,
    attempt_timeout_ms: int = 3_000,
    total_timeout_ms: int = 10_000,
    fallback: Fallback | None = None,
    authority_check: AuthorityCheck | None = None,
    reconnect: bool = False,
) -> DirectConnectOutcome:
    if not 1 <= attempt_timeout_ms <= MAX_ATTEMPT_TIMEOUT_MS or not attempt_timeout_ms <= total_timeout_ms <= MAX_TOTAL_TIMEOUT_MS:
        raise P2PError("p2p_direct_timeout_invalid")
    started = time.monotonic()
    attempts = 0
    last_code = DirectResultCode.DIRECT_FAILED
    direct = [item for item in ticket.candidates_for_peer("RENTER") if item.kind in {"HOST", "SERVER_REFLEXIVE"}]
    direct.sort(key=lambda item: ({"HOST": 0, "SERVER_REFLEXIVE": 1}[item.kind], -item.priority, item.endpoint))
    for candidate in direct[:MAX_DIRECT_ATTEMPTS]:
        remaining = total_timeout_ms / 1_000 - (time.monotonic() - started)
        if remaining <= 0:
            last_code = DirectResultCode.TIMEOUT
            break
        attempts += 1
        try:
            await _assert_live_async(ticket, authority_check)
            session = await asyncio.wait_for(connector(reserved_socket, candidate), min(attempt_timeout_ms / 1_000, remaining))
            code = DirectResultCode.DIRECT_HOST if candidate.kind == "HOST" else DirectResultCode.DIRECT_SERVER_REFLEXIVE
            return DirectConnectOutcome(code, session, DirectMetrics(candidate.kind, True, int((time.monotonic() - started) * 1_000), attempts, False, None, reconnect))
        except asyncio.TimeoutError:
            last_code = DirectResultCode.TIMEOUT
        except P2PError as exc:
            if exc.code in {"p2p_direct_revoked", "p2p_direct_ticket_expired"}:
                code = DirectResultCode.REVOKED
                return DirectConnectOutcome(code, None, DirectMetrics(None, False, int((time.monotonic() - started) * 1_000), attempts, False, code.value, reconnect))
            if "auth" in exc.code or "key" in exc.code:
                last_code = DirectResultCode.AUTH_FAILED
            else:
                last_code = DirectResultCode.DIRECT_FAILED
        except (ConnectionError, OSError):
            last_code = DirectResultCode.DIRECT_FAILED
    allow_fallback = ticket.claims.get("relayPolicy") != "DIRECT_ONLY"
    fallback_required = allow_fallback and fallback is not None
    if fallback_required:
        result = fallback()
        if asyncio.iscoroutine(result):
            await result
    return DirectConnectOutcome(last_code, None, DirectMetrics(None, False, int((time.monotonic() - started) * 1_000), attempts, fallback_required, last_code.value, reconnect))


async def connect_direct_quic_first(
    reserved_socket: socket.socket,
    ticket: VerifiedRendezvousTicket,
    configuration: QuicConfiguration,
    renter_key: SigningKey,
    **options: Any,
) -> DirectConnectOutcome:
    """Production direct-first entry point retaining one socket across attempts."""
    authority_check = options.get("authority_check")
    client = await ReservedSocketQuicClient.open(
        reserved_socket, configuration, ticket, renter_key, authority_check
    )
    try:
        outcome = await connect_direct_first(
            reserved_socket, ticket, client.attempt, **options
        )
        if outcome.session is None:
            client.close()
        return outcome
    except BaseException:
        client.close()
        raise


async def listen_reserved_socket(
    reserved_socket: socket.socket,
    configuration: QuicConfiguration,
    stream_handler: Callable[[asyncio.StreamReader, asyncio.StreamWriter], None],
) -> tuple[asyncio.DatagramTransport, QuicServer]:
    """Run the Host QUIC listener on the discovery socket without rebinding."""
    if configuration.verify_mode is None or configuration.verify_mode == 0:
        raise P2PError("p2p_direct_tls_verification_required")
    if DIRECT_ALPN not in configuration.alpn_protocols:
        raise P2PError("p2p_direct_alpn_invalid")
    reserved_socket.setblocking(False)
    loop = asyncio.get_running_loop()
    transport, server = await loop.create_datagram_endpoint(
        lambda: QuicServer(configuration=configuration, stream_handler=stream_handler),
        sock=reserved_socket,
    )
    return transport, server  # type: ignore[return-value]
