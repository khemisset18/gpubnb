from __future__ import annotations

import unittest

from gpubnb_agent.control_channel import ControlCommand
from gpubnb_agent.control_channel_runtime import _validated_mining_payload
from gpubnb_agent.execution_control import ExecutionControlError


def command(*, lease=None, generation="7", resource_id="resource_00000001") -> ControlCommand:
    return ControlCommand(
        command_id="command_00000001",
        machine_id="machine_00000001",
        sequence=1,
        kind="START_MINING",
        issued_at_ms=1,
        expires_at_ms=2,
        lease=lease,
        payload={
            "resourceId": resource_id,
            "hardwareUuid": "GPU-aaaaaaaa",
            "runtimeGeneration": generation,
            "profileId": "lolminer_etchash",
            "poolUrl": "stratum+tcp://pool.example.com:4444",
            "walletAddress": "wallet.example-123",
            "workerName": "worker_1",
            "performanceMode": "FULL",
        },
    )


class ResourceCommandFenceTests(unittest.TestCase):
    def test_mining_requires_resource_lease(self) -> None:
        with self.assertRaisesRegex(ExecutionControlError, "mining_resource_lease_required"):
            _validated_mining_payload(command())

    def test_lease_resource_must_match_payload(self) -> None:
        lease = {
            "resourceId": "resource_00000002",
            "holderId": "holder_00000001",
            "leaseId": "lease_00000001",
            "fencingToken": "7",
        }
        with self.assertRaisesRegex(ExecutionControlError, "mining_resource_lease_mismatch"):
            _validated_mining_payload(command(lease=lease))

    def test_runtime_generation_is_exact_decimal_fence(self) -> None:
        lease = {
            "resourceId": "resource_00000001",
            "holderId": "holder_00000001",
            "leaseId": "lease_00000001",
            "fencingToken": "9223372036854775807",
        }
        normalized = _validated_mining_payload(
            command(lease=lease, generation="9223372036854775807")
        )
        self.assertEqual(normalized["runtimeGeneration"], 9_223_372_036_854_775_807)

        with self.assertRaisesRegex(ExecutionControlError, "mining_runtime_generation_fence_mismatch"):
            _validated_mining_payload(command(lease=lease, generation="9223372036854775806"))

    def test_wire_generation_must_not_be_json_number(self) -> None:
        lease = {
            "resourceId": "resource_00000001",
            "holderId": "holder_00000001",
            "leaseId": "lease_00000001",
            "fencingToken": "7",
        }
        with self.assertRaisesRegex(ExecutionControlError, "mining_runtime_generation_fence_mismatch"):
            _validated_mining_payload(command(lease=lease, generation=7))


if __name__ == "__main__":
    unittest.main()
