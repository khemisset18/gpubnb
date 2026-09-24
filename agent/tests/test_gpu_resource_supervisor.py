from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.execution_control import ExecutionControlError
from gpubnb_agent.gpu_resource_supervisor import (
    GpuBinding,
    GpuMetrics,
    GpuResourceSupervisor,
    ProcessIdentity,
    RuntimeRecord,
    RuntimeStore,
    build_resource_arguments,
    parse_resource_start,
)


class FakeInspector:
    def __init__(self) -> None:
        self.identities: dict[int, ProcessIdentity] = {}
        self.terminated: list[ProcessIdentity] = []

    def inspect(self, pid: int) -> ProcessIdentity | None:
        return self.identities.get(pid)

    def terminate(self, identity: ProcessIdentity) -> None:
        if self.identities.get(identity.pid) != identity:
            raise ExecutionControlError("miner_process_identity_mismatch")
        self.terminated.append(identity)
        self.identities.pop(identity.pid, None)


class FakeProcess:
    def __init__(self, pid: int, inspector: FakeInspector, executable: Path) -> None:
        self._pid = pid
        self._inspector = inspector
        self._identity = ProcessIdentity(pid, str(executable.resolve()), f"creation-{pid}")
        inspector.identities[pid] = self._identity
        self.killed = False

    @property
    def pid(self) -> int:
        return self._pid

    def poll(self) -> int | None:
        return None

    def terminate_owned(self) -> None:
        self.killed = True
        self._inspector.identities.pop(self._pid, None)


class FakeSensor:
    def __init__(self) -> None:
        self.metrics: dict[str, GpuMetrics] = {}
        self.errors: dict[str, str] = {}

    def read(self, hardware_uuid: str) -> GpuMetrics:
        error = self.errors.get(hardware_uuid)
        if error:
            raise ExecutionControlError(error)
        return self.metrics.get(hardware_uuid, GpuMetrics(60.0, 100.0, 50))


class FakeLauncher:
    def __init__(self, inspector: FakeInspector) -> None:
        self.inspector = inspector
        self.next_pid = 1000
        self.calls: list[tuple[str, list[str]]] = []

    def spawn(self, executable: Path, arguments: list[str], cwd: Path) -> FakeProcess:
        self.next_pid += 1
        self.calls.append((str(executable), list(arguments)))
        return FakeProcess(self.next_pid, self.inspector, executable)


def start_payload(resource: str, hardware: str, generation: int = 1) -> dict[str, object]:
    return {
        "resourceId": resource,
        "hardwareUuid": hardware,
        "runtimeGeneration": generation,
        "profileId": "lolminer_etchash",
        "poolUrl": "stratum+tcp://1.1.1.1:4444",
        "walletAddress": "wallet.example-123",
        "workerName": "worker_1",
        "performanceMode": "FULL",
    }


def stop_payload(resource: str, hardware: str, generation: int = 1) -> dict[str, object]:
    return {
        "resourceId": resource,
        "hardwareUuid": hardware,
        "runtimeGeneration": generation,
    }


class GpuResourceSupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "miners"
        self.root.mkdir(parents=True)
        self.binary = self.root / "lolMiner"
        self.binary.write_bytes(b"approved-binary")
        self.inspector = FakeInspector()
        self.launcher = FakeLauncher(self.inspector)
        self.bindings = {
            "GPU-aaaaaaaa": GpuBinding("GPU-aaaaaaaa", "65:00", 300.0, 100.0),
            "GPU-bbbbbbbb": GpuBinding("GPU-bbbbbbbb", "66:00", 300.0, 100.0),
        }
        self.store = RuntimeStore(Path(self.temp.name) / "runtime.json")
        self.sensor = FakeSensor()
        self.events: list[dict[str, object]] = []
        self.patches = [
            patch("gpubnb_agent.gpu_resource_supervisor.miner_install_root", return_value=self.root),
            patch("gpubnb_agent.gpu_resource_supervisor._verified_binary", return_value=self.binary),
            patch("gpubnb_agent.gpu_resource_supervisor._sha256", return_value="a" * 64),
        ]
        for item in self.patches:
            item.start()
        self.supervisor = GpuResourceSupervisor(
            store=self.store,
            inspector=self.inspector,
            launcher=self.launcher,
            binding_resolver=lambda hardware: self.bindings[hardware],
            sensor=self.sensor,
            event_sink=self.events.append,
            start_watchdog=False,
        )

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_resource_arguments_pin_exact_pcie_device(self) -> None:
        spec = parse_resource_start(start_payload("resource_00000001", "GPU-aaaaaaaa"))
        args = build_resource_arguments(spec, self.bindings["GPU-aaaaaaaa"])
        self.assertIn("--devicesbypcie", args)
        self.assertEqual(args[args.index("--devices") + 1], "65:00")
        self.assertNotIn("66:00", args)

    def test_two_gpu_resources_can_run_and_stop_independently(self) -> None:
        one = self.supervisor.start(start_payload("resource_00000001", "GPU-aaaaaaaa"), "command_00000001")
        two = self.supervisor.start(start_payload("resource_00000002", "GPU-bbbbbbbb"), "command_00000002")
        self.assertEqual(one.detail_code, "mining_resource_started_verified")
        self.assertEqual(two.detail_code, "mining_resource_started_verified")

        snapshot = self.supervisor.snapshot()
        self.assertEqual(snapshot["resource_00000001"]["state"], "MINING")
        self.assertEqual(snapshot["resource_00000002"]["state"], "MINING")
        second_pid = snapshot["resource_00000002"]["pid"]

        stopped = self.supervisor.stop(stop_payload("resource_00000001", "GPU-aaaaaaaa"))
        self.assertEqual(stopped.detail_code, "mining_resource_stop_verified")
        snapshot = self.supervisor.snapshot()
        self.assertEqual(snapshot["resource_00000001"]["state"], "STOPPED")
        self.assertEqual(snapshot["resource_00000002"]["state"], "MINING")
        self.assertIn(second_pid, self.inspector.identities)

    def test_same_generation_is_idempotent_but_cannot_restart_after_exit(self) -> None:
        payload = start_payload("resource_00000001", "GPU-aaaaaaaa")
        self.supervisor.start(payload, "command_00000001")
        again = self.supervisor.start(payload, "command_00000001")
        self.assertEqual(again.detail_code, "mining_resource_already_running")
        self.supervisor.stop(stop_payload("resource_00000001", "GPU-aaaaaaaa"))
        with self.assertRaisesRegex(ExecutionControlError, "mining_runtime_generation_replay"):
            self.supervisor.start(payload, "command_00000001")

    def test_stale_stop_cannot_kill_new_generation(self) -> None:
        self.supervisor.start(start_payload("resource_00000001", "GPU-aaaaaaaa", 1), "command_00000001")
        self.supervisor.stop(stop_payload("resource_00000001", "GPU-aaaaaaaa", 1))
        self.supervisor.start(start_payload("resource_00000001", "GPU-aaaaaaaa", 2), "command_00000002")
        pid = self.supervisor.snapshot()["resource_00000001"]["pid"]
        with self.assertRaisesRegex(ExecutionControlError, "mining_runtime_generation_stale"):
            self.supervisor.stop(stop_payload("resource_00000001", "GPU-aaaaaaaa", 1))
        self.assertIn(pid, self.inspector.identities)

    def test_pid_reuse_is_quarantined_and_never_terminated(self) -> None:
        self.supervisor.start(start_payload("resource_00000001", "GPU-aaaaaaaa"), "command_00000001")
        record = self.supervisor.snapshot()["resource_00000001"]
        pid = int(record["pid"])
        self.inspector.identities[pid] = ProcessIdentity(pid, str(self.binary.resolve()), "reused-process")

        with self.assertRaisesRegex(ExecutionControlError, "miner_process_identity_mismatch"):
            self.supervisor.stop(stop_payload("resource_00000001", "GPU-aaaaaaaa"))
        self.assertEqual(self.supervisor.snapshot()["resource_00000001"]["state"], "QUARANTINED")
        self.assertEqual(self.inspector.terminated, [])

    def test_watchdog_warns_and_stops_only_the_hot_exact_gpu(self) -> None:
        hot_payload = start_payload("resource_00000001", "GPU-aaaaaaaa")
        hot_payload["maximumTemperatureC"] = 92
        cool_payload = start_payload("resource_00000002", "GPU-bbbbbbbb")
        cool_payload["maximumTemperatureC"] = 98
        self.supervisor.start(hot_payload, "command_00000001")
        self.supervisor.start(cool_payload, "command_00000002")

        hot_pid = self.supervisor.snapshot()["resource_00000001"]["pid"]
        cool_pid = self.supervisor.snapshot()["resource_00000002"]["pid"]
        self.sensor.metrics["GPU-aaaaaaaa"] = GpuMetrics(94.0, 120.5, 99)
        self.sensor.metrics["GPU-bbbbbbbb"] = GpuMetrics(70.0, 80.0, 40)

        outcome = self.supervisor.run_watchdog_once()

        self.assertEqual(outcome["resource_00000001"], "STOPPED")
        self.assertEqual(outcome["resource_00000002"], "MINING")
        self.assertNotIn(hot_pid, self.inspector.identities)
        self.assertIn(cool_pid, self.inspector.identities)
        hot = self.supervisor.snapshot()["resource_00000001"]
        self.assertEqual(hot["last_stop_reason"], "maximum_temperature_reached")
        self.assertEqual(hot["last_temperature_c"], 94.0)
        self.assertTrue(any(event.get("event") == "mining_thermal_stop" for event in self.events))

    def test_watchdog_emits_escalating_warning_without_stopping_below_owner_limit(self) -> None:
        payload = start_payload("resource_00000001", "GPU-aaaaaaaa")
        payload["maximumTemperatureC"] = 98
        self.supervisor.start(payload, "command_00000001")
        self.sensor.metrics["GPU-aaaaaaaa"] = GpuMetrics(90.0, 110.0, 95)

        outcome = self.supervisor.run_watchdog_once()

        self.assertEqual(outcome["resource_00000001"], "MINING")
        warning = [event for event in self.events if event.get("event") == "mining_thermal_warning"][-1]
        self.assertEqual(warning["warningLevelC"], 90)
        self.assertEqual(warning["maximumTemperatureC"], 98)

    def test_three_sensor_failures_stop_mining_fail_closed(self) -> None:
        payload = start_payload("resource_00000001", "GPU-aaaaaaaa")
        payload["maximumTemperatureC"] = 98
        self.supervisor.start(payload, "command_00000001")
        self.sensor.errors["GPU-aaaaaaaa"] = "resource_gpu_thermal_sensor_unavailable"

        self.assertEqual(self.supervisor.run_watchdog_once().get("resource_00000001"), None)
        self.assertEqual(self.supervisor.run_watchdog_once().get("resource_00000001"), None)
        outcome = self.supervisor.run_watchdog_once()

        self.assertEqual(outcome["resource_00000001"], "STOPPED")
        record = self.supervisor.snapshot()["resource_00000001"]
        self.assertEqual(record["last_stop_reason"], "thermal_sensor_fail_closed")

    def test_start_rejects_temperature_outside_owner_range(self) -> None:
        payload = start_payload("resource_00000001", "GPU-aaaaaaaa")
        payload["maximumTemperatureC"] = 99
        with self.assertRaisesRegex(ExecutionControlError, "mining_maximum_temperature_invalid"):
            self.supervisor.start(payload, "command_00000001")

    def test_reconcile_quarantines_binary_hash_mismatch(self) -> None:
        identity = ProcessIdentity(4444, str(self.binary.resolve()), "creation-4444")
        self.inspector.identities[4444] = identity
        self.store.save({
            "resource_00000001": RuntimeRecord(
                resource_id="resource_00000001",
                hardware_uuid="GPU-aaaaaaaa",
                runtime_generation=9,
                state="MINING",
                profile_id="lolminer_etchash",
                command_id="command_00000009",
                pid=4444,
                executable_path=identity.executable_path,
                binary_sha256="b" * 64,
                process_creation_token=identity.creation_token,
            )
        })
        with patch("gpubnb_agent.gpu_resource_supervisor._sha256", return_value="a" * 64):
            recovered = GpuResourceSupervisor(
                store=self.store,
                inspector=self.inspector,
                launcher=self.launcher,
                binding_resolver=lambda hardware: self.bindings[hardware],
                sensor=self.sensor,
                event_sink=self.events.append,
                start_watchdog=False,
            )
        record = recovered.snapshot()["resource_00000001"]
        self.assertEqual(record["state"], "QUARANTINED")
        self.assertEqual(record["last_stop_reason"], "approved_miner_binary_hash_mismatch")
        self.assertIn(4444, self.inspector.identities)

    def test_startup_reconciliation_adopts_exact_process_and_marks_missing_stopped(self) -> None:
        identity = ProcessIdentity(2222, str(self.binary.resolve()), "creation-2222")
        self.inspector.identities[2222] = identity
        self.store.save({
            "resource_00000001": RuntimeRecord(
                resource_id="resource_00000001",
                hardware_uuid="GPU-aaaaaaaa",
                runtime_generation=7,
                state="MINING",
                profile_id="lolminer_etchash",
                command_id="command_00000001",
                pid=2222,
                executable_path=identity.executable_path,
                binary_sha256="a" * 64,
                process_creation_token=identity.creation_token,
            ),
            "resource_00000002": RuntimeRecord(
                resource_id="resource_00000002",
                hardware_uuid="GPU-bbbbbbbb",
                runtime_generation=3,
                state="MINING",
                pid=3333,
                executable_path=str(self.binary.resolve()),
                process_creation_token="creation-3333",
            ),
        })
        recovered = GpuResourceSupervisor(
            store=self.store,
            inspector=self.inspector,
            launcher=self.launcher,
            binding_resolver=lambda hardware: self.bindings[hardware],
            sensor=self.sensor,
            event_sink=self.events.append,
            start_watchdog=False,
        )
        snapshot = recovered.snapshot()
        self.assertEqual(snapshot["resource_00000001"]["state"], "MINING")
        self.assertEqual(snapshot["resource_00000002"]["state"], "STOPPED")


if __name__ == "__main__":
    unittest.main()
