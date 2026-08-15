from __future__ import annotations

import json
import os
import struct
import tempfile
import unittest
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.control_channel import (
    AUTH_DOMAIN,
    ControlChannelAssignment,
    ControlChannelError,
    ControlCommandResult,
    _TerminalState,
    build_client_hello,
    classify_command_action,
    encode_frame,
    reconnect_delay,
    validate_command,
    validate_server_hello,
)

MACHINE_ID = "machine_00000001"


def valid_command(kind: str = "PREPARE_RENTAL", sequence: int = 1) -> dict[str, object]:
    command: dict[str, object] = {
        "protocolVersion": 1,
        "commandId": f"command_{sequence:08d}",
        "machineId": MACHINE_ID,
        "sequence": sequence,
        "kind": kind,
        "issuedAtMs": 10_000,
        "expiresAtMs": 20_000,
        "payload": {"workspace": "developer"},
    }
    if kind in {"PREPARE_RENTAL", "START_RENTAL"}:
        command["lease"] = {
            "resourceId": "resource_00000001",
            "holderId": "booking_00000001",
            "leaseId": "lease_000000001",
            "fencingToken": "7",
        }
    return {"type": "COMMAND", "command": command}


class ControlChannelProtocolTests(unittest.TestCase):
    def test_client_hello_matches_gateway_domain_separated_signature(self) -> None:
        key = SigningKey(bytes([7]) * 32)
        nonce = "0123456789abcdef0123456789abcdef"
        hello = build_client_hello(key, MACHINE_ID, 41, issued_at_ms=1_000_000, nonce=nonce)
        canonical = f"{AUTH_DOMAIN}\n1\n{MACHINE_ID}\n1\n1000000\n{nonce}\n41".encode()
        key.verify_key.verify(canonical, bytes.fromhex(str(hello["signatureHex"])))
        self.assertEqual(hello["lastAckedCommandSequence"], 41)
        self.assertTrue(hello["signatureHex"])

    def test_frame_is_big_endian_length_prefixed_and_bounded(self) -> None:
        frame = encode_frame({"type": "HEARTBEAT", "sequence": 1, "observed_at_ms": 123})
        size = struct.unpack(">I", frame[:4])[0]
        self.assertEqual(size, len(frame) - 4)
        self.assertEqual(json.loads(frame[4:]), {"type": "HEARTBEAT", "sequence": 1, "observed_at_ms": 123})
        with self.assertRaisesRegex(ControlChannelError, "control_frame_size_invalid"):
            encode_frame({"payload": "x" * 100}, max_bytes=16)

    def test_assignment_is_fail_closed_and_rejects_url_injection(self) -> None:
        disabled = ControlChannelAssignment.parse({"enabled": False, "protocolVersion": 1, "fallbackPollSeconds": 120})
        self.assertFalse(disabled.enabled)
        enabled = ControlChannelAssignment.parse({
            "enabled": True,
            "protocolVersion": 1,
            "host": "gateway-eu.example.com",
            "port": 4443,
            "serverName": "gateway-eu.example.com",
            "fallbackPollSeconds": 120,
        })
        self.assertTrue(enabled.enabled)
        self.assertEqual(enabled.host, "gateway-eu.example.com")
        with self.assertRaises(ControlChannelError):
            ControlChannelAssignment.parse({
                "enabled": True,
                "protocolVersion": 1,
                "host": "https://gateway.example.com/path",
                "port": 4443,
                "serverName": "gateway.example.com",
                "fallbackPollSeconds": 120,
            })
        with self.assertRaises(ControlChannelError):
            ControlChannelAssignment.parse({"enabled": False, "protocolVersion": 2, "fallbackPollSeconds": 120})

    def test_server_hello_is_strict_and_resume_bound(self) -> None:
        hello = validate_server_hello({
            "type": "SERVER_HELLO",
            "hello": {
                "protocolVersion": 1,
                "gatewayId": "gateway_eu_0001",
                "region": "eu-west-1",
                "connectionId": "conn_0123456789abcdef0123456789abcdef",
                "presenceTtlSeconds": 60,
                "heartbeatTimeoutSeconds": 45,
                "resumedAfterCommandSequence": 7,
            },
        })
        self.assertEqual(hello["resumedAfterCommandSequence"], 7)
        with self.assertRaises(ControlChannelError):
            validate_server_hello({"type": "SERVER_HELLO", "hello": {"protocolVersion": 1}})

    def test_commands_enforce_machine_time_payload_and_fenced_lease(self) -> None:
        command = validate_command(valid_command(), MACHINE_ID, now_ms=11_000)
        self.assertEqual(command.sequence, 1)
        self.assertIsNotNone(command.lease)
        self.assertEqual(classify_command_action(command), "WAKE_JOB")

        no_lease = valid_command()
        command_body = no_lease["command"]
        assert isinstance(command_body, dict)
        command_body.pop("lease")
        with self.assertRaisesRegex(ControlChannelError, "control_command_lease_required"):
            validate_command(no_lease, MACHINE_ID, now_ms=11_000)

        wrong_machine = valid_command()
        wrong_body = wrong_machine["command"]
        assert isinstance(wrong_body, dict)
        wrong_body["machineId"] = "machine_00000002"
        with self.assertRaisesRegex(ControlChannelError, "control_command_machine_mismatch"):
            validate_command(wrong_machine, MACHINE_ID, now_ms=11_000)

        with self.assertRaisesRegex(ControlChannelError, "control_command_time_window_invalid"):
            validate_command(valid_command(), MACHINE_ID, now_ms=20_000)

    def test_v1_only_enables_safe_wake_actions(self) -> None:
        self.assertEqual(classify_command_action(validate_command(valid_command("RUN_DIAGNOSTIC"), MACHINE_ID, 11_000)), "WAKE_JOB")
        self.assertEqual(classify_command_action(validate_command(valid_command("REFRESH_INVENTORY"), MACHINE_ID, 11_000)), "WAKE_HEARTBEAT")
        self.assertEqual(classify_command_action(validate_command(valid_command("QUARANTINE"), MACHINE_ID, 11_000)), "REJECT")
        self.assertEqual(classify_command_action(validate_command(valid_command("STOP_RENTAL"), MACHINE_ID, 11_000)), "REJECT")

    def test_reconnect_uses_full_jitter_with_hard_cap(self) -> None:
        self.assertEqual(reconnect_delay(0, 0.0), 0.25)
        self.assertEqual(reconnect_delay(0, 1.0), 1.0)
        self.assertEqual(reconnect_delay(8, 1.0), 60.0)
        self.assertEqual(reconnect_delay(100, 1.0), 60.0)

    def test_terminal_result_is_persisted_before_reconnect_and_never_regresses(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
            command = validate_command(valid_command(sequence=9), MACHINE_ID, now_ms=11_000)
            first = _TerminalState()
            first.remember(command, ControlCommandResult("SUCCEEDED", "job_wake_processed"))

            restored = _TerminalState()
            self.assertEqual(restored.last_acked_sequence, 9)
            self.assertEqual(restored.cached(command.command_id, 9), ControlCommandResult("SUCCEEDED", "job_wake_processed"))
            with self.assertRaisesRegex(ControlChannelError, "control_terminal_result_conflict"):
                restored.remember(command, ControlCommandResult("FAILED", "late_failure"))


if __name__ == "__main__":
    unittest.main()
