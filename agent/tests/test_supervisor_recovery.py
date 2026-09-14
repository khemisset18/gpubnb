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

    def set(self) -> None:
        self.stopped = True

    def wait(self, timeout: float | None = None) -> bool:
        self.waits.append(timeout)
        result = self.wait_results.pop(0) if self.wait_results else self.stopped
        if result:
            self.stopped = True
        return result


class FakeGateway:
    def __init__(self, waits: list[bool]) -> None:
        self.stop_event = ScriptedStopEvent(waits)
        self.host_tunnels = MagicMock()
        self.reported: list[str] = []

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
    def test_docker_starting_uses_central_backoff_without_stopping_gateway(self) -> None:
        gateway = FakeGateway([False])

        result = GatewaySupervisor._recover_gateway_failure(  # type: ignore[arg-type]
            gateway,
            RuntimeError("workspace_docker_failed:info:1:Docker Desktop is starting"),
            0,
        )

        self.assertEqual(result, (True, 1))
        self.assertEqual(gateway.stop_event.waits, [5.0])
        gateway.host_tunnels.stop_all.assert_not_called()
        self.assertTrue(
            any(
                "workspace_gateway_recovery:mode=retry:reason=docker_starting:retryAfter=5"
                in item
                for item in gateway.reported
            )
        )

    def test_quarantine_reprobes_slowly_and_stops_edge_tunnel(self) -> None:
        gateway = FakeGateway([False])

        result = GatewaySupervisor._recover_gateway_failure(  # type: ignore[arg-type]
            gateway,
            RuntimeError("machine_quarantined"),
            7,
        )

        self.assertEqual(result, (True, 0))
        self.assertEqual(gateway.stop_event.waits, [60.0])
        gateway.host_tunnels.stop_all.assert_called_once()
        self.assertTrue(
            any("mode=platform_action:reason=machine_quarantined" in item for item in gateway.reported)
        )

    def test_unknown_runtime_failure_stops_gateway_plane_instead_of_retrying(self) -> None:
        gateway = FakeGateway([])

        result = GatewaySupervisor._recover_gateway_failure(  # type: ignore[arg-type]
            gateway,
            RuntimeError("brand_new_runtime_fault"),
            0,
        )

        self.assertEqual(result, (False, 0))
        self.assertTrue(gateway.stop_event.is_set())
        self.assertEqual(gateway.stop_event.waits, [])
        gateway.host_tunnels.stop_all.assert_called_once()
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
