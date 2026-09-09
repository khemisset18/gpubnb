from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

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
    GpuBinding,
    GpuResourceSupervisor,
    ProcessIdentity,
    RuntimeRecord,
    RuntimeStore,
)
from gpubnb_agent.rental_claim_recovery import (
    _ORIGINAL_PREEMPT,
    _preempt_with_recovery,
)


class FakeInspector:
    def __init__(self) -> None:
        self.identities: dict[int, ProcessIdentity] = {}
        self.terminated: list[ProcessIdentity] = []

    def inspect(self, pid: int) -> ProcessIdentity | None:
        return self.identities.get(pid)

    def terminate(self, identity: ProcessIdentity) -> None:
        self.terminated.append(identity)
        self.identities.pop(identity.pid, None)


class FakeProbe:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.failure: str | None = None

    def prove(self, hardware_uuid: str) -> GpuQuiescenceProof:
        self.calls.append(hardware_uuid)
        if self.failure:
            raise ExecutionControlError(self.failure)
        sample = GpuQuiescenceSample(hardware_uuid, 0, 0, 4096, ())
        return GpuQuiescenceProof(
            hardware_uuid=hardware_uuid,
            samples=(sample, sample, sample),
            memory_threshold_mib=256,
            verified_at_ms=987654321,
        )


def rental_spec(
    generation: int,
    *,
    session: str,
    hardware: str = "GPU-aaaaaaaa",
    lease: str | None = None,
) -> RentalResourceSpec:
    resource = "resource_00000001"
    return RentalResourceSpec(
        session_id=session,
        resource_id=resource,
        hardware_uuid=hardware,
        runtime_generation=generation,
        holder_id=f"rental:{session}",
        lease_id=lease or f"lease_{session}_{generation}_abcdef",
        fencing_token=str(generation),
    )


def claim(spec: RentalResourceSpec, state: str = "QUARANTINED") -> RentalClaimRecord:
    return RentalClaimRecord(
        session_id=spec.session_id,
        resource_id=spec.resource_id,
        hardware_uuid=spec.hardware_uuid,
        runtime_generation=spec.runtime_generation,
        holder_id=spec.holder_id,
        lease_id=spec.lease_id,
        fencing_token=spec.fencing_token,
        state=state,
        verified_at_ms=123456,
    )


class StaleQuarantinedRentalClaimRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.runtime_store = RuntimeStore(root / "runtime.json")
        self.claim_store = RentalClaimStore(root / "rental.json")
        self.inspector = FakeInspector()
        self.probe = FakeProbe()
        self.binding_calls: list[str] = []

        def resolve_binding(hardware: str) -> GpuBinding:
            self.binding_calls.append(hardware)
            if hardware != "GPU-aaaaaaaa":
                raise ExecutionControlError("resource_gpu_not_present")
            return GpuBinding(hardware, "65:00", 75.0, 40.0)

        self.mining = GpuResourceSupervisor(
            store=self.runtime_store,
            inspector=self.inspector,
            binding_resolver=resolve_binding,
        )
        self.supervisor = RentalPreemptionSupervisor(
            mining=self.mining,
            claims=self.claim_store,
            probe=self.probe,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _seed_quarantine(
        self,
        *,
        generation: int = 7,
        runtime_generation: int | None = None,
        runtime_state: str = "QUARANTINED",
        pid: int | None = None,
        creation_token: str | None = None,
    ) -> RentalResourceSpec:
        old = rental_spec(generation, session="session_old0001")
        self.claim_store.save({old.resource_id: claim(old)})
        self.runtime_store.save({
            old.resource_id: RuntimeRecord(
                resource_id=old.resource_id,
                hardware_uuid=old.hardware_uuid,
                runtime_generation=runtime_generation if runtime_generation is not None else generation,
                state=runtime_state,
                pid=pid,
                executable_path="C:/approved/lolMiner.exe" if pid is not None else None,
                process_creation_token=creation_token,
            )
        })
        return old

    def _preempt(self, spec: RentalResourceSpec) -> GpuQuiescenceProof:
        return _preempt_with_recovery(self.supervisor, spec, _ORIGINAL_PREEMPT)

    def test_strictly_newer_authority_recovers_pidless_quarantine(self) -> None:
        old = self._seed_quarantine(generation=7)
        fresh = rental_spec(8, session="session_new0001")

        proof = self._preempt(fresh)

        self.assertEqual(proof.hardware_uuid, fresh.hardware_uuid)
        updated_claim = self.claim_store.load()[old.resource_id]
        self.assertEqual(updated_claim.session_id, fresh.session_id)
        self.assertEqual(updated_claim.lease_id, fresh.lease_id)
        self.assertEqual(updated_claim.runtime_generation, 8)
        self.assertEqual(updated_claim.state, "QUIESCENT")
        updated_runtime = self.runtime_store.load()[old.resource_id]
        self.assertEqual(updated_runtime.runtime_generation, 8)
        self.assertEqual(updated_runtime.state, "STOPPED")
        self.assertIsNone(updated_runtime.pid)
        self.assertIsNone(updated_runtime.process_creation_token)
        self.assertEqual(self.inspector.terminated, [])
        # Recovery proves physical safety before mutation, then the canonical
        # preemption path proves it again before accepting QUIESCENT.
        self.assertEqual(self.probe.calls, [fresh.hardware_uuid, fresh.hardware_uuid])
        self.assertEqual(self.binding_calls, [fresh.hardware_uuid, fresh.hardware_uuid])

    def test_equal_fence_from_different_session_cannot_clear_quarantine(self) -> None:
        old = self._seed_quarantine(generation=7)
        fresh = rental_spec(7, session="session_new0001")

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        self.assertEqual(self.claim_store.load()[old.resource_id], claim(old))
        self.assertEqual(self.runtime_store.load()[old.resource_id].state, "QUARANTINED")
        self.assertEqual(self.probe.calls, [])

    def test_older_fence_cannot_clear_quarantine(self) -> None:
        old = self._seed_quarantine(generation=7)
        fresh = rental_spec(6, session="session_new0001")

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        self.assertEqual(self.claim_store.load()[old.resource_id], claim(old))
        self.assertEqual(self.probe.calls, [])

    def test_reused_lease_id_cannot_clear_quarantine_even_with_newer_fence(self) -> None:
        old = self._seed_quarantine(generation=7)
        fresh = rental_spec(8, session="session_new0001", lease=old.lease_id)

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        self.assertEqual(self.claim_store.load()[old.resource_id], claim(old))
        self.assertEqual(self.probe.calls, [])

    def test_hardware_identity_change_never_recovers_old_claim(self) -> None:
        old = self._seed_quarantine(generation=7)
        fresh = rental_spec(8, session="session_new0001", hardware="GPU-bbbbbbbb")

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        self.assertEqual(self.claim_store.load()[old.resource_id], claim(old))
        self.assertEqual(self.binding_calls, [])
        self.assertEqual(self.probe.calls, [])

    def test_persisted_process_identity_keeps_recovery_fail_closed(self) -> None:
        old = self._seed_quarantine(
            generation=7,
            pid=4242,
            creation_token="creation-old",
        )
        fresh = rental_spec(8, session="session_new0001")

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        current = self.runtime_store.load()[old.resource_id]
        self.assertEqual(current.state, "QUARANTINED")
        self.assertEqual(current.pid, 4242)
        self.assertEqual(current.process_creation_token, "creation-old")
        self.assertEqual(self.probe.calls, [])
        self.assertEqual(self.inspector.terminated, [])

    def test_active_mining_runtime_is_never_auto_recovered(self) -> None:
        old = self._seed_quarantine(generation=7, runtime_state="MINING")
        fresh = rental_spec(8, session="session_new0001")

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        self.assertEqual(self.runtime_store.load()[old.resource_id].state, "MINING")
        self.assertEqual(self.probe.calls, [])

    def test_failed_fresh_quiescence_proof_mutates_nothing(self) -> None:
        old = self._seed_quarantine(generation=7)
        fresh = rental_spec(8, session="session_new0001")
        before_runtime = self.runtime_store.load()[old.resource_id]
        self.probe.failure = "rental_gpu_compute_processes_present"

        with self.assertRaisesRegex(ExecutionControlError, "rental_gpu_compute_processes_present"):
            self._preempt(fresh)

        self.assertEqual(self.claim_store.load()[old.resource_id], claim(old))
        self.assertEqual(self.runtime_store.load()[old.resource_id], before_runtime)
        self.assertEqual(self.binding_calls, [fresh.hardware_uuid])
        self.assertEqual(self.probe.calls, [fresh.hardware_uuid])

    def test_partial_recovery_runtime_at_new_fence_can_resume_safely(self) -> None:
        old = self._seed_quarantine(
            generation=7,
            runtime_generation=8,
            runtime_state="STOPPED",
        )
        fresh = rental_spec(8, session="session_new0001")

        proof = self._preempt(fresh)

        self.assertEqual(proof.hardware_uuid, fresh.hardware_uuid)
        updated_claim = self.claim_store.load()[old.resource_id]
        self.assertEqual(updated_claim.state, "QUIESCENT")
        self.assertEqual(updated_claim.runtime_generation, 8)
        self.assertEqual(self.runtime_store.load()[old.resource_id].state, "STOPPED")

    def test_intermediate_unknown_runtime_generation_remains_quarantined(self) -> None:
        old = self._seed_quarantine(
            generation=7,
            runtime_generation=8,
            runtime_state="STOPPED",
        )
        fresh = rental_spec(9, session="session_new0001")

        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_claim_conflict"):
            self._preempt(fresh)

        self.assertEqual(self.claim_store.load()[old.resource_id], claim(old))
        self.assertEqual(self.runtime_store.load()[old.resource_id].runtime_generation, 8)
        self.assertEqual(self.probe.calls, [])


if __name__ == "__main__":
    unittest.main()
