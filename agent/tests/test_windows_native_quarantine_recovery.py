from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from gpubnb_agent.execution_control import ExecutionControlError
from gpubnb_agent.gpu_rental_preemption import (
    GpuQuiescenceProof, GpuQuiescenceSample, RentalClaimRecord, RentalClaimStore,
    RentalPreemptionSupervisor, RentalResourceSpec,
)
from gpubnb_agent.gpu_resource_supervisor import GpuBinding, GpuResourceSupervisor, RuntimeRecord, RuntimeStore
from gpubnb_agent.windows_native_quarantine_recovery import NativeQuarantineRecovery

GPU = "GPU-aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"
TARGET = {"sessionId": "session_retired_01", "resourceId": "resource_native_01", "hardwareUuid": GPU}
RUN = "diagnostic_native_01"


class NativeQuarantineRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.claims = RentalClaimStore(Path(self.temp.name) / "gpu-resource-rental-v1.json")
        self.runtime = RuntimeStore(Path(self.temp.name) / "gpu-resource-runtime-v1.json")
        self.claim = RentalClaimRecord(
            TARGET["sessionId"], TARGET["resourceId"], GPU, 90, f"rental:{TARGET['sessionId']}",
            "lease_retired_native_01", "90", "QUARANTINED", 123,
        )
        self.record = RuntimeRecord(TARGET["resourceId"], GPU, 90, "QUARANTINED")
        self.claims.save({self.claim.resource_id: self.claim})
        self.runtime.save({self.record.resource_id: self.record})
        self.binding = Mock(return_value=GpuBinding(GPU, "0000:01:00.0", None, None))
        self.mining = GpuResourceSupervisor(store=self.runtime, binding_resolver=self.binding)
        self.probe = Mock()
        sample = GpuQuiescenceSample(GPU, 0, 64, 4096, ())
        self.probe.prove.return_value = GpuQuiescenceProof(GPU, (sample, sample, sample), 256, 456)
        self.supervisor = RentalPreemptionSupervisor(mining=self.mining, claims=self.claims, probe=self.probe)
        self.stop = Mock()
        self.floor = "92"
        self.authorize = Mock(side_effect=self.approval)
        self.addCleanup(patch.stopall)
        patch("gpubnb_agent.windows_native_quarantine_recovery.platform.system", return_value="Windows").start()
        self.unfence = patch("gpubnb_agent.windows_native_quarantine_recovery.native_rental_physical_cleanup_confirmed").start()

    def approval(self, _scope):
        return {"protocolVersion": 1, "diagnosticRunId": RUN, **TARGET, "allowed": True, "fenceFloor": self.floor}

    def recovery(self) -> NativeQuarantineRecovery:
        return NativeQuarantineRecovery(RUN, TARGET, self.authorize, supervisor=self.supervisor, stop=self.stop)

    def bytes(self) -> tuple[bytes, bytes]:
        return self.claims.path.read_bytes(), self.runtime.path.read_bytes()

    def test_prepare_proves_stop_and_gpu_without_changing_quarantine(self) -> None:
        before = self.bytes()
        self.recovery().prepare()
        self.assertEqual(before, self.bytes())
        self.stop.assert_called_once_with(TARGET["sessionId"])
        self.binding.assert_called_once_with(GPU)
        self.probe.prove.assert_called_once_with(GPU)
        self.assertEqual([c.args[0]["runtimeGeneration"] for c in self.authorize.call_args_list], ["90", "92"])
        self.unfence.assert_not_called()

    def test_default_constructor_preserves_unsafe_records_before_diagnostic_authorization(self) -> None:
        # The production constructor used to reconcile MINING -> QUARANTINED
        # before _snapshot(), making an unsafe original state look recoverable.
        self.runtime.save({self.record.resource_id: replace(self.record, state="MINING")})
        before = self.bytes()
        with (patch("gpubnb_agent.gpu_resource_supervisor.RuntimeStore", return_value=self.runtime),
              patch("gpubnb_agent.gpu_rental_preemption.RentalClaimStore", return_value=self.claims),
              patch("gpubnb_agent.gpu_resource_supervisor.SystemProcessInspector") as inspector):
            recovery = NativeQuarantineRecovery(RUN, TARGET, self.authorize, stop=self.stop)
            self.assertEqual(self.bytes(), before)
            with self.assertRaisesRegex(ExecutionControlError, "runtime_process_unverified"):
                recovery.prepare()
        self.assertEqual(self.bytes(), before)
        self.authorize.assert_not_called()
        self.stop.assert_not_called()
        inspector.return_value.inspect.assert_not_called()

    def test_finish_reproves_and_releases_preserving_server_floor_and_files(self) -> None:
        recovery = self.recovery()
        recovery.prepare()
        with patch.object(self.supervisor, "release_after_cleanup", wraps=self.supervisor.release_after_cleanup) as release:
            report = recovery.finish()
        release.assert_called_once_with(TARGET["sessionId"])
        self.assertEqual(self.stop.call_count, 2)
        self.assertEqual(self.probe.prove.call_count, 3)  # prepare, finish, canonical release
        self.assertEqual(report, {"protocolVersion": 1, **TARGET, "fenceFloor": "92",
                                 "helperStopped": True, "gpuQuiescent": True,
                                 "remainingRentalResourceIds": [], "unsafeRuntimeResourceIds": []})
        self.assertEqual(self.claims.load(), {})
        current = self.runtime.load()[TARGET["resourceId"]]
        self.assertEqual((current.runtime_generation, current.state), (92, "STOPPED"))
        self.assertIsNone(current.pid)
        self.assertTrue(self.claims.path.exists())
        self.assertTrue(self.runtime.path.exists())
        self.unfence.assert_called_once_with(TARGET["sessionId"])

    def test_terminal_active_claim_with_stopped_runtime_requires_full_proof(self) -> None:
        # Exact production incident: native STOP failed, server retired the
        # allocation, local rental fence persisted RENTAL_ACTIVE, runtime STOPPED.
        self.claims.save({self.claim.resource_id: replace(self.claim, state="RENTAL_ACTIVE")})
        self.runtime.save({self.record.resource_id: replace(self.record, state="STOPPED")})
        before = self.bytes()
        recovery = self.recovery()
        recovery.prepare()
        self.assertEqual(self.bytes(), before, "prepare must never erase active claims")
        self.authorize.assert_called()
        self.stop.assert_called_once_with(TARGET["sessionId"])
        self.probe.prove.assert_called_once_with(GPU)
        recovery.finish()
        self.assertEqual(self.claims.load(), {})
        self.assertEqual(self.runtime.load()[TARGET["resourceId"]].state, "STOPPED")
        self.assertEqual(self.runtime.load()[TARGET["resourceId"]].runtime_generation, 92)
        self.assertEqual(self.stop.call_count, 2)
        self.unfence.assert_called_once_with(TARGET["sessionId"])

    def test_terminal_active_claim_server_refusal_preserves_fence(self) -> None:
        self.claims.save({self.claim.resource_id: replace(self.claim, state="RENTAL_ACTIVE")})
        self.runtime.save({self.record.resource_id: replace(self.record, state="STOPPED")})
        before = self.bytes()
        self.authorize.side_effect = None
        self.authorize.return_value = {**self.approval({}), "allowed": False}
        with self.assertRaisesRegex(ExecutionControlError, "authority_refused"):
            self.recovery().prepare()
        self.assertEqual(self.bytes(), before)
        self.stop.assert_not_called()
        self.probe.prove.assert_not_called()

    def test_terminal_active_claim_failed_stop_preserves_fence(self) -> None:
        self.claims.save({self.claim.resource_id: replace(self.claim, state="RENTAL_ACTIVE")})
        self.runtime.save({self.record.resource_id: replace(self.record, state="STOPPED")})
        before = self.bytes()
        self.stop.side_effect = RuntimeError("native_workspace_stop_failed")
        with self.assertRaisesRegex(RuntimeError, "native_workspace_stop_failed"):
            self.recovery().prepare()
        self.assertEqual(self.bytes(), before)
        self.probe.prove.assert_not_called()
        self.unfence.assert_not_called()

    def test_no_finish_without_a_fresh_prepare(self) -> None:
        before = self.bytes()
        with self.assertRaisesRegex(ExecutionControlError, "native_cleanup_not_prepared"):
            self.recovery().finish()
        self.assertEqual(self.bytes(), before)

    def test_scope_and_platform_must_be_verified_before_any_physical_action(self) -> None:
        for target in (None, {}, {**TARGET, "hardwareUuid": "GPU-index-0"}, {**TARGET, "extra": True}):
            with self.subTest(target=target), self.assertRaisesRegex(ExecutionControlError, "scope_unverified"):
                NativeQuarantineRecovery(RUN, target, self.authorize, supervisor=self.supervisor, stop=self.stop)
        with patch("gpubnb_agent.windows_native_quarantine_recovery.platform.system", return_value="Linux"):
            with self.assertRaisesRegex(ExecutionControlError, "windows_required"):
                self.recovery()
        self.stop.assert_not_called()

    def test_invalid_or_denied_authority_never_stops_or_mutates(self) -> None:
        good = self.approval({})
        variants = [None, {}, {**good, "allowed": False}, {**good, "allowed": 1},
                    {**good, "protocolVersion": True}, {**good, "diagnosticRunId": "different_run_01"},
                    {**good, "sessionId": "different_session_01"}, {**good, "resourceId": "different_resource_01"},
                    {**good, "hardwareUuid": "GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]
        for decision in variants:
            with self.subTest(decision=decision):
                self.authorize.side_effect = None
                self.authorize.return_value = decision
                before = self.bytes()
                with self.assertRaisesRegex(ExecutionControlError, "authority_refused"):
                    self.recovery().prepare()
                self.assertEqual(self.bytes(), before)
        self.stop.assert_not_called()

    def test_malformed_or_regressed_fence_is_never_accepted(self) -> None:
        for floor in (90, True, "0", "090", "89", "1e2", "9223372036854775808"):
            with self.subTest(floor=floor):
                self.floor = floor
                before = self.bytes()
                with self.assertRaises(ExecutionControlError):
                    self.recovery().prepare()
                self.assertEqual(self.bytes(), before)
        self.stop.assert_not_called()

    def test_authoritative_int64_fence_above_javascript_precision_stays_exact(self) -> None:
        self.floor = "9223372036854775807"
        recovery = self.recovery()
        recovery.prepare()
        self.assertEqual(recovery.finish()["fenceFloor"], self.floor)
        self.assertEqual(self.runtime.load()[TARGET["resourceId"]].runtime_generation, int(self.floor))

    def test_stop_failure_or_busy_gpu_preserves_original_quarantine(self) -> None:
        before = self.bytes()
        self.stop.side_effect = RuntimeError("native_workspace_stop_failed:virtual_display_not_ready")
        with self.assertRaisesRegex(RuntimeError, "native_workspace_stop_failed"):
            self.recovery().prepare()
        self.probe.prove.assert_not_called()
        self.stop.side_effect = None
        self.probe.prove.side_effect = ExecutionControlError("rental_gpu_compute_processes_present")
        with self.assertRaisesRegex(ExecutionControlError, "rental_gpu_compute_processes_present"):
            self.recovery().prepare()
        self.assertEqual(self.bytes(), before)

    def test_binding_mismatch_is_not_a_cleanup_proof(self) -> None:
        self.binding.return_value = GpuBinding("GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "0000:02:00.0", None, None)
        before = self.bytes()
        with self.assertRaisesRegex(ExecutionControlError, "gpu_binding_mismatch"):
            self.recovery().prepare()
        self.assertEqual(self.bytes(), before)
        self.probe.prove.assert_not_called()

    def test_identity_bearing_or_active_runtime_never_gets_erased(self) -> None:
        for fields in ({"pid": 1234}, {"process_creation_token": "creation-id"},
                       {"command_id": "mining_command_01"}, {"state": "MINING"},
                       {"runtime_generation": 89}, {"hardware_uuid": "GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}):
            with self.subTest(fields=fields):
                self.runtime.save({self.record.resource_id: replace(self.record, **fields)})
                before = self.bytes()
                with self.assertRaises(ExecutionControlError):
                    self.recovery().prepare()
                self.assertEqual(self.bytes(), before)
        self.authorize.assert_not_called()
        self.stop.assert_not_called()

    def test_active_foreign_or_wrong_holder_claim_blocks_cleanup(self) -> None:
        for fields in ({"state": "RENTAL_ACTIVE"}, {"state": "PREEMPTING"},
                       {"session_id": "other_session_01"}, {"holder_id": "mining:resource_native_01"}):
            with self.subTest(fields=fields):
                self.claims.save({self.claim.resource_id: replace(self.claim, **fields)})
                before = self.bytes()
                with self.assertRaisesRegex(ExecutionControlError, "claim_authority_unverified"):
                    self.recovery().prepare()
                self.assertEqual(self.bytes(), before)
        self.stop.assert_not_called()

    def test_other_resource_claim_or_unsafe_runtime_blocks_windows_global_cleanup(self) -> None:
        other = replace(self.claim, resource_id="resource_other_01")
        self.claims.save({self.claim.resource_id: self.claim, other.resource_id: other})
        with self.assertRaisesRegex(ExecutionControlError, "claim_authority_unverified"):
            self.recovery().prepare()
        self.claims.save({self.claim.resource_id: self.claim})
        other_runtime = replace(self.record, resource_id="resource_other_01")
        self.runtime.save({self.record.resource_id: self.record, other_runtime.resource_id: other_runtime})
        with self.assertRaisesRegex(ExecutionControlError, "runtime_process_unverified"):
            self.recovery().prepare()
        self.stop.assert_not_called()

    def test_changed_authority_after_prepare_preserves_claim(self) -> None:
        recovery = self.recovery()
        recovery.prepare()
        before = self.bytes()
        self.floor = "93"
        with self.assertRaisesRegex(ExecutionControlError, "authority_changed"):
            recovery.finish()
        self.assertEqual(self.bytes(), before)

    def test_local_snapshot_change_during_stop_or_diagnostic_is_detected(self) -> None:
        self.stop.side_effect = lambda _session: self.runtime.save({self.record.resource_id: replace(self.record, updated_at_ms=999)})
        with self.assertRaisesRegex(ExecutionControlError, "local_authority_changed"):
            self.recovery().prepare()
        self.assertEqual(self.claims.load()[self.claim.resource_id].state, "QUARANTINED")
        self.stop.side_effect = None
        recovery = self.recovery()
        recovery.prepare()
        self.claims.save({self.claim.resource_id: replace(self.claim, verified_at_ms=888)})
        with self.assertRaisesRegex(ExecutionControlError, "local_authority_changed"):
            recovery.finish()

    def test_crash_after_runtime_advance_retries_without_dropping_floor(self) -> None:
        self.runtime.save({self.record.resource_id: replace(self.record, state="STOPPED", runtime_generation=92)})
        recovery = self.recovery()
        recovery.prepare()
        recovery.finish()
        self.assertEqual(self.runtime.load()[self.record.resource_id].runtime_generation, 92)
        self.assertEqual(self.claims.load(), {})

    def test_failed_canonical_release_retains_fence_and_can_be_reproved(self) -> None:
        recovery = self.recovery()
        recovery.prepare()
        self.probe.prove.side_effect = [self.probe.prove.return_value, ExecutionControlError("rental_gpu_utilization_not_quiescent")]
        with self.assertRaisesRegex(ExecutionControlError, "rental_gpu_utilization_not_quiescent"):
            recovery.finish()
        self.assertEqual(self.runtime.load()[self.record.resource_id].runtime_generation, 92)
        self.assertEqual(self.claims.load()[self.claim.resource_id].state, "QUIESCENT")
        self.unfence.assert_not_called()
        self.probe.prove.side_effect = None
        retry = self.recovery()
        retry.prepare()
        retry.finish()
        self.assertEqual(self.claims.load(), {})

    def test_lost_result_can_reprove_after_release_without_recreating_claim(self) -> None:
        recovery = self.recovery()
        recovery.prepare()
        recovery.finish()
        retry = self.recovery()
        retry.prepare()
        retry.finish()
        self.assertEqual(self.claims.load(), {})
        self.assertEqual(self.runtime.load()[self.record.resource_id].runtime_generation, 92)

    def test_retired_rental_fence_rejects_equal_replay_but_newer_rental_can_start(self) -> None:
        recovery = self.recovery()
        recovery.prepare()
        recovery.finish()
        rental = RentalResourceSpec("session_next_01", self.record.resource_id, GPU, 92,
                                    "rental:session_next_01", "lease_next_native_01", "92")
        before = self.bytes()
        with self.assertRaisesRegex(ExecutionControlError, "rental_resource_generation_replay"):
            self.supervisor.preempt_for_rental(rental)
        self.assertEqual(self.bytes(), before)
        self.supervisor.preempt_for_rental(replace(rental, runtime_generation=93, fencing_token="93"))
        self.assertEqual(self.claims.load()[self.record.resource_id].state, "QUIESCENT")

    def test_exact_preempting_crash_marker_can_still_resume_equal_generation(self) -> None:
        self.runtime.save({self.record.resource_id: replace(self.record, state="STOPPED")})
        self.claims.save({self.claim.resource_id: replace(self.claim, state="PREEMPTING")})
        spec = RentalResourceSpec(self.claim.session_id, self.claim.resource_id, GPU, 90,
                                  self.claim.holder_id, self.claim.lease_id, self.claim.fencing_token)
        self.supervisor.preempt_for_rental(spec)
        self.assertEqual(self.claims.load()[self.claim.resource_id].state, "QUIESCENT")


if __name__ == "__main__":
    unittest.main()
