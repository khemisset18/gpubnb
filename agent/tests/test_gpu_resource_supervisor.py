from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.execution_control import ExecutionControlError
from gpubnb_agent.gpu_resource_supervisor import (
    GpuBinding,
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
        self.temperatures = {
            "GPU-aaaaaaaa": 70.0,
            "GPU-bbbbbbbb": 71.0,
        }
        self.temperature_failures: set[str] = set()

        def read_temperature(hardware_uuid: str) -> float:
            if hardware_uuid in self.temperature_failures:
                raise ExecutionControlError("resource_gpu_temperature_unavailable")
            return self.temperatures[hardware_uuid]

        self.read_temperature = read_temperature
        self.store = RuntimeStore(Path(self.temp.name) / "runtime.json")
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
            temperature_reader=self.read_temperature,
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

    def test_thermal_stop_range_defaults_to_85_and_rejects_out_of_range(self) -> None:
        spec = parse_resource_start(start_payload("resource_00000001", "GPU-aaaaaaaa"))
        self.assertEqual(spec.thermal_stop_celsius, 85)
        for invalid in (84, 99, True):
            payload = {**start_payload("resource_00000001", "GPU-aaaaaaaa"), "thermalStopCelsius": invalid}
            with self.assertRaisesRegex(ExecutionControlError, "mining_thermal_stop_invalid"):
                parse_resource_start(payload)

    def test_start_fails_closed_when_gpu_is_already_at_selected_limit(self) -> None:
        self.temperatures["GPU-aaaaaaaa"] = 92.0
        payload = {
            **start_payload("resource_00000001", "GPU-aaaaaaaa"),
            "thermalStopCelsius": 92,
        }
        with self.assertRaisesRegex(ExecutionControlError, "resource_gpu_temperature_above_limit"):
            self.supervisor.start(payload, "command_00000001")
        self.assertEqual(self.launcher.calls, [])

    def test_watchdog_warns_then_stops_exact_resource_at_selected_limit(self) -> None:
        payload = {
            **start_payload("resource_00000001", "GPU-aaaaaaaa"),
            "thermalStopCelsius": 92,
        }
        self.supervisor.start(payload, "command_00000001")
        pid = self.supervisor.snapshot()["resource_00000001"]["pid"]

        self.temperatures["GPU-aaaaaaaa"] = 90.0
        events = self.supervisor.poll_thermal_safety()
        self.assertEqual(events[-1]["event"], "mining_thermal_warning")
        self.assertEqual(events[-1]["warningLevelC"], 90)
        self.assertIn(pid, self.inspector.identities)

        self.temperatures["GPU-aaaaaaaa"] = 92.0
        events = self.supervisor.poll_thermal_safety()
        stop = next(event for event in events if event["event"] == "mining_thermal_stop")
        self.assertEqual(stop["reason"], "THERMAL_LIMIT")
        snapshot = self.supervisor.snapshot()["resource_00000001"]
        self.assertEqual(snapshot["state"], "STOPPED")
        self.assertEqual(snapshot["last_stop_reason"], "THERMAL_LIMIT")
        self.assertNotIn(pid, self.inspector.identities)

    def test_98c_boundary_stops_and_quarantines_resource(self) -> None:
        payload = {
            **start_payload("resource_00000001", "GPU-aaaaaaaa"),
            "thermalStopCelsius": 98,
        }
        self.supervisor.start(payload, "command_00000001")
        self.temperatures["GPU-aaaaaaaa"] = 98.0
        events = self.supervisor.poll_thermal_safety()
        stop = next(event for event in events if event["event"] == "mining_thermal_stop")
        self.assertEqual(stop["reason"], "THERMAL_QUARANTINE")
        self.assertEqual(self.supervisor.snapshot()["resource_00000001"]["state"], "QUARANTINED")

    def test_three_temperature_sensor_failures_stop_and_quarantine(self) -> None:
        self.supervisor.start(
            {**start_payload("resource_00000001", "GPU-aaaaaaaa"), "thermalStopCelsius": 95},
            "command_00000001",
        )
        self.temperature_failures.add("GPU-aaaaaaaa")
        self.assertEqual(self.supervisor.poll_thermal_safety(), [])
        self.assertEqual(self.supervisor.poll_thermal_safety(), [])
        events = self.supervisor.poll_thermal_safety()
        quarantined = next(event for event in events if event["event"] == "mining_resource_quarantined")
        self.assertEqual(quarantined["reason"], "THERMAL_SENSOR_UNAVAILABLE")
        self.assertEqual(quarantined["sensorFailures"], 3)
        self.assertEqual(self.supervisor.snapshot()["resource_00000001"]["state"], "QUARANTINED")

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
            temperature_reader=self.read_temperature,
        )
        snapshot = recovered.snapshot()
        self.assertEqual(snapshot["resource_00000001"]["state"], "MINING")
        self.assertEqual(snapshot["resource_00000002"]["state"], "STOPPED")

    def test_startup_reconciliation_quarantines_changed_binary_and_stops_owned_process(self) -> None:
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
            ),
        })
        recovered = GpuResourceSupervisor(
            store=self.store,
            inspector=self.inspector,
            launcher=self.launcher,
            binding_resolver=lambda hardware: self.bindings[hardware],
            temperature_reader=self.read_temperature,
        )
        snapshot = recovered.snapshot()["resource_00000001"]
        self.assertEqual(snapshot["state"], "QUARANTINED")
        self.assertEqual(snapshot["last_stop_reason"], "BINARY_INTEGRITY")
        self.assertNotIn(4444, self.inspector.identities)


if __name__ == "__main__":
    unittest.main()
