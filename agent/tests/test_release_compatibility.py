import unittest
from unittest.mock import patch

from gpubnb_agent.release_compatibility import (
    RELEASE_COMPATIBILITY_PROTOCOL,
    RELEASE_FEATURE_PROTOCOLS,
    release_compatibility_descriptor,
)
from gpubnb_agent.telemetry import TelemetrySampler


class ReleaseCompatibilityTests(unittest.TestCase):
    def test_descriptor_is_versioned_and_complete(self) -> None:
        self.assertEqual(RELEASE_COMPATIBILITY_PROTOCOL, 1)
        self.assertEqual(
            RELEASE_FEATURE_PROTOCOLS,
            {
                "agentRequestSignature": 2,
                "hostPowerPolicy": 1,
                "workspaceGateway": 1,
                "supportReport": 1,
            },
        )
        self.assertEqual(
            release_compatibility_descriptor(),
            {
                "releaseCompatibilityProtocol": 1,
                "features": RELEASE_FEATURE_PROTOCOLS,
            },
        )

    @patch("gpubnb_agent.telemetry.accelerator_inventory", return_value=[])
    @patch("gpubnb_agent.telemetry.gpu_inventory", return_value=[])
    @patch(
        "gpubnb_agent.telemetry.system_inventory",
        return_value={
            "ramTotalMiB": 16_384,
            "ramAvailableMiB": 8_192,
            "diskTotalMiB": 100_000,
            "diskAvailableMiB": 50_000,
            "dockerAvailable": True,
            "nvidiaRuntimeAvailable": True,
        },
    )
    def test_descriptor_is_inside_real_telemetry_payload(
        self, _system: object, _gpus: object, _accelerators: object
    ) -> None:
        payload = TelemetrySampler().sample()
        self.assertEqual(payload["schemaVersion"], 2)
        self.assertEqual(payload["releaseCompatibility"], release_compatibility_descriptor())

    def test_callers_cannot_mutate_global_feature_contract(self) -> None:
        descriptor = release_compatibility_descriptor()
        features = descriptor["features"]
        self.assertIsInstance(features, dict)
        features["workspaceGateway"] = 999
        self.assertEqual(RELEASE_FEATURE_PROTOCOLS["workspaceGateway"], 1)


if __name__ == "__main__":
    unittest.main()
