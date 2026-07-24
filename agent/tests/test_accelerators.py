from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from gpubnb_agent.accelerators import (
    AcceleratorDevice,
    JsonDirectoryProvider,
    accelerator_inventory,
    normalize_device,
)


class FakeProvider:
    name = "future-lab"

    def probe(self) -> bool:
        return True

    def inventory(self):
        yield {
            "kind": "QPU",
            "vendor": "Example Quantum",
            "model": "Qubit Fabric 9000",
            "deviceId": "qpu-01",
            "available": True,
            "capabilities": {"logicalQubits": 128, "connectivity": "all-to-all"},
            "metrics": {"fidelityPercent": 99.91},
        }


class BrokenProvider:
    name = "broken"

    def probe(self) -> bool:
        raise RuntimeError("driver unavailable")

    def inventory(self):
        raise AssertionError("must not run")


class AcceleratorTests(unittest.TestCase):
    def test_future_accelerator_is_not_rejected_by_closed_catalogue(self) -> None:
        devices = accelerator_inventory([FakeProvider()])
        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["kind"], "QPU")
        self.assertEqual(devices[0]["model"], "Qubit Fabric 9000")
        self.assertEqual(devices[0]["capabilities"]["logicalQubits"], 128)

    def test_provider_failure_is_isolated(self) -> None:
        devices = accelerator_inventory([BrokenProvider(), FakeProvider()])
        self.assertEqual([device["deviceId"] for device in devices], ["qpu-01"])

    def test_unknown_device_gets_privacy_preserving_stable_fallback_id(self) -> None:
        raw = {"kind": "NPU", "vendor": "Future", "model": "Neural Core", "busAddress": "0000:01:00.0"}
        first = normalize_device(raw, "driver-a")
        second = normalize_device(raw, "driver-a")
        self.assertIsNotNone(first)
        self.assertEqual(first.device_id, second.device_id)
        self.assertTrue(first.device_id.startswith("derived-"))

    def test_json_manifest_adapter_allows_driver_side_integration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "quantum-driver.json"
            path.write_text(json.dumps({
                "kind": "QPU",
                "vendor": "Open Quantum",
                "model": "OQ-1",
                "deviceId": "oq-1",
                "capabilities": {"physicalQubits": 64},
            }), encoding="utf-8")
            devices = accelerator_inventory([JsonDirectoryProvider(directory)])
        self.assertEqual(devices[0]["provider"], "manifest:quantum-driver")
        self.assertEqual(devices[0]["capabilities"]["physicalQubits"], 64)

    def test_invalid_memory_is_rejected(self) -> None:
        self.assertIsNone(normalize_device({
            "kind": "GPU", "vendor": "X", "model": "Bad", "deviceId": "bad",
            "memoryTotalMiB": 10, "memoryUsedMiB": 11,
        }, "test"))

    def test_accelerator_dataclass_serializes_versioned_payload(self) -> None:
        payload = AcceleratorDevice(
            provider="sdk", kind="FPGA", vendor="Vendor", model="Card", device_id="fpga-1"
        ).as_payload()
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["kind"], "FPGA")


if __name__ == "__main__":
    unittest.main()
