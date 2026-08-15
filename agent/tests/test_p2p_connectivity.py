from __future__ import annotations

import ipaddress
import socket
import struct
import unittest

import base58
from nacl.signing import SigningKey

from gpubnb_agent.p2p_connectivity import (
    MAX_CANDIDATES_PER_PEER,
    Candidate,
    P2PError,
    STUN_MAGIC_COOKIE,
    STUN_XOR_MAPPED_ADDRESS,
    _signing_bytes,
    discover_candidates,
    parse_stun_binding_response,
    verify_rendezvous_ticket,
)


def stun_response(transaction_id: bytes, address: str, port: int) -> bytes:
    ip = ipaddress.ip_address(address)
    family = 0x01 if ip.version == 4 else 0x02
    mask = struct.pack("!I", STUN_MAGIC_COOKIE) + transaction_id
    encoded_ip = bytes(left ^ right for left, right in zip(ip.packed, mask))
    value = struct.pack("!BBH", 0, family, port ^ (STUN_MAGIC_COOKIE >> 16)) + encoded_ip
    attribute = struct.pack("!HH", STUN_XOR_MAPPED_ADDRESS, len(value)) + value
    return struct.pack("!HHI12s", 0x0101, len(attribute), STUN_MAGIC_COOKIE, transaction_id) + attribute


class FakeSocket:
    def __init__(self, response: bytes) -> None:
        self.response = response
        self.closed = False
        self.bound = None
        self.timeout = None

    def bind(self, value) -> None:
        self.bound = value

    def setsockopt(self, *_args) -> None:
        pass

    def getsockname(self):
        return ("::", 41000, 0, 0)

    def settimeout(self, value: float) -> None:
        self.timeout = value

    def sendto(self, packet: bytes, target) -> int:
        if len(packet) != 20:
            raise AssertionError("unexpected STUN request size")
        self.target = target
        return len(packet)

    def recvfrom(self, size: int):
        if size != 1201:
            raise AssertionError("unexpected STUN receive bound")
        return self.response, self.target

    def close(self) -> None:
        self.closed = True


def claims() -> dict:
    return {
        "protocolVersion": 1,
        "sessionId": "session_00000001",
        "machineId": "machine_00000001",
        "leaseId": "lease_00000001",
        "fencingToken": "42",
        "issuedAtMs": 1_000_000,
        "expiresAtMs": 1_060_000,
        "nonce": "0123456789abcdef0123456789abcdef",
        "hostEphemeralKeyBase58": base58.b58encode(bytes([11]) * 32).decode(),
        "renterEphemeralKeyBase58": base58.b58encode(bytes([12]) * 32).decode(),
        "hostCandidates": [
            {"kind": "RELAY", "endpoint": "203.0.113.20:4433", "priority": 65535},
            {"kind": "SERVER_REFLEXIVE", "endpoint": "198.51.100.10:42000", "priority": 50},
            {"kind": "HOST", "endpoint": "192.168.1.10:42000", "priority": 10},
        ],
        "renterCandidates": [
            {"kind": "SERVER_REFLEXIVE", "endpoint": "198.51.100.30:43000", "priority": 10}
        ],
        "relayPolicy": "FALLBACK_ONLY",
    }


def signed_ticket(value: dict | None = None, key: SigningKey | None = None) -> tuple[dict, SigningKey]:
    ticket_claims = claims() if value is None else value
    signing_key = SigningKey(bytes([7]) * 32) if key is None else key
    host = tuple(
        Candidate(item["kind"], item["endpoint"], item["priority"])
        for item in ticket_claims["hostCandidates"]
    )
    renter = tuple(
        Candidate(item["kind"], item["endpoint"], item["priority"])
        for item in ticket_claims["renterCandidates"]
    )
    signature = signing_key.sign(_signing_bytes(ticket_claims, host, renter)).signature.hex()
    return {"claims": ticket_claims, "signatureHex": signature}, signing_key


def verify(ticket: dict, key: SigningKey, **overrides):
    values = {
        "session_id": "session_00000001",
        "machine_id": "machine_00000001",
        "lease_id": "lease_00000001",
        "fencing_token": "42",
        "now_ms": 1_000_010,
    }
    values.update(overrides)
    return verify_rendezvous_ticket(ticket, bytes(key.verify_key), **values)


class P2PConnectivityTests(unittest.TestCase):
    def test_stun_parses_valid_ipv4_and_ipv6(self) -> None:
        transaction = bytes(range(12))
        self.assertEqual(
            parse_stun_binding_response(stun_response(transaction, "198.51.100.8", 4242), transaction),
            ("198.51.100.8", 4242),
        )
        self.assertEqual(
            parse_stun_binding_response(stun_response(transaction, "2001:db8::8", 65535), transaction),
            ("2001:db8::8", 65535),
        )

    def test_stun_rejects_malformed_packets(self) -> None:
        cases = (
            (lambda packet: packet[:2] + b"\x00\x01" + packet[4:], "p2p_stun_length_invalid"),
            (lambda packet: packet[:4] + b"\x00\x00\x00\x00" + packet[8:], "p2p_stun_cookie_invalid"),
            (lambda packet: b"\x01\x11" + packet[2:], "p2p_stun_response_type_invalid"),
            (lambda packet: packet[:-1], "p2p_stun_length_invalid"),
            (lambda packet: packet[:22], "p2p_stun_length_invalid"),
        )
        transaction = b"t" * 12
        packet = stun_response(transaction, "198.51.100.8", 4242)
        for mutate, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(P2PError, code):
                parse_stun_binding_response(mutate(packet), transaction)

    def test_stun_rejects_wrong_transaction_id(self) -> None:
        packet = stun_response(b"a" * 12, "198.51.100.8", 4242)
        with self.assertRaisesRegex(P2PError, "p2p_stun_transaction_mismatch"):
            parse_stun_binding_response(packet, b"b" * 12)

    def test_discovery_keeps_reserved_port_filters_addresses_and_deduplicates(self) -> None:
        transaction = b"x" * 12
        fake = FakeSocket(stun_response(transaction, "198.51.100.9", 51000))
        result = discover_candidates(
            {
                "stunServers": [{"host": "stun.internal", "port": 3478}],
                "stunTimeoutMs": 50,
                "stunTotalTimeoutMs": 100,
            },
            address_provider=lambda: map(
                ipaddress.ip_address,
                ["127.0.0.1", "0.0.0.0", "169.254.2.2", "10.0.0.4", "10.0.0.4"],
            ),
            socket_factory=lambda *_args: fake,
            resolver=lambda *_args: [(socket.AF_INET, socket.SOCK_DGRAM, 17, "", ("192.0.2.10", 3478))],
            random_bytes=lambda _size: transaction,
            monotonic=lambda: 1.0,
        )
        self.assertIs(result.socket, fake)
        self.assertEqual(
            result.candidates,
            (
                Candidate("HOST", "10.0.0.4:41000", 100),
                Candidate("SERVER_REFLEXIVE", "198.51.100.9:51000", 90),
            ),
        )
        result.close()
        self.assertTrue(fake.closed)

    def test_discovery_has_no_default_public_stun_and_enforces_limits(self) -> None:
        fake = FakeSocket(b"")
        result = discover_candidates(
            {},
            address_provider=lambda: [ipaddress.ip_address("10.0.0.2")],
            socket_factory=lambda *_args: fake,
        )
        self.assertEqual(result.candidates, (Candidate("HOST", "10.0.0.2:41000", 100),))
        result.close()

        with self.assertRaisesRegex(P2PError, "p2p_stun_config_invalid"):
            discover_candidates({"stunServers": [{"host": "x", "port": 1}] * 5})
        with self.assertRaisesRegex(P2PError, "p2p_stun_config_invalid"):
            discover_candidates({"stunServers": [], "stunTimeoutMs": 3001, "stunTotalTimeoutMs": 4000})

    def test_discovery_advertises_ipv6_on_dual_stack_reserved_port(self) -> None:
        fake = FakeSocket(b"")
        result = discover_candidates(
            {},
            address_provider=lambda: [ipaddress.ip_address("2001:db8::9")],
            socket_factory=lambda *_args: fake,
        )
        self.assertEqual(result.candidates, (Candidate("HOST", "[2001:db8::9]:41000", 100),))
        result.close()

    def test_ticket_signature_bytes_match_rust_contract_and_direct_first_order(self) -> None:
        ticket, key = signed_ticket()
        expected = (
            "gpubnb-p2p-rendezvous-v1\n1\nsession_00000001\nmachine_00000001\nlease_00000001\n42\n"
            "1000000\n1060000\n0123456789abcdef0123456789abcdef\n"
            f"{claims()['hostEphemeralKeyBase58']}\n{claims()['renterEphemeralKeyBase58']}\nFALLBACK_ONLY\n"
            "host:3\nRELAY|203.0.113.20:4433|65535\nSERVER_REFLEXIVE|198.51.100.10:42000|50\n"
            "HOST|192.168.1.10:42000|10\nrenter:1\nSERVER_REFLEXIVE|198.51.100.30:43000|10\n"
        ).encode()
        value = claims()
        host = tuple(Candidate(item["kind"], item["endpoint"], item["priority"]) for item in value["hostCandidates"])
        renter = tuple(
            Candidate(item["kind"], item["endpoint"], item["priority"])
            for item in value["renterCandidates"]
        )
        self.assertEqual(_signing_bytes(value, host, renter), expected)
        self.assertEqual(
            [item.kind for item in verify(ticket, key)],
            ["HOST", "SERVER_REFLEXIVE", "RELAY"],
        )

    def test_ticket_rejects_expiry_bad_signature_and_fencing_mismatch(self) -> None:
        ticket, key = signed_ticket()
        with self.assertRaisesRegex(P2PError, "p2p_ticket_expired"):
            verify(ticket, key, now_ms=1_060_000)
        with self.assertRaisesRegex(P2PError, "p2p_ticket_fencing_token_mismatch"):
            verify(ticket, key, fencing_token="43")
        with self.assertRaisesRegex(P2PError, "p2p_ticket_signature_invalid"):
            verify(ticket, SigningKey.generate())

    def test_ticket_rejects_protocol_and_authority_scope(self) -> None:
        cases = (
            ("protocolVersion", 2, None, None, "p2p_ticket_protocol_unsupported"),
            ("sessionId", "session_00000002", "session_id", "session_00000001", "p2p_ticket_session_mismatch"),
            ("machineId", "machine_00000002", "machine_id", "machine_00000001", "p2p_ticket_machine_mismatch"),
            ("leaseId", "lease_00000002", "lease_id", "lease_00000001", "p2p_ticket_lease_mismatch"),
        )
        for claim_field, claim_value, argument, argument_value, code in cases:
            with self.subTest(claim_field=claim_field):
                value = claims()
                value[claim_field] = claim_value
                ticket, key = signed_ticket(value)
                overrides = {} if argument is None else {argument: argument_value}
                with self.assertRaisesRegex(P2PError, code):
                    verify(ticket, key, **overrides)

    def test_ticket_rejects_overlong_lifetime(self) -> None:
        value = claims()
        value["expiresAtMs"] = value["issuedAtMs"] + 120_001
        ticket, key = signed_ticket(value)
        with self.assertRaisesRegex(P2PError, "p2p_ticket_time_invalid"):
            verify(ticket, key)

    def test_ticket_rejects_duplicate_candidates_relay_only_and_limits(self) -> None:
        duplicate = claims()
        duplicate["hostCandidates"].append(dict(duplicate["hostCandidates"][0]))
        ticket, key = signed_ticket(duplicate)
        with self.assertRaisesRegex(P2PError, "p2p_ticket_host_candidates_duplicate"):
            verify(ticket, key)

        relay_only = claims()
        relay_only["hostCandidates"] = [relay_only["hostCandidates"][0]]
        ticket, key = signed_ticket(relay_only)
        with self.assertRaisesRegex(P2PError, "p2p_ticket_relay_only"):
            verify(ticket, key)

        oversized = claims()
        oversized["renterCandidates"] = [
            {"kind": "HOST", "endpoint": f"10.0.0.1:{10000 + index}", "priority": 1}
            for index in range(MAX_CANDIDATES_PER_PEER + 1)
        ]
        ticket, key = signed_ticket(oversized)
        with self.assertRaisesRegex(P2PError, "p2p_ticket_renter_candidates_invalid"):
            verify(ticket, key)

    def test_ticket_rejects_relay_under_direct_only_and_unknown_fields(self) -> None:
        direct_only = claims()
        direct_only["relayPolicy"] = "DIRECT_ONLY"
        ticket, key = signed_ticket(direct_only)
        with self.assertRaisesRegex(P2PError, "p2p_ticket_relay_forbidden"):
            verify(ticket, key)

        ticket, key = signed_ticket()
        ticket["claims"]["unexpected"] = "value"
        with self.assertRaisesRegex(P2PError, "p2p_ticket_claims_invalid"):
            verify(ticket, key)

    def test_errors_are_stable_codes_without_address_values(self) -> None:
        packet = stun_response(b"a" * 12, "198.51.100.222", 4242)
        with self.assertRaisesRegex(P2PError, "p2p_stun_transaction_mismatch") as error:
            parse_stun_binding_response(packet, b"b" * 12)
        self.assertEqual(str(error.exception), "p2p_stun_transaction_mismatch")
        self.assertNotIn("198.51.100.222", str(error.exception))


if __name__ == "__main__":
    unittest.main()
