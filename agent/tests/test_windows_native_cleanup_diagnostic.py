from __future__ import annotations

import threading
import unittest
from unittest.mock import Mock, patch

from gpubnb_agent.cli import poll_and_run_diagnostic_once
from gpubnb_agent.physical_gpu_authority import PHYSICAL_GPU_LOCK
from gpubnb_agent.runtime_cleanliness import RuntimeCleanlinessReport


class NativeCleanupDiagnosticTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target = {"sessionId": "session_retired_01", "resourceId": "resource_native_01",
                       "hardwareUuid": "GPU-aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"}
        self.pending = {"diagnosticRunId": "diagnostic_native_01",
                        "diagnosticImage": "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + "a" * 64,
                        "timeoutSeconds": 120, "expectedRuntimeSessionIds": [],
                        "nativeCleanupRequired": True, "nativeCleanupProtocolVersion": 1,
                        "nativeCleanupTarget": self.target}
        self.timeline: list[str] = []
        self.posts: list[dict] = []
        self.events: list[dict] = []
        self.recovery = Mock(target=self.target)
        self.recovery.prepare.side_effect = lambda: self.timeline.append("prepare")
        self.recovery.finish.side_effect = self.finish
        self.addCleanup(patch.stopall)
        self.factory = patch("gpubnb_agent.cli.NativeQuarantineRecovery", return_value=self.recovery).start()
        self.request = patch("gpubnb_agent.cli.agent_request", side_effect=self.api_request).start()
        self.inspect = patch("gpubnb_agent.cli.inspect_runtime_cleanliness",
                             return_value=RuntimeCleanlinessReport((), (), ())).start()
        self.gpu = patch("gpubnb_agent.cli.run_gpu_diagnostic", side_effect=self.gpu_diagnostic).start()

    def api_request(self, _api, _key, _machine, path, method="GET", body=None):
        if method == "GET":
            return self.pending
        if path.endswith("/native-cleanup-authority"):
            self.timeline.append("authority")
            return {"allowed": True}
        self.posts.append(body)
        self.timeline.append("post")
        return {"ok": True}

    def finish(self):
        self.timeline.append("finish")
        return {"protocolVersion": 1, **self.target, "fenceFloor": "92", "helperStopped": True,
                "gpuQuiescent": True, "remainingRentalResourceIds": [], "unsafeRuntimeResourceIds": []}

    def gpu_diagnostic(self, _image, _timeout):
        self.timeline.append("gpu")
        return {"gpuDetected": True, "summary": "ok", "metrics": {"firstGpuUuid": self.target["hardwareUuid"]}}

    def poll(self):
        poll_and_run_diagnostic_once(Mock(), object(), "machine_native_01", event_sink=self.events.append)

    def test_prepare_gpu_finish_and_signed_result_use_existing_diagnostic_without_booking(self) -> None:
        self.poll()
        self.assertEqual(self.timeline, ["prepare", "gpu", "finish", "post"])
        self.assertEqual(self.posts[0]["nativeRuntimeCleanup"]["fenceFloor"], "92")
        self.assertEqual(self.posts[0]["runtimeCleanliness"], {
            "unexpectedContainers": [], "unexpectedVolumes": [], "unexpectedNetworks": [], "expectedSessionIds": []})
        self.assertTrue(all("/diagnostics/" in call.args[3] for call in self.request.call_args_list))
        self.assertIn("native_cleanup_completed", [event["event"] for event in self.events])

    def test_authority_request_is_bound_to_machine_scope_and_canonical_generation(self) -> None:
        self.recovery.prepare.side_effect = lambda: self.factory.call_args.args[2]({**self.target, "runtimeGeneration": "90"})
        self.poll()
        authority = next(call for call in self.request.call_args_list if call.args[3].endswith("/native-cleanup-authority"))
        self.assertEqual(authority.args[4], "POST")
        self.assertEqual(authority.args[5], {"machineId": "machine_native_01", **self.target, "runtimeGeneration": "90"})

    def test_failed_prepare_prevents_any_gpu_diagnostic_and_keeps_native_proof_absent(self) -> None:
        self.recovery.prepare.side_effect = RuntimeError("native_cleanup_authority_refused")
        self.poll()
        self.inspect.assert_not_called()
        self.gpu.assert_not_called()
        self.recovery.finish.assert_not_called()
        self.assertIn("native_cleanup_authority_refused", self.posts[0]["error"])
        self.assertNotIn("nativeRuntimeCleanup", self.posts[0])

    def test_failed_gpu_diagnostic_never_retires_claim(self) -> None:
        self.gpu.side_effect = RuntimeError("diagnostic_cleanup_unverified")
        self.poll()
        self.recovery.prepare.assert_called_once()
        self.recovery.finish.assert_not_called()
        self.assertIn("diagnostic_cleanup_unverified", self.posts[0]["error"])

    def test_dirty_docker_inventory_or_wrong_gpu_never_retires_claim(self) -> None:
        self.inspect.return_value = RuntimeCleanlinessReport(("gpubnb-orphan",), (), ())
        self.poll()
        self.recovery.finish.assert_not_called()
        self.assertEqual(self.posts[-1]["error"], "native_cleanup_docker_resources_present")
        self.inspect.return_value = RuntimeCleanlinessReport((), (), ())
        self.gpu.side_effect = None
        self.gpu.return_value = {"gpuDetected": True, "metrics": {"firstGpuUuid": "GPU-other"}}
        self.poll()
        self.recovery.finish.assert_not_called()
        self.assertEqual(self.posts[-1]["error"], "native_cleanup_diagnostic_gpu_mismatch")

    def test_failed_final_stop_does_not_report_success(self) -> None:
        self.recovery.finish.side_effect = RuntimeError("native_workspace_stop_unconfirmed")
        self.poll()
        self.assertIn("native_workspace_stop_unconfirmed", self.posts[0]["error"])
        self.assertNotIn("nativeRuntimeCleanup", self.posts[0])

    def test_unknown_protocol_or_live_session_assignment_never_touches_hardware(self) -> None:
        for change in ({"nativeCleanupRequired": "true"}, {"nativeCleanupProtocolVersion": True},
                       {"nativeCleanupProtocolVersion": 2}, {"expectedRuntimeSessionIds": ["session_live_01"]},
                       {"expectedRuntimeSessionIds": None}):
            with self.subTest(change=change):
                old = dict(self.pending)
                self.pending.update(change)
                self.poll()
                self.assertEqual(self.posts[-1]["error"], "native_cleanup_assignment_unverified")
                self.pending = old
        self.factory.assert_not_called()
        self.gpu.assert_not_called()

    def test_physical_lock_excludes_heartbeat_probe_through_signed_result_post(self) -> None:
        held: list[bool] = []

        def assert_other_thread_blocked():
            def attempt():
                acquired = PHYSICAL_GPU_LOCK.acquire(blocking=False)
                held.append(not acquired)
                if acquired:
                    PHYSICAL_GPU_LOCK.release()
            thread = threading.Thread(target=attempt)
            thread.start()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

        self.recovery.prepare.side_effect = assert_other_thread_blocked
        def gpu(_image, _timeout):
            assert_other_thread_blocked()
            return self.gpu_diagnostic(_image, _timeout)
        self.gpu.side_effect = gpu
        original_request = self.api_request
        def api(*args, **kwargs):
            if len(args) > 4 and args[4] == "POST":
                assert_other_thread_blocked()
            return original_request(*args, **kwargs)
        self.request.side_effect = api
        self.poll()
        self.assertEqual(held, [True, True, True])
        assert_other_thread_blocked()
        self.assertFalse(held[-1])


if __name__ == "__main__":
    unittest.main()
