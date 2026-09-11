import threading
import unittest

from gpubnb_agent import power_guard


class PowerGuardTests(unittest.TestCase):
    def test_guard_only_asserts_system_required_and_never_display_required(self) -> None:
        writes: list[int] = []
        guard = power_guard.SystemAwakeGuard(writer=writes.append)

        self.assertTrue(guard.set_required(True))
        self.assertFalse(guard.set_required(True))
        self.assertTrue(guard.set_required(False))

        self.assertEqual(
            writes,
            [
                power_guard.ES_CONTINUOUS | power_guard.ES_SYSTEM_REQUIRED,
                power_guard.ES_CONTINUOUS,
            ],
        )

    def test_marketplace_available_host_stays_awake_without_live_rental(self) -> None:
        writes: list[int] = []
        events: list[dict[str, object]] = []
        guard = power_guard.SystemAwakeGuard(writer=writes.append)

        active = power_guard.reconcile_power_guard_once(
            guard,
            authority_loader=lambda: power_guard.HostPowerAuthority(
                keep_awake=True,
                reason="marketplace_available",
                live_session_count=0,
                availability_listing_count=1,
            ),
            event_sink=events.append,
        )

        self.assertTrue(active)
        self.assertTrue(guard.active)
        self.assertEqual(writes, [power_guard.ES_CONTINUOUS | power_guard.ES_SYSTEM_REQUIRED])
        self.assertEqual(events[-1]["event"], "rental_power_guard_acquired")
        self.assertEqual(events[-1]["reason"], "marketplace_available")
        self.assertEqual(events[-1]["liveSessions"], 0)
        self.assertEqual(events[-1]["availabilityListings"], 1)

    def test_authority_failure_keeps_existing_guard_active(self) -> None:
        writes: list[int] = []
        events: list[dict[str, object]] = []
        guard = power_guard.SystemAwakeGuard(writer=writes.append)
        guard.set_required(True)

        active = power_guard.reconcile_power_guard_once(
            guard,
            authority_loader=lambda: (_ for _ in ()).throw(RuntimeError("network_down")),
            event_sink=events.append,
        )

        self.assertTrue(active)
        self.assertTrue(guard.active)
        self.assertEqual(writes, [power_guard.ES_CONTINUOUS | power_guard.ES_SYSTEM_REQUIRED])
        self.assertEqual(events[-1]["event"], "rental_power_guard_authority_error")
        self.assertTrue(events[-1]["guardActive"])

    def test_successful_not_available_policy_releases_guard(self) -> None:
        writes: list[int] = []
        events: list[dict[str, object]] = []
        guard = power_guard.SystemAwakeGuard(writer=writes.append)
        guard.set_required(True)

        active = power_guard.reconcile_power_guard_once(
            guard,
            authority_loader=lambda: power_guard.HostPowerAuthority(
                keep_awake=False,
                reason="not_available",
            ),
            event_sink=events.append,
        )

        self.assertFalse(active)
        self.assertFalse(guard.active)
        self.assertEqual(writes[-1], power_guard.ES_CONTINUOUS)
        self.assertEqual(events[-1]["event"], "rental_power_guard_released")
        self.assertEqual(events[-1]["reason"], "not_available")

    def test_power_policy_parser_rejects_inconsistent_server_state(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "host_power_policy_inconsistent"):
            power_guard._parse_power_policy({
                "protocolVersion": 1,
                "keepAwake": False,
                "reason": "marketplace_available",
                "liveSessionCount": 0,
                "availabilityListingCount": 1,
            })

    def test_loop_restores_persisted_claim_then_releases_when_service_stops(self) -> None:
        stop = threading.Event()
        writes: list[int] = []
        events: list[dict[str, object]] = []
        calls = 0

        def authority_loader() -> power_guard.HostPowerAuthority:
            nonlocal calls
            calls += 1
            stop.set()
            return power_guard.HostPowerAuthority(
                keep_awake=True,
                reason="live_session",
                live_session_count=1,
            )

        power_guard.run_rental_power_guard(
            stop,
            event_sink=events.append,
            interval_seconds=1,
            authority_loader=authority_loader,
            local_claim_loader=lambda: 1,
            writer=writes.append,
        )

        self.assertEqual(calls, 1)
        self.assertEqual(
            writes,
            [
                power_guard.ES_CONTINUOUS | power_guard.ES_SYSTEM_REQUIRED,
                power_guard.ES_CONTINUOUS,
            ],
        )
        self.assertTrue(any(event["event"] == "rental_power_guard_restored" for event in events))
        self.assertEqual(events[-1]["event"], "rental_power_guard_stopped")

    def test_loop_without_local_claim_acquires_from_marketplace_policy(self) -> None:
        stop = threading.Event()
        writes: list[int] = []

        def authority_loader() -> power_guard.HostPowerAuthority:
            stop.set()
            return power_guard.HostPowerAuthority(
                keep_awake=True,
                reason="marketplace_available",
                availability_listing_count=1,
            )

        power_guard.run_rental_power_guard(
            stop,
            interval_seconds=1,
            authority_loader=authority_loader,
            local_claim_loader=lambda: 0,
            writer=writes.append,
        )

        self.assertEqual(
            writes,
            [
                power_guard.ES_CONTINUOUS | power_guard.ES_SYSTEM_REQUIRED,
                power_guard.ES_CONTINUOUS,
            ],
        )


if __name__ == "__main__":
    unittest.main()
