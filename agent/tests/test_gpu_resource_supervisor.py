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
        )
        snapshot = recovered.snapshot()
        self.assertEqual(snapshot["resource_00000001"]["state"], "MINING")
        self.assertEqual(snapshot["resource_00000002"]["state"], "STOPPED")


if __name__ == "__main__":
    unittest.main()
