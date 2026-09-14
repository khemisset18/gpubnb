from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from gpubnb_agent.supervisor_recovery import PolicyHostTunnelSupervisor, supervisor_wait
from gpubnb_agent.workspace_gateway_v7 import GatewaySupervisor


class ScriptedStopEvent:
    def __init__(self, wait_results: list[bool]) -> None:
        self.stopped = False
        self.wait_results = list(wait_results)
        self.waits: list[float | None] = []

    def is_set(self) -> bool:
        return self.stopped

    def wait(self, timeout: float | None = None) -> bool:
        self.waits.append(timeout)
        result = self.wait_results.pop(0) if self.wait_results else True
        if result:
            self.stopped = True
        return result


class FakeGateway:
    def __init__(self, errors: list[Exception | None], waits: list[bool]) -> None:
        self.machine_id = "machine_test"
        self.stop_event = ScriptedStopEvent(waits)
        self.host_tunnels = MagicMock()
        self._last_error_signature = None
        self.errors = list(errors)
        self.reconcile_calls = 0
        self.reported: list[str] = []

    def _reconcile_sessions(self) -> None:
        self.reconcile_calls += 1
        outcome = self.errors.pop(0) if self.errors else None
        if outcome is not None:
            raise outcome

    def _request(self, _path: str):
        return None

    def _handle(self, _item) -> None:
        raise AssertionError("no item expected")

    def _report_error(self, error: Exception) -> None:
        self.reported.append(str(error))

    def _report_recovery(
        self,
        mode: str,
        reason: str,
        delay_seconds: float | None,
    ) -> None:
        GatewaySupervisor._report_recovery(
            self,  # type: ignore[arg-type]
            mode,
            reason,
            delay_seconds,
        )


class SupervisorRecoveryTests(unittest.TestCase):
    def test_docker_starting_uses_central_backoff_then_recovers(self) -> None:
        gateway = FakeGateway(
            [RuntimeError("workspace_docker_failed:info:1:Docker Desktop is starting"), None],
            [False, True],
        )

        GatewaySupervisor.run(gateway)  # type: ignore[arg-type]

        self.assertEqual(gateway.reconcile_calls, 2)
        self.assertEqual(gateway.stop_event.waits, [5.0, 0.05])
        self.assertTrue(
            any(
                "workspace_gateway_recovery:mode=retry:reason=docker_starting:retryAfter=5"
                in item
                for item in gateway.reported
            )
        )

    def test_quarantine_reprobes_slowly_without_hot_loop(self) -> None:
        gateway = FakeGateway(
            [RuntimeError("machine_quarantined"), None],
            [False, True],
        )

        GatewaySupervisor.run(gateway)  # type: ignore[arg-type]

        self.assertEqual(gateway.reconcile_calls, 2)
        self.assertEqual(gateway.stop_event.waits, [60.0, 0.05])
        self.assertGreaterEqual(gateway.host_tunnels.stop_all.call_count, 1)
        self.assertTrue(
            any("mode=platform_action:reason=machine_quarantined" in item for item in gateway.reported)
        )

    def test_unknown_runtime_failure_parks_worker_instead_of_retrying(self) -> None:
        gateway = FakeGateway(
            [RuntimeError("brand_new_runtime_fault")],
            [True],
        )

        GatewaySupervisor.run(gateway)  # type: ignore[arg-type]

        self.assertEqual(gateway.reconcile_calls, 1)
        self.assertEqual(gateway.stop_event.waits, [None])
        self.assertGreaterEqual(gateway.host_tunnels.stop_all.call_count, 1)
        self.assertTrue(
            any("mode=owner_action:reason=unknown_failure" in item for item in gateway.reported)
        )

    def test_tunnel_runtime_uses_same_bounded_policy_schedule(self) -> None:
        supervisor = PolicyHostTunnelSupervisor(
            object(),
            object(),
            "machine_test",
            {},
            clock=lambda: 100.0,
            random_func=lambda: 0.5,
        )

        supervisor._record_failure("session_test")
        self.assertEqual(supervisor.retries["session_test"].failures, 1)
        self.assertEqual(supervisor.retries["session_test"].retry_at, 105.0)

        supervisor._record_failure("session_test")
        self.assertEqual(supervisor.retries["session_test"].failures, 2)
        self.assertEqual(supervisor.retries["session_test"].retry_at, 110.0)

    def test_unknown_supervisor_exception_never_gets_retry_delay(self) -> None:
        mode, reason, delay = supervisor_wait(
            RuntimeError("new_unclassified_failure"),
            0,
            subsystem="gateway",
        )
        self.assertEqual((mode, reason, delay), ("owner_action", "unknown_failure", None))


if __name__ == "__main__":
    unittest.main()
