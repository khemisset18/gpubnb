from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.execution_control import ExecutionControlError
from gpubnb_agent.gpu_rental_preemption import (
    GpuQuiescenceProof,
    GpuQuiescenceSample,
    RentalClaimRecord,
    RentalClaimStore,
    RentalPreemptionSupervisor,
    RentalResourceSpec,
)
from gpubnb_agent.gpu_resource_supervisor import (
    GpuResourceSupervisor,
    RuntimeRecord,
    RuntimeStore,
)
from gpubnb_agent.workspace_gateway_v10 import GatewaySupervisor


GPU = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
RESOURCE = "resource_00000001"
OLD_SESSION = "session_old0001"
NEW_SESSION = "session_new0001"


class Probe:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def prove(self, hardware_uuid: str) -> GpuQuiescenceProof:
        self.calls.append(hardware_uuid)
        sample = GpuQuiescenceSample(hardware_uuid, 0, 0, 4096, ())
        return GpuQuiescenceProof(
            hardware_uuid=hardware_uuid,
            samples=(sample, sample, sample),
            memory_threshold_mib=256,
            verified_at_ms=123456789,
        )


def rental_spec(session: str, generation: int, lease: str) -> RentalResourceSpec:
    return RentalResourceSpec(
        session_id=session,
        resource_id=RESOURCE,
        hardware_uuid=GPU,
        runtime_generation=generation,
        holder_id=f"rental:{session}",
        lease_id=lease,
        fencing_token=str(generation),
    )


def claim_for(spec: RentalResourceSpec, state: str) -> RentalClaimRecord:
    return RentalClaimRecord(
        session_id=spec.session_id,
        resource_id=spec.resource_id,
        hardware_uuid=spec.hardware_uuid,
        runtime_generation=spec.runtime_generation,
        holder_id=spec.holder_id,
        lease_id=spec.lease_id,
        fencing_token=spec.fencing_token,
        state=state,
        verified_at_ms=111,
    )


class WindowsNativeStaleClaimRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.claims = RentalClaimStore(root / "claims.json")
        self.runtime = RuntimeStore(root / "runtime.json")
        self.probe = Probe()
        mining = GpuResourceSupervisor(
            store=self.runtime,
            binding_resolver=lambda hardware_uuid: object(),
        )
        self.preemption = RentalPreemptionSupervisor(
            mining=mining,
            claims=self.claims,
            probe=self.probe,
        )

        self.old = rental_spec(OLD_SESSION, 70, "lease_old_0000000001")
        self.new = rental_spec(NEW_SESSION, 71, "lease_new_0000000001")
        self.claims.save({RESOURCE: claim_for(self.old, "RENTAL_ACTIVE")})
        self.runtime.save({
            RESOURCE: RuntimeRecord(
                resource_id=RESOURCE,
                hardware_uuid=GPU,
                runtime_generation=70,
                state="STOPPED",
                updated_at_ms=100,
            )
        })

        self.supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        self.supervisor.machine_id = "machine_00000001"
        self.supervisor.rental_preemption = self.preemption
        self.supervisor._trace = lambda *_args, **_kwargs: None
        self.requests: list[tuple[str, str, dict[str, object] | None]] = []

        def request(path: str, method: str = "GET", body: dict[str, object] | None = None):
            self.requests.append((path, method, body))
            return {
                "protocolVersion": 1,
                "allowed": True,
                "oldSessionId": OLD_SESSION,
                "newSessionId": NEW_SESSION,
                "oldRuntimeBackend": "WINDOWS_NATIVE",
            }

        self.supervisor._request = request

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_newer_signed_native_authority_recovers_stale_active_claim_after_physical_cleanup(self) -> None:
        with patch(
            "gpubnb_agent.workspace_gateway_v10.stop_windows_native_workspace",
            return_value=None,
        ) as stop:
            proof = self.supervisor._preempt_native_spec(self.new)

        stop.assert_called_once_with(OLD_SESSION)
        self.assertEqual(proof.hardware_uuid, GPU)
        current = self.claims.load()[RESOURCE]
        self.assertEqual(current.session_id, NEW_SESSION)
        self.assertEqual(current.runtime_generation, 71)
        self.assertEqual(current.state, "QUIESCENT")
        runtime = self.runtime.load()[RESOURCE]
        self.assertEqual(runtime.runtime_generation, 71)
        self.assertEqual(runtime.state, "STOPPED")
        self.assertEqual(self.probe.calls, [GPU, GPU])
        self.assertEqual(len(self.requests), 1)

    def test_equal_fence_never_authorizes_or_cleans_old_claim(self) -> None:
        equal = rental_spec(NEW_SESSION, 70, "lease_new_0000000001")
        with patch(
            "gpubnb_agent.workspace_gateway_v10.stop_windows_native_workspace",
            return_value=None,
        ) as stop:
            with self.assertRaisesRegex(
                ExecutionControlError,
                "rental_resource_claim_conflict",
            ):
                self.supervisor._preempt_native_spec(equal)

        stop.assert_not_called()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.claims.load()[RESOURCE], claim_for(self.old, "RENTAL_ACTIVE"))

    def test_persisted_process_identity_keeps_recovery_fail_closed(self) -> None:
        self.runtime.save({
            RESOURCE: RuntimeRecord(
                resource_id=RESOURCE,
                hardware_uuid=GPU,
                runtime_generation=70,
                state="STOPPED",
                pid=4242,
                executable_path="C:/approved/miner.exe",
                process_creation_token="creation-old",
                updated_at_ms=100,
            )
        })
        with patch(
            "gpubnb_agent.workspace_gateway_v10.stop_windows_native_workspace",
            return_value=None,
        ) as stop:
            with self.assertRaisesRegex(
                ExecutionControlError,
                "rental_resource_stale_claim_runtime_unsafe",
            ):
                self.supervisor._preempt_native_spec(self.new)

        stop.assert_not_called()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.claims.load()[RESOURCE].session_id, OLD_SESSION)

    def test_server_denial_mutates_nothing(self) -> None:
        self.supervisor._request = lambda *_args, **_kwargs: {
            "protocolVersion": 1,
            "allowed": False,
            "oldSessionId": OLD_SESSION,
            "newSessionId": NEW_SESSION,
            "reason": "stale_claim_old_session_not_terminal",
        }
        with patch(
            "gpubnb_agent.workspace_gateway_v10.stop_windows_native_workspace",
            return_value=None,
        ) as stop:
            with self.assertRaisesRegex(
                ExecutionControlError,
                "rental_resource_stale_claim_recovery_not_authorized",
            ):
                self.supervisor._preempt_native_spec(self.new)

        stop.assert_not_called()
        self.assertEqual(self.claims.load()[RESOURCE].session_id, OLD_SESSION)
        self.assertEqual(self.runtime.load()[RESOURCE].runtime_generation, 70)

    def test_unconfirmed_old_native_stop_mutates_no_claim(self) -> None:
        with patch(
            "gpubnb_agent.workspace_gateway_v10.stop_windows_native_workspace",
            side_effect=RuntimeError("native_workspace_stop_unconfirmed"),
        ):
            with self.assertRaisesRegex(
                ExecutionControlError,
                "rental_resource_stale_claim_cleanup_unverified",
            ):
                self.supervisor._preempt_native_spec(self.new)

        self.assertEqual(self.claims.load()[RESOURCE].session_id, OLD_SESSION)
        self.assertEqual(self.runtime.load()[RESOURCE].runtime_generation, 70)
        self.assertEqual(self.probe.calls, [])


if __name__ == "__main__":
    unittest.main()
