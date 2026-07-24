import unittest
from unittest.mock import patch

from gpubnb_agent.telemetry import TelemetrySampler, normalize_gpu_metric


class TelemetryValidationTests(unittest.TestCase):
    def test_rejects_missing_gpu_identity(self):
        self.assertIsNone(normalize_gpu_metric({"vramMiB": 4096, "memoryUsedMiB": 0}))

    def test_rejects_impossible_vram_usage(self):
        self.assertIsNone(normalize_gpu_metric({
            "gpuUuid": "GPU-test", "vramMiB": 4096, "memoryUsedMiB": 8192,
        }))

    def test_invalid_optional_sensor_values_become_null(self):
        metric = normalize_gpu_metric({
            "gpuVendor": "NVIDIA", "gpuUuid": "GPU-test", "gpuModel": "Test GPU",
            "vramMiB": 24576, "memoryUsedMiB": 1024, "driverVersion": "1",
            "gpuUtilization": 900, "temperatureC": 900, "powerWatts": -10,
        })
        self.assertIsNotNone(metric)
        self.assertIsNone(metric["gpuUtilization"])
        self.assertIsNone(metric["temperatureC"])
        self.assertIsNone(metric["powerWatts"])

    @patch("gpubnb_agent.telemetry.boot_id", return_value="boot-test")
    @patch("gpubnb_agent.telemetry.network_totals")
    @patch("gpubnb_agent.telemetry.cpu_times")
    @patch("gpubnb_agent.telemetry.gpu_inventory")
    @patch("gpubnb_agent.telemetry.system_inventory")
    def test_sampler_produces_monotonic_sequence_and_rates(
        self, system, gpus, cpu, network, _boot_id
    ):
        system.return_value = {
            "ramTotalMiB": 32000, "ramAvailableMiB": 12000,
            "diskTotalMiB": 100000, "diskAvailableMiB": 40000,
            "dockerAvailable": True, "dockerVersion": "27.0",
            "nvidiaRuntimeAvailable": True,
        }
        gpus.return_value = [{
            "gpuVendor": "NVIDIA", "gpuUuid": "GPU-test", "gpuModel": "RTX",
            "vramMiB": 24576, "memoryUsedMiB": 1024, "driverVersion": "550",
            "gpuUtilization": 50, "temperatureC": 60, "powerWatts": 200,
        }]
        cpu.side_effect = [(1000, 500), (1200, 550)]
        network.side_effect = [(1000, 2000), (3000, 5000)]

        sampler = TelemetrySampler()
        first = sampler.sample()
        second = sampler.sample()

        self.assertEqual(first["sequence"], 1)
        self.assertEqual(second["sequence"], 2)
        self.assertEqual(second["bootId"], "boot-test")
        self.assertEqual(second["cpuUtilization"], 75.0)
        self.assertEqual(second["ramUsedMiB"], 20000)
        self.assertEqual(second["diskUsedMiB"], 60000)
        self.assertEqual(len(second["gpus"]), 1)
        self.assertGreaterEqual(second["networkRxBytesPerSecond"], 0)

    @patch("gpubnb_agent.telemetry.gpu_inventory", return_value=[])
    @patch("gpubnb_agent.telemetry.system_inventory", return_value={})
    def test_snapshot_contains_no_direct_personal_identifiers(self, _system, _gpus):
        snapshot = TelemetrySampler().sample()
        forbidden = {"hostname", "publicIp", "username", "processes", "homeDirectory"}
        self.assertTrue(forbidden.isdisjoint(snapshot.keys()))


if __name__ == "__main__":
    unittest.main()
