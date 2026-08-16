"""Bounded P2P candidate discovery and rendezvous-ticket verification.

The reserved UDP socket and a typed, verified rendezvous value are returned to
the direct-session layer.  Keeping these capabilities typed prevents callers
from accidentally feeding unverified ticket dictionaries to the network path.
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
import struct
import time
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping, Sequence

import base58
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

P2P_RENDEZVOUS_VERSION = 1
P2P_TICKET_DOMAIN = "gpubnb-p2p-rendezvous-v1"
MAX_TICKET_LIFETIME_MS = 120_000
MAX_CLOCK_SKEW_MS = 30_000
MAX_CANDIDATES_PER_PEER = 12
MAX_STUN_SERVERS = 4
MAX_STUN_PACKET_BYTES = 1_200
MAX_STUN_TIMEOUT_MS = 3_000
MAX_STUN_TOTAL_TIMEOUT_MS = 8_000

STUN_BINDING_REQUEST = 0x0001
STUN_BINDING_SUCCESS = 0x0101
STUN_MAGIC_COOKIE = 0x2112A442
STUN_XOR_MAPPED_ADDRESS = 0x0020

_ID = re.compile(r"^[A-Za-z0-9_.:-]{8,160}$")
_HEX_NONCE = re.compile(r"^[0-9A-Fa-f]{32,128}$")
_HEX_SIGNATURE = re.compile(r"^[0-9A-Fa-f]{128}$")
_KINDS = ("HOST", "SERVER_REFLEXIVE", "RELAY")
_POLICIES = ("DIRECT_ONLY", "FALLBACK_ONLY")


class P2PError(RuntimeError):
    """Fail-closed error carrying a stable, non-sensitive telemetry code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class Candidate:
    kind: str
    endpoint: str
    priority: int

    def as_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "endpoint": self.endpoint, "priority": self.priority}


@dataclass
class CandidateDiscovery:
    socket: socket.socket
    candidates: tuple[Candidate, ...]

    def close(self) -> None:
        self.socket.close()

    def __enter__(self) -> "CandidateDiscovery":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


@dataclass(frozen=True)
class VerifiedRendezvousTicket:
    """Authority-checked ticket details safe for direct-session consumption."""

    claims: Mapping[str, Any]
    host_candidates: tuple[Candidate, ...]
    renter_candidates: tuple[Candidate, ...]

    def candidates_for_peer(self, local_role: str) -> tuple[Candidate, ...]:
        if local_role == "HOST":
            return self.renter_candidates
        if local_role == "RENTER":
            return self.host_candidates
        raise P2PError("p2p_role_invalid")


def _endpoint(address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int) -> str:
    return f"[{address.compressed}]:{port}" if address.version == 6 else f"{address.compressed}:{port}"


def _usable_local_address(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None
    if address.is_loopback or address.is_unspecified or address.is_multicast or address.is_link_local:
        return None
    return address


def local_addresses() -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
    """Return bounded, usable addresses exposed by the standard socket API."""
    values: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, type=socket.SOCK_DGRAM)
    except OSError as exc:
        raise P2PError("p2p_local_discovery_failed") from exc
    for family, _kind, _proto, _canonname, sockaddr in infos[:64]:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        address = _usable_local_address(str(sockaddr[0]))
        if address is not None:
            values.add(address)
    return tuple(sorted(values, key=lambda item: (item.version, item.packed)))


def build_stun_binding_request(transaction_id: bytes) -> bytes:
    if len(transaction_id) != 12:
        raise P2PError("p2p_stun_transaction_invalid")
    return struct.pack("!HHI12s", STUN_BINDING_REQUEST, 0, STUN_MAGIC_COOKIE, transaction_id)


def parse_stun_binding_response(packet: bytes, transaction_id: bytes) -> tuple[str, int]:
    """Parse the RFC 8489 header and XOR-MAPPED-ADDRESS with strict bounds."""
    if len(transaction_id) != 12 or len(packet) < 20 or len(packet) > MAX_STUN_PACKET_BYTES:
        raise P2PError("p2p_stun_response_invalid")
    message_type, body_length, cookie = struct.unpack_from("!HHI", packet)
    if message_type & 0xC000 or message_type != STUN_BINDING_SUCCESS:
        raise P2PError("p2p_stun_response_type_invalid")
    if cookie != STUN_MAGIC_COOKIE:
        raise P2PError("p2p_stun_cookie_invalid")
    if packet[8:20] != transaction_id:
        raise P2PError("p2p_stun_transaction_mismatch")
    if body_length % 4 or body_length != len(packet) - 20:
        raise P2PError("p2p_stun_length_invalid")

    offset = 20
    mapped: tuple[str, int] | None = None
    while offset < len(packet):
        if len(packet) - offset < 4:
            raise P2PError("p2p_stun_attribute_bounds")
        attribute_type, attribute_length = struct.unpack_from("!HH", packet, offset)
        value_start = offset + 4
        value_end = value_start + attribute_length
        padded_end = value_start + ((attribute_length + 3) & ~3)
        if value_end > len(packet) or padded_end > len(packet):
            raise P2PError("p2p_stun_attribute_bounds")
        if attribute_type == STUN_XOR_MAPPED_ADDRESS:
            if mapped is not None or attribute_length not in (8, 20):
                raise P2PError("p2p_stun_xor_mapped_invalid")
            reserved, family, encoded_port = struct.unpack_from("!BBH", packet, value_start)
            if reserved != 0:
                raise P2PError("p2p_stun_xor_mapped_invalid")
            port = encoded_port ^ (STUN_MAGIC_COOKIE >> 16)
            if port == 0:
                raise P2PError("p2p_stun_xor_mapped_invalid")
            if family == 0x01 and attribute_length == 8:
                mask = struct.pack("!I", STUN_MAGIC_COOKIE)
                raw = bytes(a ^ b for a, b in zip(packet[value_start + 4:value_end], mask))
            elif family == 0x02 and attribute_length == 20:
                mask = struct.pack("!I", STUN_MAGIC_COOKIE) + transaction_id
                raw = bytes(a ^ b for a, b in zip(packet[value_start + 4:value_end], mask))
            else:
                raise P2PError("p2p_stun_address_family_invalid")
            try:
                mapped = (str(ipaddress.ip_address(raw)), port)
            except ValueError as exc:
                raise P2PError("p2p_stun_xor_mapped_invalid") from exc
        offset = padded_end
    if mapped is None:
        raise P2PError("p2p_stun_xor_mapped_missing")
    return mapped


def _parse_stun_servers(config: Mapping[str, Any]) -> list[tuple[str, int]]:
    raw = config.get("stunServers", [])
    if not isinstance(raw, list) or len(raw) > MAX_STUN_SERVERS:
        raise P2PError("p2p_stun_config_invalid")
    servers: list[tuple[str, int]] = []
    for item in raw:
        if not isinstance(item, Mapping) or set(item) != {"host", "port"}:
            raise P2PError("p2p_stun_config_invalid")
        host, port = item.get("host"), item.get("port")
        if not isinstance(host, str) or not (1 <= len(host) <= 253):
            raise P2PError("p2p_stun_config_invalid")
        if not isinstance(port, int) or isinstance(port, bool) or not (1 <= port <= 65535):
            raise P2PError("p2p_stun_config_invalid")
        servers.append((host, port))
    return servers


def discover_candidates(
    config: Mapping[str, Any],
    *,
    address_provider: Callable[[], Iterable[ipaddress.IPv4Address | ipaddress.IPv6Address]] = local_addresses,
    socket_factory: Callable[..., socket.socket] = socket.socket,
    resolver: Callable[..., Sequence[tuple[Any, ...]]] = socket.getaddrinfo,
    random_bytes: Callable[[int], bytes] = os.urandom,
    monotonic: Callable[[], float] = time.monotonic,
) -> CandidateDiscovery:
    """Reserve one UDP port, then discover HOST and server-reflexive candidates."""
    servers = _parse_stun_servers(config)
    timeout_ms = config.get("stunTimeoutMs", 1_000)
    total_timeout_ms = config.get("stunTotalTimeoutMs", 4_000)
    bind_port = config.get("bindPort", 0)
    if (
        not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool)
        or not 1 <= timeout_ms <= MAX_STUN_TIMEOUT_MS
        or not isinstance(total_timeout_ms, int) or isinstance(total_timeout_ms, bool)
        or not timeout_ms <= total_timeout_ms <= MAX_STUN_TOTAL_TIMEOUT_MS
        or not isinstance(bind_port, int) or isinstance(bind_port, bool)
        or not 0 <= bind_port <= 65535
    ):
        raise P2PError("p2p_stun_config_invalid")

    dual_stack = False
    try:
        reserved = socket_factory(socket.AF_INET6, socket.SOCK_DGRAM)
        reserved.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        reserved.bind(("::", bind_port))
        dual_stack = True
    except OSError:
        try:
            reserved.close()
        except (OSError, UnboundLocalError):
            pass
        try:
            reserved = socket_factory(socket.AF_INET, socket.SOCK_DGRAM)
            reserved.bind(("0.0.0.0", bind_port))
        except OSError as exc:
            try:
                reserved.close()
            except (OSError, UnboundLocalError):
                pass
            raise P2PError("p2p_socket_reservation_failed") from exc
    try:
        port = int(reserved.getsockname()[1])
        candidates: list[Candidate] = []
        seen: set[tuple[str, str]] = set()
        for address in address_provider():
            if (address.version == 6 and not dual_stack) or _usable_local_address(str(address)) is None:
                continue
            candidate = Candidate("HOST", _endpoint(address, port), 100)
            if (candidate.kind, candidate.endpoint) not in seen:
                candidates.append(candidate)
                seen.add((candidate.kind, candidate.endpoint))
            if len(candidates) == MAX_CANDIDATES_PER_PEER:
                break

        deadline = monotonic() + total_timeout_ms / 1_000
        for host, stun_port in servers:
            if len(candidates) == MAX_CANDIDATES_PER_PEER or monotonic() >= deadline:
                break
            try:
                infos = resolver(host, stun_port, socket.AF_UNSPEC, socket.SOCK_DGRAM)
                if not infos:
                    raise OSError
                family, target = infos[0][0], infos[0][4]
                if family == socket.AF_INET and dual_stack:
                    target = (f"::ffff:{target[0]}", target[1], 0, 0)
                elif family == socket.AF_INET6 and not dual_stack:
                    continue
                transaction_id = random_bytes(12)
                request = build_stun_binding_request(transaction_id)
                reserved.settimeout(min(timeout_ms / 1_000, max(0.001, deadline - monotonic())))
                reserved.sendto(request, target)
                packet, source = reserved.recvfrom(MAX_STUN_PACKET_BYTES + 1)
                source_address = ipaddress.ip_address(source[0]).ipv4_mapped or ipaddress.ip_address(source[0])
                target_address = ipaddress.ip_address(target[0]).ipv4_mapped or ipaddress.ip_address(target[0])
                if source_address != target_address or int(source[1]) != int(target[1]):
                    raise P2PError("p2p_stun_source_mismatch")
                address_text, mapped_port = parse_stun_binding_response(packet, transaction_id)
                address = ipaddress.ip_address(address_text)
                if (address.version == 6 and not dual_stack) or _usable_local_address(address_text) is None:
                    raise P2PError("p2p_stun_mapped_address_invalid")
                candidate = Candidate("SERVER_REFLEXIVE", _endpoint(address, mapped_port), 90)
                if (candidate.kind, candidate.endpoint) not in seen:
                    candidates.append(candidate)
                    seen.add((candidate.kind, candidate.endpoint))
            except P2PError:
                continue
            except (OSError, ValueError, TypeError):
                continue
        return CandidateDiscovery(reserved, tuple(candidates))
    except Exception:
        reserved.close()
        raise


def _require_id(value: Any, code: str) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise P2PError(code)
    return value


def _validate_fencing_token(value: Any) -> str:
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise P2PError("p2p_ticket_fencing_token_invalid")
    if len(value) > 19 or value.startswith("0") or not 1 <= int(value) <= 2**63 - 1:
        raise P2PError("p2p_ticket_fencing_token_invalid")
    return value


def _parse_endpoint(value: Any) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, int]:
    if not isinstance(value, str) or len(value) > 255:
        raise P2PError("p2p_ticket_candidate_invalid")
    try:
        if value.startswith("["):
            closing = value.find("]:")
            if closing < 0:
                raise ValueError
            host, port_text = value[1:closing], value[closing + 2:]
        else:
            host, port_text = value.rsplit(":", 1)
        address, port = ipaddress.ip_address(host), int(port_text)
    except (ValueError, TypeError) as exc:
        raise P2PError("p2p_ticket_candidate_invalid") from exc
    if address.is_unspecified or not 1 <= port <= 65535 or port_text != str(port):
        raise P2PError("p2p_ticket_candidate_invalid")
    return address, port


def _validate_candidates(value: Any, peer: str) -> tuple[Candidate, ...]:
    if not isinstance(value, list) or len(value) > MAX_CANDIDATES_PER_PEER:
        raise P2PError(f"p2p_ticket_{peer}_candidates_invalid")
    candidates: list[Candidate] = []
    seen: set[tuple[str, str]] = set()
    for raw in value:
        if not isinstance(raw, Mapping) or set(raw) != {"kind", "endpoint", "priority"}:
            raise P2PError(f"p2p_ticket_{peer}_candidates_invalid")
        kind, endpoint, priority = raw["kind"], raw["endpoint"], raw["priority"]
        if kind not in _KINDS or not isinstance(priority, int) or isinstance(priority, bool) or not 1 <= priority <= 2**32 - 1:
            raise P2PError(f"p2p_ticket_{peer}_candidates_invalid")
        _parse_endpoint(endpoint)
        identity = (kind, endpoint)
        if identity in seen:
            raise P2PError(f"p2p_ticket_{peer}_candidates_duplicate")
        seen.add(identity)
        candidates.append(Candidate(kind, endpoint, priority))
    return tuple(candidates)


def _signing_bytes(claims: Mapping[str, Any], host: Sequence[Candidate], renter: Sequence[Candidate]) -> bytes:
    policy = claims["relayPolicy"]
    lines = [
        P2P_TICKET_DOMAIN, str(claims["protocolVersion"]), claims["sessionId"],
        claims["machineId"], claims["leaseId"], claims["fencingToken"],
        str(claims["issuedAtMs"]), str(claims["expiresAtMs"]), claims["nonce"],
        claims["hostEphemeralKeyBase58"], claims["renterEphemeralKeyBase58"], policy,
        f"host:{len(host)}",
    ]
    lines.extend(f"{item.kind}|{item.endpoint}|{item.priority}" for item in host)
    lines.append(f"renter:{len(renter)}")
    lines.extend(f"{item.kind}|{item.endpoint}|{item.priority}" for item in renter)
    return ("\n".join(lines) + "\n").encode("utf-8")


def verify_rendezvous_ticket(
    ticket: Mapping[str, Any],
    verifying_key: bytes | str | VerifyKey,
    *,
    session_id: str,
    machine_id: str,
    lease_id: str,
    fencing_token: str,
    now_ms: int | None = None,
) -> tuple[Candidate, ...]:
    """Verify all authority and path invariants before returning peer attempts."""
    return verify_rendezvous_ticket_details(
        ticket,
        verifying_key,
        session_id=session_id,
        machine_id=machine_id,
        lease_id=lease_id,
        fencing_token=fencing_token,
        now_ms=now_ms,
    ).host_candidates


def verify_rendezvous_ticket_details(
    ticket: Mapping[str, Any],
    verifying_key: bytes | str | VerifyKey,
    *,
    session_id: str,
    machine_id: str,
    lease_id: str,
    fencing_token: str,
    now_ms: int | None = None,
) -> VerifiedRendezvousTicket:
    """Verify a ticket and retain both signed peer candidate sets."""
    if not isinstance(ticket, Mapping) or set(ticket) != {"claims", "signatureHex"}:
        raise P2PError("p2p_ticket_structure_invalid")
    claims = ticket["claims"]
    fields = {
        "protocolVersion", "sessionId", "machineId", "leaseId", "fencingToken",
        "issuedAtMs", "expiresAtMs", "nonce", "hostEphemeralKeyBase58",
        "renterEphemeralKeyBase58", "hostCandidates", "renterCandidates", "relayPolicy",
    }
    if not isinstance(claims, Mapping) or set(claims) != fields:
        raise P2PError("p2p_ticket_claims_invalid")
    if claims["protocolVersion"] != P2P_RENDEZVOUS_VERSION:
        raise P2PError("p2p_ticket_protocol_unsupported")
    for field, code in (("sessionId", "session"), ("machineId", "machine"), ("leaseId", "lease")):
        _require_id(claims[field], f"p2p_ticket_{code}_invalid")
    _validate_fencing_token(claims["fencingToken"])
    if claims["sessionId"] != session_id:
        raise P2PError("p2p_ticket_session_mismatch")
    if claims["machineId"] != machine_id:
        raise P2PError("p2p_ticket_machine_mismatch")
    if claims["leaseId"] != lease_id:
        raise P2PError("p2p_ticket_lease_mismatch")
    if claims["fencingToken"] != fencing_token:
        raise P2PError("p2p_ticket_fencing_token_mismatch")

    issued, expires = claims["issuedAtMs"], claims["expiresAtMs"]
    if not isinstance(issued, int) or isinstance(issued, bool) or not isinstance(expires, int) or isinstance(expires, bool):
        raise P2PError("p2p_ticket_time_invalid")
    now = int(time.time() * 1_000) if now_ms is None else now_ms
    if issued < 0 or expires <= issued or expires - issued > MAX_TICKET_LIFETIME_MS:
        raise P2PError("p2p_ticket_time_invalid")
    if issued > now + MAX_CLOCK_SKEW_MS:
        raise P2PError("p2p_ticket_not_yet_valid")
    if now >= expires:
        raise P2PError("p2p_ticket_expired")
    if not isinstance(claims["nonce"], str) or _HEX_NONCE.fullmatch(claims["nonce"]) is None:
        raise P2PError("p2p_ticket_nonce_invalid")
    for field in ("hostEphemeralKeyBase58", "renterEphemeralKeyBase58"):
        value = claims[field]
        try:
            decoded = base58.b58decode(value) if isinstance(value, str) and 32 <= len(value) <= 64 else b""
        except ValueError:
            decoded = b""
        if len(decoded) != 32:
            raise P2PError("p2p_ticket_ephemeral_key_invalid")

    host = _validate_candidates(claims["hostCandidates"], "host")
    renter = _validate_candidates(claims["renterCandidates"], "renter")
    if not host:
        raise P2PError("p2p_ticket_host_candidates_empty")
    if not any(item.kind != "RELAY" for item in host):
        raise P2PError("p2p_ticket_relay_only")
    policy = claims["relayPolicy"]
    if policy not in _POLICIES:
        raise P2PError("p2p_ticket_relay_policy_invalid")
    if policy == "DIRECT_ONLY" and any(item.kind == "RELAY" for item in (*host, *renter)):
        raise P2PError("p2p_ticket_relay_forbidden")

    signature_hex = ticket["signatureHex"]
    if not isinstance(signature_hex, str) or _HEX_SIGNATURE.fullmatch(signature_hex) is None:
        raise P2PError("p2p_ticket_signature_invalid")
    try:
        key = verifying_key if isinstance(verifying_key, VerifyKey) else VerifyKey(
            base58.b58decode(verifying_key) if isinstance(verifying_key, str) else verifying_key
        )
        key.verify(_signing_bytes(claims, host, renter), bytes.fromhex(signature_hex))
    except (BadSignatureError, ValueError, TypeError) as exc:
        raise P2PError("p2p_ticket_signature_invalid") from exc

    rank = {"HOST": 0, "SERVER_REFLEXIVE": 1, "RELAY": 2}
    ordered_host = tuple(sorted(host, key=lambda item: (rank[item.kind], -item.priority, item.endpoint)))
    ordered_renter = tuple(sorted(renter, key=lambda item: (rank[item.kind], -item.priority, item.endpoint)))
    immutable_claims = MappingProxyType({
        key: value
        for key, value in claims.items()
        if key not in {"hostCandidates", "renterCandidates"}
    })
    return VerifiedRendezvousTicket(immutable_claims, ordered_host, ordered_renter)
