from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.control_channel import (
    MAX_SEQUENCE,
    ControlChannelError,
    ControlCommand,
    ControlCommandResult,
    _TerminalState,
    validate_command,
)

MACHINE_ID = "machine_00000001"


def command(sequence: int) -> ControlCommand:
    return ControlCommand(
        command_id=f"command_{sequence:08d}",
        machine_id=MACHINE_ID,
        sequence=sequence,
        kind="REFRESH_INVENTORY",
        issued_at_ms=10_000,
        expires_at_ms=20_000,
        lease=None,
        payload={},
    )


def state_path(directory: str) -> Path:
    return Path(directory) / "control-channel-state.json"


class ControlChannelResumeStateTests(unittest.TestCase):
    def test_extra_local_fields_cannot_become_authority_and_are_removed_on_next_save(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
            state_path(directory).write_text(json.dumps({
                "schemaVersion": 1,
                "lastAckedCommandSequence": 9,
                "terminalResults": [{
                    "commandId": "command_00000009",
                    "sequence": 9,
                    "status": "SUCCEEDED",
                    "detailCode": "job_wake_processed",
                }],
                "bookingId": "booking_must_not_be_authoritative",
                "jobId": "job_must_not_be_authoritative",
                "lease": {"fencingToken": "999999"},
            }), encoding="utf-8")

            restored = _TerminalState()
            self.assertEqual(restored.last_acked_sequence, 9)
            self.assertEqual(
                restored.cached("command_00000009", 9),
                ControlCommandResult("SUCCEEDED", "job_wake_processed"),
            )

            restored.remember(command(10), ControlCommandResult("SUCCEEDED", "heartbeat_refresh_processed"))
            saved = json.loads(state_path(directory).read_text(encoding="utf-8"))
            self.assertEqual(set(saved), {"schemaVersion", "lastAckedCommandSequence", "terminalResults"})
            self.assertEqual(saved["lastAckedCommandSequence"], 10)
            self.assertNotIn("bookingId", saved)
            self.assertNotIn("jobId", saved)
            self.assertNotIn("lease", saved)

    def test_unknown_schema_or_out_of_range_sequence_is_not_trusted(self) -> None:
        bad_states = [
            {"schemaVersion": 2, "lastAckedCommandSequence": 9, "terminalResults": []},
            {"schemaVersion": 1, "lastAckedCommandSequence": MAX_SEQUENCE + 1, "terminalResults": []},
            {"schemaVersion": 1, "lastAckedCommandSequence": -1, "terminalResults": []},
            {"schemaVersion": 1, "lastAckedCommandSequence": True, "terminalResults": []},
        ]
        for raw in bad_states:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
                state_path(directory).write_text(json.dumps(raw), encoding="utf-8")
                restored = _TerminalState()
                self.assertEqual(restored.last_acked_sequence, 0)
                self.assertEqual(restored.results, [])

    def test_terminal_cache_is_shape_validated_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
            results = [
                {
                    "commandId": f"command_{sequence:08d}",
                    "sequence": sequence,
                    "status": "SUCCEEDED",
                    "detailCode": None,
                }
                for sequence in range(1, 71)
            ]
            results[-1]["unexpectedAuthority"] = "booking_ignored"
            state_path(directory).write_text(json.dumps({
                "schemaVersion": 1,
                "lastAckedCommandSequence": 70,
                "terminalResults": results,
            }), encoding="utf-8")

            restored = _TerminalState()
            self.assertLessEqual(len(restored.results), 64)
            self.assertIsNone(restored.cached("command_00000070", 70))
            self.assertEqual(
                restored.cached("command_00000069", 69),
                ControlCommandResult("SUCCEEDED", None),
            )
            self.assertTrue(all(set(item) == {"commandId", "sequence", "status", "detailCode"} for item in restored.results))

    def test_out_of_range_command_sequence_is_rejected_before_command_execution(self) -> None:
        envelope = {
            "type": "COMMAND",
            "command": {
                "protocolVersion": 1,
                "commandId": "command_overflow_0001",
                "machineId": MACHINE_ID,
                "sequence": MAX_SEQUENCE + 1,
                "kind": "REFRESH_INVENTORY",
                "issuedAtMs": 10_000,
                "expiresAtMs": 20_000,
                "payload": {},
            },
        }
        with self.assertRaisesRegex(ControlChannelError, "control_command_sequence_invalid"):
            validate_command(envelope, MACHINE_ID, now_ms=11_000)


if __name__ == "__main__":
    unittest.main()
