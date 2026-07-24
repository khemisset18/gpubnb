import unittest

import base58
from nacl.signing import VerifyKey

from gpubnb_agent.simulator import (
    GPU_CATALOG,
    SCENARIOS,
    STATE_OFFLINE,
    build_fleet,
    simulate_offline,
)


class FleetTests(unittest.TestCase):
    def test_build_fleet_is_deterministic(self):
        a = build_fleet(4, seed=42, scenario="steady")
        b = build_fleet(4, seed=42, scenario="steady")
        self.assertEqual([m.public_key for m in a], [m.public_key for m in b])
        self.assertEqual([m.gpu.uuid for m in a], [m.gpu.uuid for m in b])

    def test_build_fleet_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            build_fleet(0)
        with self.assertRaises(ValueError):
            build_fleet(2, scenario="does-not-exist")

    def test_catalogue_uuids_are_unique(self):
        fleet = build_fleet(8, seed=7, scenario="mixed")
        uuids = [m.gpu.uuid for m in fleet]
        self.assertEqual(len(uuids), len(set(uuids)))

    def test_inventory_matches_expected_shape(self):
        machine = build_fleet(1, seed=1, scenario="steady")[0]
        inv = machine.inventory()
        self.assertEqual(len(inv["gpus"]), 1)
        gpu = inv["gpus"][0]
        self.assertIn(gpu["gpuVendor"], {p.vendor for p in GPU_CATALOG})
        self.assertGreater(gpu["vramMiB"], 0)
        self.assertIn("dockerAvailable", inv["system"])


class MetricTests(unittest.TestCase):
    def test_metrics_stay_within_backend_bounds(self):
        for scenario in SCENARIOS:
            fleet = build_fleet(6, seed=3, scenario=scenario)
            for event in simulate_offline(fleet, steps=12, seed=3):
                self.assertGreaterEqual(event["gpuUtilization"], 0)
                self.assertLessEqual(event["gpuUtilization"], 100)
                self.assertGreaterEqual(event["temperatureC"], -20)
                self.assertLessEqual(event["temperatureC"], 130)
                # Backend rejects memoryUsed > vram as incoherent telemetry.
                self.assertLessEqual(event["memoryUsedMiB"], event["vramMiB"])
                # Backend rejects util > 10 when the CUDA probe failed.
                if not event["cudaProbeOk"]:
                    self.assertLessEqual(event["gpuUtilization"], 10)

    def test_failure_scenario_eventually_goes_offline(self):
        fleet = build_fleet(1, seed=5, scenario="failure")
        states = [e["state"] for e in simulate_offline(fleet, steps=10, seed=5)]
        self.assertIn("ERROR", states)

    def test_flapping_scenario_produces_offline_intervals(self):
        fleet = build_fleet(1, seed=9, scenario="flapping")
        onlines = [e["online"] for e in simulate_offline(fleet, steps=25, seed=9)]
        self.assertIn(False, onlines)


class HeartbeatSigningTests(unittest.TestCase):
    def test_heartbeat_signature_verifies_against_canonical(self):
        machine = build_fleet(1, seed=11, scenario="steady")[0]
        machine.machine_id = "cltest000000000000000000"
        list(simulate_offline([machine], steps=3, seed=11))
        payload = machine.heartbeat_payload("challenge-abc", "2026-01-01T00:00:00Z")
        util = payload["gpuUtilization"]
        canonical = "|".join([
            payload["machineId"], str(payload["counter"]), payload["challenge"], payload["timestamp"],
            payload["gpuUuid"], payload["gpuModel"], str(payload["vramMiB"]), payload["driverVersion"],
            str(util), str(payload["memoryUsedMiB"]), str(payload["temperatureC"]),
            str(payload["cudaProbeOk"]).lower(), "",
        ])
        verify_key = VerifyKey(base58.b58decode(machine.public_key))
        verify_key.verify(canonical.encode(), base58.b58decode(payload["signature"]))

    def test_counter_is_monotonic(self):
        machine = build_fleet(1, seed=13, scenario="steady")[0]
        machine.machine_id = "cltest000000000000000001"
        first = machine.heartbeat_payload("c1", "2026-01-01T00:00:00Z")["counter"]
        second = machine.heartbeat_payload("c2", "2026-01-01T00:00:05Z")["counter"]
        self.assertGreater(second, first)


if __name__ == "__main__":
    unittest.main()
