from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from gpubnb_agent import workspace_gateway_v8 as reconnect
from gpubnb_agent.windows_native_runtime import NativeRuntimeHandle
from gpubnb_agent.workspace_gateway_v10 import GatewaySupervisor, NativeGatewayRuntime


SESSION = "stage4_native_reconnect_race"
GPU = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
PORT = 43123
TOKEN = "a" * 64


def make_supervisor() -> GatewaySupervisor:
    supervisor = GatewaySupervisor(
        api=None,
        key=None,
        machine_id="machine-1",
        config={},
        docker_runner=MagicMock(),
        health_check=lambda _port: True,
        mining_guard=lambda: True,
    )
    supervisor._request = MagicMock(return_value={"ok": True})  # type: ignore[method-assign]
    return supervisor


def native_runtime() -> NativeGatewayRuntime:
    handle = NativeRuntimeHandle(
        session_id=SESSION,
        workspace_slug="cloud-desktop",
        gpu_uuid=GPU,
        helper_version="0.1.0",
        media_url=f"http://127.0.0.1:{PORT}/session/{SESSION}",
        media_token=TOKEN,
        application_path=None,
        audio_ready=False,
        controller_ready=False,
    )
    return NativeGatewayRuntime(
        session_id=SESSION,
        runtime_id=f"gpubnb-native-{SESSION}",
        port=PORT,
        websocket_url=f"ws://127.0.0.1:{PORT}/session/{SESSION}",
        handle=handle,
    )


class _BlockingResumeProofGate:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()

    def __enter__(self) -> "_BlockingResumeProofGate":
        self.entered.set()
        if not self.release.wait(2.0):
            raise AssertionError("resume proof gate release timeout")
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        return None


class WindowsNativeReconnectRaceTests(unittest.TestCase):
    def test_paused_usage_rechecks_state_after_resume_transition_lock(self) -> None:
        supervisor = make_supervisor()
        runtime = native_runtime()
        supervisor.native_runtimes[SESSION] = runtime
        supervisor._reconnect_mark_paused(SESSION)
        supervisor.usage_last_report[SESSION] = time.monotonic()

        gate = _BlockingResumeProofGate()
        supervisor._native_resume_lock = lambda _session_id: gate  # type: ignore[method-assign]
        supervisor._native_stop_and_report = MagicMock(return_value=True)  # type: ignore[method-assign]

        with patch(
            "gpubnb_agent.workspace_gateway_v10.windows_native_workspace_suspended",
            return_value=False,
        ) as suspended_proof:
            worker = threading.Thread(
                target=supervisor._report_native_usage,
                args=(runtime,),
                daemon=True,
            )
            worker.start()

            self.assertTrue(
                gate.entered.wait(1.0),
                "paused native usage must serialize with the RESUME transition",
            )
            supervisor._reconnect_clear(SESSION)
            gate.release.set()
            worker.join(timeout=2.0)

        self.assertFalse(worker.is_alive())
        suspended_proof.assert_not_called()
        supervisor._native_stop_and_report.assert_not_called()

    def test_live_usage_rechecks_state_after_suspend_transition_lock(self) -> None:
        supervisor = make_supervisor()
        runtime = native_runtime()
        supervisor.native_runtimes[SESSION] = runtime
        supervisor.usage_last_report[SESSION] = (
            time.monotonic() - 2 * 10.0
        )

        gate = _BlockingResumeProofGate()
        supervisor._native_resume_lock = lambda _session_id: gate  # type: ignore[method-assign]
        supervisor._native_stop_and_report = MagicMock(return_value=True)  # type: ignore[method-assign]

        with (
            patch(
                "gpubnb_agent.workspace_gateway_v10.windows_native_workspace_ready",
                return_value=False,
            ) as ready_proof,
            patch(
                "gpubnb_agent.workspace_gateway_v10.windows_native_workspace_suspended",
                return_value=True,
            ) as suspended_proof,
        ):
            worker = threading.Thread(
                target=supervisor._report_native_usage,
                args=(runtime,),
                daemon=True,
            )
            worker.start()

            self.assertTrue(
                gate.entered.wait(1.0),
                "live native usage must serialize with the SUSPEND transition",
            )
            supervisor._reconnect_mark_paused(SESSION)
            gate.release.set()
            worker.join(timeout=2.0)

        self.assertFalse(worker.is_alive())
        ready_proof.assert_not_called()
        # The paused branch may return before probing suspension when reconnect
        # liveness was just refreshed. The regression invariant is that it must
        # never run the active READY proof or hard-stop during the SUSPEND
        # half-state.
        self.assertLessEqual(suspended_proof.call_count, 1)
        supervisor._native_stop_and_report.assert_not_called()

    def test_native_suspend_transition_holds_usage_proof_lock(self) -> None:
        supervisor = make_supervisor()
        supervisor.native_runtimes[SESSION] = native_runtime()
        transition_lock = supervisor._native_resume_lock(SESSION)
        lock_observations: list[bool] = []

        def fake_begin_reconnect_grace(_self: object, session_id: str) -> None:
            self.assertEqual(session_id, SESSION)
            acquired = transition_lock.acquire(blocking=False)
            lock_observations.append(acquired)
            if acquired:
                transition_lock.release()

        with patch.object(
            reconnect.GatewaySupervisor,
            "_begin_reconnect_grace",
            new=fake_begin_reconnect_grace,
        ):
            supervisor._begin_reconnect_grace(SESSION)

        self.assertEqual(lock_observations, [False])


if __name__ == "__main__":
    unittest.main()
