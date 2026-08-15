from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Callable
from unittest.mock import patch

from gpubnb_agent.execution_control import ExecutionControlError
from gpubnb_agent.gpu_rental_preemption import (
    GpuQuiescenceProof,
    GpuQuiescenceSample,
    NvidiaGpuQuiescenceProbe,
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


class FakeInspector:
    def __init__(self) -> None:
        self.identities: dict[int, ProcessIdentity] = {}
        self.terminated: list[ProcessIdentity] = []
        self.on_terminate: Callable[[ProcessIdentity], None] | None = None

    def inspect(self, pid: int) -> ProcessIdentity | None:
        return self.identities.get(pid)

    def terminate(self, identity: ProcessIdentity) -> None:
        if self.identities.get(identity.pid) != identity:
            raise ExecutionControlError("miner_process_identity_mismatch")
        if self.on_terminate is not None:
            self.on_terminate(identity)
        self.terminated.append(identity)
        self.identities.pop(identity.pid, None)


class FakeProbe:
    def __init__(self) -> None:
        self.fail_for: set[str] = set()
        self.calls: list[str] = []

    def prove(self, hardware_uuid: str) -> GpuQuiescenceProof:
        self.calls.append(hardware_uuid)
        if hardware_uuid in self.fail_for:
            raise ExecutionControlError("rental_gpu_compute_processes_present")
        sample = GpuQuiescenceSample(hardware_uuid, 0, 64, 24_576, ())
        return GpuQuiescenceProof(hardware_uuid, (sample, sample, sample), 512, 123456)


def spec(resource: str, hardware: str, generation: int, session: str = "session_00000001") -> RentalResourceSpec:
    return RentalResourceSpec(
        session_id=session,
        resource_id=resource,
        hardware_uuid=hardware,
        runtime_generation=generation,
        holder_id=f"rental:{session}",
        lease_id=f"lease_{resource}_abcdef",
        fencing_token=str(generation),
    )


def claim_for(rental: RentalResourceSpec, state: str) -> RentalClaimRecord:
    return RentalClaimRecord(
        session_id=rental.session_id,
        resource_id=rental.resource_id,
        hardware_uuid=rental.hardware_uuid,
        runtime_generation=rental.runtime_generation,
        holder_id=rental.holder_id,
        lease_id=rental.lease_id,
        fencing_token=rental.fencing_token,
        state=state,
        verified_at_ms=123456,
    )


class NvidiaQuiescenceProbeTests(unittest.TestCase):
    def test_compute_process_on_other_gpu_does_not_block_target_gpu(self) -> None:
        inventory = subprocess.CompletedProcess(
            ["nvidia-smi"], 0, "GPU-aaaaaaaa, 0, 64, 24576\n", ""
        )
        compute = subprocess.CompletedProcess(
            ["nvidia-smi"],
            0,
            "GPU-bbbbbbbb, 9001, 8192\nGPU-aaaaaaaa, 0, 0\n",
            "",
        )
        with (
            patch("gpubnb_agent.gpu_rental_preemption.find_nvidia_smi", return_value="nvidia-smi"),
            patch("gpubnb_agent.gpu_rental_preemption.run_command", side_effect=[inventory, compute]),
        ):
            sample = NvidiaGpuQuiescenceProbe().sample("GPU-aaaaaaaa")
        self.assertEqual(sample.hardware_uuid, "GPU-aaaaaaaa")
        self.assertEqual(sample.compute_pids, ())
        self.assertEqual(sample.utilization_percent, 0)
        self.assertEqual(sample.memory_used_mib, 64)

    def test_compute_process_on_target_gpu_blocks_quiescence(self) -> None:
        probe = NvidiaGpuQuiescenceProbe()
        sample = GpuQuiescenceSample("GPU-aaaaaaaa", 0, 64, 24_576, (9001,))
        with patch.object(probe, "sample", return_value=sample):
            with self.assertRaisesRegex(ExecutionControlError, "rental_gpu_compute_processes_present"):
                probe.prove("GPU-aaaaaaaa")


class RentalPreemptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.runtime_store = RuntimeStore(root / "runtime.json")
        self.claim_store = RentalClaimStore(root / "rental.json")
        self.inspector = FakeInspector()
        self.probe = FakeProbe()
        self.bindings = {
            "GPU-aaaaaaaa": GpuBinding("GPU-aaaaaaaa", "65:00", 300.0, 100.0),
            "GPU-bbbbbbbb": GpuBinding("GPU-bbbbbbbb", "66:00", 300.0, 100.0),
        }
        self.mining = GpuResourceSupervisor(
            store=self.runtime_store,
            inspector=self.inspector,
            binding_resolver=lambda hardware: self.bindings[hardware],
        )
        self.supervisor = RentalPreemptionSupervisor(
            mining=self.mining,
            claims=self.claim_store,
            probe=self.probe,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _seed_two_miners(self) -> tuple[ProcessIdentity, ProcessIdentity]:
        one = ProcessIdentity(1101, "/approved/lolMiner", "creation-a")
        two = ProcessIdentity(1102, "/approved/lolMiner", "creation-b")
        self.inspector.identities = {one.pid: one, two.pid: two}
        self.runtime_store.save({
            "resource_00000001": RuntimeRecord(
                resource_id="resource_00000001",
                hardware_uuid="GPU-aaaaaaaa",
                runtime_generation=7,
                state="MINING",
                pid=one.pid,
                executable_path=one.executable_path,
                process_creation_token=one.creation_token,
            ),
            "resource_00000002": RuntimeRecord(
                resource_id="resource_00000002",
                hardware_uuid="GPU-bbbbbbbb",
                runtime_generation=8,
                state="MINING",
                pid=two.pid,
                executable_path=two.executable_path,
                process_creation_token=two.creation_token,
            ),
        })
        return one, two

    def test_preempting_gpu_a_never_stops_gpu_b(self) -> None:
        one, two = self._seed_two_miners()
        proof = self.supervisor.preempt_for_rental(spec("resource_00000001", "GPU-aaaaaaaa", 9))

        self.assertEqual(proof.hardware_uuid, "GPU-aaaaaaaa")
        self.assertEqual(self.inspector.terminated, [one])
        self.assertNotIn(one.pid, self.inspector.identities)
        self.assertEqual(self.inspector.identities[two.pid], two)
        records = self.runtime_store.load()
        self.assertEqual(records["resource_00000001"].state, "STOPPED")
        self.assertEqual(records["resource_00000001"].runtime_generation, 9)
        self.assertEqual(records["resource_00000002"].state, "MINING")
        self.assertEqual(records["resource_00000002"].runtime_generation, 8)
        self.assertEqual(self.probe.calls, ["GPU-aaaaaaaa"])
        self.assertEqual(self.claim_store.load()["resource_00000001"].state, "QUIESCENT")

    def test_preempting_claim_is_persisted_before_owned_process_termination(self) -> None:
        self._seed_two_miners()
        observed_states: list[str] = []
        self.inspector.on_terminate = lambda _identity: observed_states.append(
            self.claim_store.load()["resource_00000001"].state
        )

        self.supervisor.preempt_for_rental(spec("resource_00000001", "GPU-aaaaaaaa", 9))

        self.assertEqual(observed_states, ["PREEMPTING"])

    def test_restart_resumes_same_preemption_if_owned_process_already_died(self) -> None:
        one, two = self._seed_two_miners()
        rental = spec("resource_00000001", "GPU-aaaaaaaa", 9)
        self.claim_store.save({rental.resource_id: claim_for(rental, "PREEMPTING")})
        self.inspector.identities.pop(one.pid)

        proof = self.supervisor.preempt_for_rental(rental)

        self.assertEqual(proof.hardware_uuid, "GPU-aaaaaaaa")
        self.assertEqual(self.inspector.terminated, [])
        self.assertEqual(self.inspector.identities[two.pid], two)
        self.assertEqual(self.runtime_store.load()[rental.resource_id].runtime_generation, 9)
        self.assertEqual(self.runtime_store.load()[rental.resource_id].state, "STOPPED")
        self.assertEqual(self.claim_store.load()[rental.resource_id].state, "QUIESCENT")

    def test_local_rental_claim_blocks_inflight_start_and_stop_mutations(self) -> None:
        rental = spec("resource_00000001", "GPU-aaaaaaaa", 9)
        self.claim_store.save({rental.resource_id: claim_for(rental, "PREEMPTING")})
        payload = {"resourceId": rental.resource_id, "hardwareUuid": rental.hardware_uuid}

        with patch("gpubnb_agent.gpu_rental_preemption._DEFAULT_CLAIMS", self.claim_store):
            with self.assertRaisesRegex(ExecutionControlError, "mining_resource_owned_by_rental"):
                self.mining.start(payload, "command_00000001")
            with self.assertRaisesRegex(ExecutionControlError, "mining_resource_owned_by_rental"):
                self.mining.stop(payload)

    def test_pid_reuse_quarantines_target_without_killing_unknown_process(self) -> None:
        one, two = self._seed_two_miners()
        self.inspector.identities[one.pid] = ProcessIdentity(one.pid, one.executable_path, "reused")

        with self.assertRaisesRegex(ExecutionControlError, "rental_miner_process_identity_mismatch"):
            self.supervisor.preempt_for_rental(spec("resource_00000001", "GPU-aaaaaaaa", 9))

        self.assertEqual(self.inspector.terminated, [])
        self.assertIn(one.pid, self.inspector.identities)
        self.assertEqual(self.inspector.identities[two.pid], two)
        self.assertEqual(self.runtime_store.load()["resource_00000001"].state, "QUARANTINED")
        self.assertEqual(self.claim_store.load()["resource_00000001"].state, "QUARANTINED")

    def test_quiescence_failure_blocks_only_target_resource(self) -> None:
        one, two = self._seed_two_miners()
        self.probe.fail_for.add("GPU-aaaaaaaa")
        with self.assertRaisesRegex(ExecutionControlError, "rental_gpu_compute_processes_present"):
            self.supervisor.preempt_for_rental(spec("resource_00000001", "GPU-aaaaaaaa", 9))

        self.assertEqual(self.inspector.terminated, [one])
        self.assertEqual(self.inspector.identities[two.pid], two)
        records = self.runtime_store.load()
        self.assertEqual(records["resource_00000001"].state, "QUARANTINED")
        self.assertEqual(records["resource_00000002"].state, "MINING")

    def test_cleanup_releases_claim_after_second_target_only_quiescence_proof(self) -> None:
        self._seed_two_miners()
        rental = spec("resource_00000001", "GPU-aaaaaaaa", 9)
        self.supervisor.preempt_for_rental(rental)
        self.supervisor.mark_rental_active(rental)
        self.probe.calls.clear()

        released = self.supervisor.release_after_cleanup(rental.session_id)
        self.assertEqual([claim.resource_id for claim in released], ["resource_00000001"])
        self.assertEqual(self.probe.calls, ["GPU-aaaaaaaa"])
        self.assertEqual(self.claim_store.load(), {})
        self.assertEqual(self.runtime_store.load()["resource_00000002"].state, "MINING")

    def test_stale_rental_fence_cannot_preempt_newer_mining_generation(self) -> None:
        self._seed_two_miners()
        records = self.runtime_store.load()
        records["resource_00000001"].runtime_generation = 12
        self.runtime_store.save(records)
        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_fence_stale"):
            self.supervisor.preempt_for_rental(spec("resource_00000001", "GPU-aaaaaaaa", 11))
        self.assertEqual(self.inspector.terminated, [])


if __name__ == "__main__":
    unittest.main()
