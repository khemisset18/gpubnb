from __future__ import annotations

import unittest
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent import windows_native_capability as capability
from gpubnb_agent.windows_native_workspace import NativeDesktopPreflight
from gpubnb_agent.gpu_rental_preemption import RentalClaimRecord, RentalClaimStore, _resource_transition_lock
from gpubnb_agent.gpu_resource_supervisor import RuntimeRecord, RuntimeStore


class WindowsNativeCapabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.config = patch.dict("os.environ", {"GPUBNB_CONFIG_DIR": self.root.name})
        self.config.start()
        self.addCleanup(self.config.stop)
        capability.invalidate_native_desktop_capability_cache()

    def tearDown(self) -> None:
        capability.invalidate_native_desktop_capability_cache()

    def test_persisted_rental_states_fence_probe_after_agent_restart(self):
        store = RentalClaimStore()
        for state in ("PREEMPTING", "QUIESCENT", "RENTAL_ACTIVE", "QUARANTINED"):
            with self.subTest(state=state):
                record = RentalClaimRecord(
                    "old_session", "resource_one", "GPU-aaaaaaaa", 90,
                    "rental:old_session", "old_lease", "90", state, 1,
                )
                store.save({record.resource_id: record})
                before = store.path.read_bytes()
                self.assertFalse(capability._FENCED_NATIVE_RENTALS)
                with (
                    patch.object(capability.platform, "system", return_value="Windows"),
                    patch.object(capability, "find_stream_helper", return_value=None),
                    patch.object(capability, "windows_native_desktop_preflight") as preflight,
                ):
                    result = capability.probe_native_desktop_capability(force=True)
                self.assertEqual(result.reason, "native_rental_fenced")
                preflight.assert_not_called()
                self.assertEqual(store.path.read_bytes(), before)

    def test_durable_claim_overrides_fresh_ready_cache(self):
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value=None),
            patch.object(capability, "windows_native_desktop_preflight", return_value=NativeDesktopPreflight(True, "ready")) as preflight,
        ):
            self.assertTrue(capability.probe_native_desktop_capability().available)
            RentalClaimStore().save({"resource_one": RentalClaimRecord(
                "old_session", "resource_one", "GPU-aaaaaaaa", 90,
                "rental:old_session", "old_lease", "90", "QUARANTINED", 1,
            )})
            result = capability.probe_native_desktop_capability()
        self.assertEqual(result.reason, "native_rental_fenced")
        self.assertEqual(preflight.call_count, 1)

    def test_runtime_quarantine_or_process_identity_blocks_probe_without_claim(self):
        store = RuntimeStore()
        for state, pid, token in (("QUARANTINED", None, None), ("MINING", 123, "creation"), ("STOPPED", 123, None), ("STOPPED", None, "creation")):
            with self.subTest(state=state, pid=pid, token=token):
                store.save({"resource_one": RuntimeRecord(
                    "resource_one", "GPU-aaaaaaaa", 90, state,
                    pid=pid, process_creation_token=token,
                )})
                with (
                    patch.object(capability.platform, "system", return_value="Windows"),
                    patch.object(capability, "find_stream_helper", return_value=None),
                    patch.object(capability, "windows_native_desktop_preflight") as preflight,
                ):
                    result = capability.probe_native_desktop_capability(force=True)
                self.assertEqual(result.reason, "native_gpu_runtime_fenced")
                preflight.assert_not_called()

    def test_corrupt_claim_or_runtime_blocks_probe_without_rewriting_evidence(self):
        for filename in ("gpu-resource-rental-v1.json", "gpu-resource-runtime-v1.json"):
            with self.subTest(filename=filename):
                path = Path(self.root.name) / filename
                path.write_bytes(b"\xffinvalid")
                with (
                    patch.object(capability.platform, "system", return_value="Windows"),
                    patch.object(capability, "find_stream_helper", return_value=None),
                    patch.object(capability, "windows_native_desktop_preflight") as preflight,
                ):
                    result = capability.probe_native_desktop_capability()
                self.assertEqual(result.reason, "native_resource_state_unverified")
                preflight.assert_not_called()
                self.assertEqual(path.read_bytes(), b"\xffinvalid")
                path.unlink()  # Test fixture only.

    def test_heartbeat_returns_while_windows_gpu_transition_holds_physical_authority(self):
        held = threading.Event()
        release = threading.Event()

        def launch():
            with patch("gpubnb_agent.gpu_rental_preemption.os.name", "nt"), _resource_transition_lock("resource_one"):
                held.set()
                release.wait(5)

        owner = threading.Thread(target=launch)
        owner.start()
        try:
            self.assertTrue(held.wait(2))
            with (
                patch.object(capability.platform, "system", return_value="Windows"),
                patch.object(capability, "windows_native_desktop_preflight") as preflight,
            ):
                result = capability.probe_native_desktop_capability()
            self.assertEqual(result.reason, "native_rental_fenced")
            self.assertFalse(release.is_set())
            preflight.assert_not_called()
        finally:
            release.set()
            owner.join(2)

    def test_live_rental_fence_prevents_heartbeat_self_test_even_with_expired_cache(self):
        class Owner:
            class Claims:
                @staticmethod
                def claims_for_session(_session_id):
                    return [object()]
            rental_preemption = Claims()

            @capability.fence_native_rental_launch
            def launch(self, session_id):
                return capability.probe_native_desktop_capability(clock=lambda: 101.0)

        try:
            with (
                patch.object(capability.platform, "system", return_value="Windows"),
                patch.object(capability, "find_stream_helper", return_value="helper.exe"),
                patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
                patch.object(capability, "windows_native_desktop_preflight") as preflight,
            ):
                during_launch = Owner().launch("test-session")
                after_launch = capability.probe_native_desktop_capability(
                    force=True, clock=lambda: 200.0
                )
            self.assertFalse(during_launch.available)
            self.assertEqual(during_launch.reason, "native_rental_fenced")
            self.assertFalse(after_launch.available)
            self.assertEqual(after_launch.reason, "native_rental_fenced")
            preflight.assert_not_called()
        finally:
            capability.native_rental_physical_cleanup_confirmed("test-session")

    def test_only_confirmed_release_reenables_physical_qualification_probe(self):
        class Owner:
            class Claims:
                @staticmethod
                def claims_for_session(_session_id):
                    return [object()]
            rental_preemption = Claims()

            @capability.fence_native_rental_launch
            def launch(self, session_id):
                return None

        ready = NativeDesktopPreflight(
            True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            "nvenc", "0.2", False,
        )
        Owner().launch("test-session")
        try:
            with (
                patch.object(capability.platform, "system", return_value="Windows"),
                patch.object(capability, "find_stream_helper", return_value="helper.exe"),
                patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
                patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
            ):
                capability.native_rental_physical_cleanup_confirmed("test-session")
                result = capability.probe_native_desktop_capability(clock=lambda: 201.0)
                self.assertTrue(result.available)
                preflight.assert_called_once_with("helper.exe")
        finally:
            capability.native_rental_physical_cleanup_confirmed("test-session")

    def test_non_windows_is_immediately_unavailable_without_helper_probe(self):
        with (
            patch.object(capability.platform, "system", return_value="Linux"),
            patch.object(capability, "find_stream_helper") as find_helper,
            patch.object(capability, "windows_native_desktop_preflight") as preflight,
        ):
            snapshot = capability.probe_native_desktop_capability(clock=lambda: 10.0)
        self.assertFalse(snapshot.available)
        self.assertEqual(snapshot.reason, "windows_required")
        find_helper.assert_not_called()
        preflight.assert_not_called()

    def test_positive_proof_is_cached_for_short_ttl(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            first = capability.probe_native_desktop_capability(clock=lambda: 10.0)
            second = capability.probe_native_desktop_capability(clock=lambda: 20.0)
        self.assertTrue(first.available)
        self.assertIs(first, second)
        self.assertEqual(preflight.call_count, 1)

    def test_positive_proof_expires_and_is_remeasured(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(
                clock=lambda: 10.0 + capability.POSITIVE_TTL_SECONDS
            )
        self.assertEqual(preflight.call_count, 2)

    def test_negative_proof_uses_shorter_ttl(self):
        missing = NativeDesktopPreflight(False, "native_stream_helper_missing")
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value=None),
            patch.object(capability, "_helper_identity", return_value=(None, None, None)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=missing) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(clock=lambda: 20.0)
            capability.probe_native_desktop_capability(
                clock=lambda: 10.0 + capability.NEGATIVE_TTL_SECONDS
            )
        self.assertEqual(preflight.call_count, 2)

    def test_helper_identity_change_invalidates_cache_immediately(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        identities = [("helper.exe", 1, 100), ("helper.exe", 2, 101)]
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", side_effect=identities),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(clock=lambda: 11.0)
        self.assertEqual(preflight.call_count, 2)

    def test_force_bypasses_fresh_cache(self):
        ready = NativeDesktopPreflight(True, "ready", "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a", "nvenc", "0.2", True)
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            capability.probe_native_desktop_capability(clock=lambda: 10.0)
            capability.probe_native_desktop_capability(force=True, clock=lambda: 11.0)
        self.assertEqual(preflight.call_count, 2)

    def test_cached_snapshot_accessor_never_reprobes(self):
        ready = NativeDesktopPreflight(
            True,
            "ready",
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            "nvenc",
            "0.2",
            True,
        )
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", return_value=ready) as preflight,
        ):
            self.assertIsNone(capability.cached_native_desktop_capability_snapshot())
            measured = capability.probe_native_desktop_capability(clock=lambda: 10.0)
            cached = capability.cached_native_desktop_capability_snapshot()

        self.assertIs(cached, measured)
        self.assertEqual(preflight.call_count, 1)

    def test_unexpected_probe_exception_fails_closed_and_is_cacheable(self):
        with (
            patch.object(capability.platform, "system", return_value="Windows"),
            patch.object(capability, "find_stream_helper", return_value="helper.exe"),
            patch.object(capability, "_helper_identity", return_value=("helper.exe", 1, 100)),
            patch.object(capability, "windows_native_desktop_preflight", side_effect=RuntimeError("boom")) as preflight,
        ):
            first = capability.probe_native_desktop_capability(clock=lambda: 10.0)
            second = capability.probe_native_desktop_capability(clock=lambda: 11.0)
        self.assertFalse(first.available)
        self.assertEqual(first.reason, "native_stream_probe_error:RuntimeError")
        self.assertIs(first, second)
        self.assertEqual(preflight.call_count, 1)


if __name__ == "__main__":
    unittest.main()
