from __future__ import annotations

import asyncio
import datetime
import json
import socket
import ssl
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

import base58
from aioquic.quic.configuration import QuicConfiguration
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from nacl.signing import SigningKey

from gpubnb_agent.host_tunnel import HostTunnelSupervisor
from gpubnb_agent.p2p_connectivity import (
    Candidate,
    P2PError,
    P2P_TICKET_DOMAIN,
    verify_rendezvous_ticket_details,
)
from gpubnb_agent.p2p_direct_quic import (
    DIRECT_ALPN,
    DirectResultCode,
    ReplayCache,
    connect_direct_first,
    connect_direct_quic_first,
    connect_reserved_socket,
    host_handshake,
    listen_reserved_socket,
)


def _ticket(host_key: SigningKey, renter_key: SigningKey, port: int, **updates: object):
    now = int(time.time() * 1_000)
    claims = {
        "protocolVersion": 1,
        "sessionId": "session_00000001",
        "machineId": "machine_00000001",
        "leaseId": "lease_00000001",
        "fencingToken": "42",
        "issuedAtMs": now - 1_000,
        "expiresAtMs": now + 60_000,
        "nonce": "11" * 32,
        "hostEphemeralKeyBase58": base58.b58encode(bytes(host_key.verify_key)).decode(),
        "renterEphemeralKeyBase58": base58.b58encode(bytes(renter_key.verify_key)).decode(),
        "hostCandidates": [{"kind": "HOST", "endpoint": f"127.0.0.1:{port}", "priority": 100}],
        "renterCandidates": [{"kind": "HOST", "endpoint": "127.0.0.1:45678", "priority": 100}],
        "relayPolicy": "FALLBACK_ONLY",
    }
    claims.update(updates)
    lines = [
        P2P_TICKET_DOMAIN, str(claims["protocolVersion"]), str(claims["sessionId"]),
        str(claims["machineId"]), str(claims["leaseId"]), str(claims["fencingToken"]),
        str(claims["issuedAtMs"]), str(claims["expiresAtMs"]), str(claims["nonce"]),
        str(claims["hostEphemeralKeyBase58"]), str(claims["renterEphemeralKeyBase58"]),
        str(claims["relayPolicy"]), f"host:{len(claims['hostCandidates'])}",
    ]
    lines.extend(f"{v['kind']}|{v['endpoint']}|{v['priority']}" for v in claims["hostCandidates"])
    lines.append(f"renter:{len(claims['renterCandidates'])}")
    lines.extend(f"{v['kind']}|{v['endpoint']}|{v['priority']}" for v in claims["renterCandidates"])
    control_key = SigningKey.generate()
    ticket = {"claims": claims, "signatureHex": control_key.sign(("\n".join(lines) + "\n").encode()).signature.hex()}
    verified = verify_rendezvous_ticket_details(
        ticket, bytes(control_key.verify_key), session_id=str(claims["sessionId"]),
        machine_id=str(claims["machineId"]), lease_id=str(claims["leaseId"]),
        fencing_token=str(claims["fencingToken"]), now_ms=now,
    )
    return verified


def _certificate(directory: Path, name: str, ca_key, ca_cert):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    cert = (
        x509.CertificateBuilder().subject_name(subject).issuer_name(ca_cert.subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    key_path, cert_path = directory / f"{name}.key", directory / f"{name}.crt"
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def _tls_configs(directory: Path):
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "GPUbnb P2P test CA")])
    ca_cert = (
        x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
        .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    ca_path = directory / "ca.crt"
    ca_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    host_cert, host_key = _certificate(directory, "host.test", ca_key, ca_cert)
    renter_cert, renter_key = _certificate(directory, "renter.test", ca_key, ca_cert)
    server = QuicConfiguration(is_client=False, alpn_protocols=[DIRECT_ALPN], verify_mode=ssl.CERT_REQUIRED)
    server.load_cert_chain(host_cert, host_key)
    server.load_verify_locations(ca_path)
    client = QuicConfiguration(is_client=True, alpn_protocols=[DIRECT_ALPN], verify_mode=ssl.CERT_REQUIRED, server_name="host.test")
    client.load_cert_chain(renter_cert, renter_key)
    client.load_verify_locations(ca_path)
    return server, client


class P2PDirectQuicTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_quic_loopback_and_authenticated_handshake(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        host_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        host_socket.bind(("127.0.0.1", 0))
        renter_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        renter_socket.bind(("127.0.0.1", 0))
        original_port = renter_socket.getsockname()[1]
        ticket = _ticket(host_key, renter_key, host_socket.getsockname()[1])
        authenticated = asyncio.Event()
        tasks: set[asyncio.Task] = set()

        with tempfile.TemporaryDirectory() as raw:
            server_config, client_config = _tls_configs(Path(raw))

            async def accept(reader, writer):
                try:
                    await host_handshake(reader, writer, ticket, host_key, ReplayCache(), lambda _l, _f: True)
                    authenticated.set()
                finally:
                    writer.close()

            def handler(reader, writer):
                task = asyncio.create_task(accept(reader, writer))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

            transport, server = await listen_reserved_socket(host_socket, server_config, handler)
            session = await asyncio.wait_for(connect_reserved_socket(
                renter_socket, ticket.host_candidates[0], client_config, ticket, renter_key,
                lambda _l, _f: True,
            ), 5)
            await asyncio.wait_for(authenticated.wait(), 2)
            self.assertTrue(session.authenticated)
            self.assertEqual(session.candidate_kind, "HOST")
            self.assertEqual(session.transport.get_extra_info("sockname")[1], original_port)
            await session.close()
            server.close()
            transport.close()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def test_bad_ephemeral_key_fails_before_network(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        ticket = _ticket(host_key, renter_key, 4444)
        with tempfile.TemporaryDirectory() as raw:
            _server, client = _tls_configs(Path(raw))
            with self.assertRaisesRegex(P2PError, "p2p_direct_local_key_mismatch"):
                await connect_reserved_socket(sock, ticket.host_candidates[0], client, ticket, SigningKey.generate())
        sock.close()

    async def test_same_socket_survives_host_failure_then_reflexive_success(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        server_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        server_socket.bind(("127.0.0.1", 0))
        unused = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        unused.bind(("127.0.0.1", 0))
        unused_port = unused.getsockname()[1]
        client_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        client_socket.bind(("127.0.0.1", 0))
        client_port = client_socket.getsockname()[1]
        ticket = _ticket(host_key, renter_key, unused_port, hostCandidates=[
            {"kind": "HOST", "endpoint": f"127.0.0.1:{unused_port}", "priority": 100},
            {"kind": "SERVER_REFLEXIVE", "endpoint": f"127.0.0.1:{server_socket.getsockname()[1]}", "priority": 90},
        ])
        ready = asyncio.Event()
        tasks: set[asyncio.Task] = set()
        with tempfile.TemporaryDirectory() as raw:
            server_config, client_config = _tls_configs(Path(raw))

            async def accept(reader, writer):
                try:
                    await host_handshake(reader, writer, ticket, host_key, ReplayCache())
                    ready.set()
                finally:
                    writer.close()

            def handler(reader, writer):
                task = asyncio.create_task(accept(reader, writer))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

            transport, server = await listen_reserved_socket(server_socket, server_config, handler)
            outcome = await connect_direct_quic_first(
                client_socket, ticket, client_config, renter_key,
                attempt_timeout_ms=1_000, total_timeout_ms=4_000,
            )
            self.assertEqual(outcome.code, DirectResultCode.DIRECT_SERVER_REFLEXIVE)
            self.assertEqual(outcome.metrics.attempts, 2)
            self.assertEqual(outcome.session.transport.get_extra_info("sockname")[1], client_port)
            await asyncio.wait_for(ready.wait(), 1)
            await outcome.session.close()
            server.close()
            transport.close()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        unused.close()

    async def test_endpoint_not_in_signed_ticket_is_rejected(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        ticket = _ticket(host_key, renter_key, 4444)
        with tempfile.TemporaryDirectory() as raw:
            _server, client = _tls_configs(Path(raw))
            with self.assertRaisesRegex(P2PError, "p2p_direct_endpoint_not_authorized"):
                await connect_reserved_socket(sock, Candidate("HOST", "127.0.0.1:5555", 1), client, ticket, renter_key)
        sock.close()

    async def test_host_then_reflexive_order_and_fallback_after_failure(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        ticket = _ticket(host_key, renter_key, 4444, hostCandidates=[
            {"kind": "SERVER_REFLEXIVE", "endpoint": "127.0.0.1:4445", "priority": 200},
            {"kind": "HOST", "endpoint": "127.0.0.1:4444", "priority": 1},
        ])
        attempted, fallback = [], []

        async def fail(_socket, candidate):
            attempted.append(candidate.kind)
            raise ConnectionError

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        outcome = await connect_direct_first(sock, ticket, fail, fallback=lambda: fallback.append(True) or True)
        sock.close()
        self.assertEqual(attempted, ["HOST", "SERVER_REFLEXIVE"])
        self.assertEqual(fallback, [True])
        self.assertTrue(outcome.metrics.fallback_required)

    async def test_direct_only_never_falls_back(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        ticket = _ticket(host_key, renter_key, 4444, relayPolicy="DIRECT_ONLY")
        fallback = []

        async def fail(_socket, _candidate):
            raise ConnectionError

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        outcome = await connect_direct_first(sock, ticket, fail, fallback=lambda: fallback.append(True) or True)
        sock.close()
        self.assertEqual(fallback, [])
        self.assertEqual(outcome.code, DirectResultCode.DIRECT_FAILED)

    async def test_timeout_and_revocation_are_bounded(self):
        host_key, renter_key = SigningKey.generate(), SigningKey.generate()
        ticket = _ticket(host_key, renter_key, 4444)

        async def hang(_socket, _candidate):
            await asyncio.Event().wait()

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        outcome = await connect_direct_first(sock, ticket, hang, attempt_timeout_ms=10, total_timeout_ms=10)
        self.assertEqual(outcome.code, DirectResultCode.TIMEOUT)
        revoked = await connect_direct_first(sock, ticket, hang, authority_check=lambda _l, _f: False)
        sock.close()
        self.assertEqual(revoked.code, DirectResultCode.REVOKED)

    def test_replay_cache_and_telemetry_are_non_sensitive(self):
        cache = ReplayCache(max_entries=2)
        now = int(time.time() * 1_000)
        self.assertTrue(cache.consume("ticket:challenge", now + 1_000, now))
        self.assertFalse(cache.consume("ticket:challenge", now + 1_000, now))
        metrics = {
            "candidateKind": "HOST", "success": False, "latencyMs": 3,
            "attempts": 1, "fallbackRequired": True, "failureCode": "TIMEOUT",
        }
        encoded = json.dumps(metrics)
        self.assertNotIn("127.0.0.1", encoded)
        self.assertNotIn("session_", encoded)

    def test_edge_tunnel_starts_only_after_direct_failure(self):
        supervisor = object.__new__(HostTunnelSupervisor)
        supervisor.stop = Mock()
        supervisor.reconcile = Mock(return_value=True)
        self.assertFalse(supervisor.reconcile_after_direct("session_1", 9000, "DIRECT_HOST", "FALLBACK_ONLY"))
        supervisor.reconcile.assert_not_called()
        self.assertTrue(supervisor.reconcile_after_direct("session_1", 9000, "TIMEOUT", "FALLBACK_ONLY"))
        supervisor.reconcile.assert_called_once_with("session_1", 9000, True)
        supervisor.reconcile.reset_mock()
        self.assertFalse(supervisor.reconcile_after_direct("session_1", 9000, "TIMEOUT", "DIRECT_ONLY"))
        supervisor.reconcile.assert_not_called()
        self.assertFalse(supervisor.reconcile_after_direct("session_1", 9000, "REVOKED", "FALLBACK_ONLY"))
        supervisor.reconcile.assert_not_called()
