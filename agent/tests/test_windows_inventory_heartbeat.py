from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from gpubnb_agent import platform_info


class WindowsInventoryHeartbeatHardeningTests(unittest.TestCase):
    def tearDown(self) -> None:
        platform_info.board_bios_info.cache_clear()
        platform_info.cpu_info.cache_clear()
        platform_info.virtualization_available.cache_clear()
        platform_info._nvidia_cuda_version.cache_clear()
        platform_info._DOCKER_RUNTIME_CACHE = None

    @staticmethod
    def gpu(uuid: str = "GPU-test") -> dict[str, object]:
        return {
            "gpuModel": "NVIDIA Test GPU",
            "gpuUuid": uuid,
            "vramMiB": 4096,
            "memoryUsedMiB": 0,
            "driverVersion": "999.1",
            "cudaVersion": "13.1",
            "temperatureC": 40,
            "gpuUtilization": 0,
            "powerWatts": 10.0,
            "gpuVendor": "NVIDIA",
            "throttling": False,
        }

    def test_run_command_hides_child_console_on_windows(self) -> None:
        completed = subprocess.CompletedProcess(["powershell.exe"], 0, "ok", "")
        with (
            patch.object(platform_info.os, "name", "nt"),
            patch.object(platform_info.subprocess, "run", return_value=completed) as run,
        ):
            result = platform_info.run_command(["powershell.exe"])

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            run.call_args.kwargs["creationflags"],
            platform_info.WINDOWS_CREATE_NO_WINDOW,
        )

    def test_windows_memory_probe_does_not_spawn_powershell(self) -> None:
        # GlobalMemoryStatusEx is used directly on Windows. On a non-Windows CI
        # runner ctypes.windll is absent, which is fine: the important contract is
        # that memory_info never falls back to a visible PowerShell child process.
        with (
            patch.object(platform_info.platform, "system", return_value="Windows"),
            patch.object(platform_info, "run_command") as run,
        ):
            result = platform_info.memory_info()

        self.assertIn("ramTotalMiB", result)
        self.assertIn("ramAvailableMiB", result)
        run.assert_not_called()

    def test_static_windows_board_inventory_is_cached(self) -> None:
        payload = (
            '{"board":{"Manufacturer":"HP","Product":"8742"},'
            '"bios":{"Manufacturer":"Insyde","SMBIOSBIOSVersion":"F.43"}}'
        )
        completed = subprocess.CompletedProcess(["powershell.exe"], 0, payload, "")
        platform_info.board_bios_info.cache_clear()

        with (
            patch.object(platform_info.platform, "system", return_value="Windows"),
            patch.object(platform_info, "run_command", return_value=completed) as run,
        ):
            first = platform_info.board_bios_info()
            second = platform_info.board_bios_info()

        self.assertEqual(first, second)
        self.assertEqual(run.call_count, 1)

    def test_inventory_cycle_coalesces_gpu_and_system_probes(self) -> None:
        gpu = self.gpu()
        disk = type(
            "Usage",
            (),
            {
                "total": 500 * 1024 * 1024,
                "used": 400 * 1024 * 1024,
                "free": 100 * 1024 * 1024,
            },
        )()
        board = {
            "motherboardManufacturer": "HP",
            "motherboardModel": "8742",
            "biosVendor": "Insyde",
            "biosVersion": "F.43",
        }
        memory = {"ramTotalMiB": 12064, "ramAvailableMiB": 3072}
        docker = {
            "available": True,
            "daemonReachable": True,
            "nvidiaRuntime": True,
            "version": "29.7.2",
        }

        with (
            patch.object(platform_info, "nvidia_gpu_inventory", return_value=[gpu]) as nvidia,
            patch.object(platform_info, "amdgpu_inventory", return_value=[]) as amd,
            patch.object(platform_info, "intel_gpu_inventory", return_value=[]) as intel,
            patch.object(platform_info, "memory_info", return_value=memory),
            patch.object(platform_info, "board_bios_info", return_value=board),
            patch.object(platform_info, "cpu_info", return_value={"cpu": "test", "cpuCount": 8}),
            patch.object(platform_info, "docker_info", return_value=docker),
            patch.object(platform_info, "virtualization_available", return_value=True),
            patch.object(platform_info, "desktop_gpu_rendering_available", return_value=False),
            patch.object(platform_info.shutil, "disk_usage", return_value=disk),
        ):
            with platform_info.inventory_cycle():
                first_gpu = platform_info.gpu_inventory()
                first_system = platform_info.system_inventory()
                second_gpu = platform_info.gpu_inventory()
                second_system = platform_info.system_inventory()

        self.assertEqual(first_gpu, second_gpu)
        self.assertEqual(first_system, second_system)
        self.assertEqual(nvidia.call_count, 1)
        self.assertEqual(amd.call_count, 1)
        self.assertEqual(intel.call_count, 1)

    def test_new_inventory_cycle_refreshes_dynamic_gpu_state(self) -> None:
        first_gpu = self.gpu("GPU-a")
        second_gpu = self.gpu("GPU-b")
        with (
            patch.object(
                platform_info,
                "nvidia_gpu_inventory",
                side_effect=[[first_gpu], [second_gpu]],
            ) as nvidia,
            patch.object(platform_info, "amdgpu_inventory", return_value=[]),
            patch.object(platform_info, "intel_gpu_inventory", return_value=[]),
        ):
            with platform_info.inventory_cycle():
                first = platform_info.gpu_inventory()
                self.assertEqual(platform_info.gpu_inventory(), first)
            with platform_info.inventory_cycle():
                second = platform_info.gpu_inventory()

        self.assertEqual(first[0]["gpuUuid"], "GPU-a")
        self.assertEqual(second[0]["gpuUuid"], "GPU-b")
        self.assertEqual(nvidia.call_count, 2)

    def test_docker_daemon_health_is_fresh_while_runtime_capability_is_cached(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            if command[1] == "info":
                self.assertEqual(timeout, 20)
                return subprocess.CompletedProcess(command, 0, '{"nvidia":{}}', "")
            return subprocess.CompletedProcess(command, 0, '"29.7.2"', "")

        with (
            patch.object(platform_info.shutil, "which", return_value="/usr/bin/docker"),
            patch.object(platform_info, "run_command", side_effect=fake_run),
        ):
            first = platform_info.docker_info()
            second = platform_info.docker_info()

        self.assertTrue(first["nvidiaRuntime"])
        self.assertTrue(second["nvidiaRuntime"])
        self.assertEqual(sum(command[1] == "version" for command in calls), 2)
        self.assertEqual(sum(command[1] == "info" for command in calls), 1)

    def test_cached_runtime_never_hides_a_dead_docker_daemon(self) -> None:
        version_calls = 0

        def fake_run(command: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
            nonlocal version_calls
            if command[1] == "info":
                return subprocess.CompletedProcess(command, 0, '{"nvidia":{}}', "")
            version_calls += 1
            if version_calls == 1:
                return subprocess.CompletedProcess(command, 0, '"29.7.2"', "")
            return subprocess.CompletedProcess(command, 127, "", "daemon unavailable")

        with (
            patch.object(platform_info.shutil, "which", return_value="/usr/bin/docker"),
            patch.object(platform_info, "run_command", side_effect=fake_run),
        ):
            first = platform_info.docker_info()
            second = platform_info.docker_info()

        self.assertTrue(first["daemonReachable"])
        self.assertTrue(first["nvidiaRuntime"])
        self.assertFalse(second["daemonReachable"])
        self.assertFalse(second["nvidiaRuntime"])

    def test_machine_fingerprint_is_not_frozen_across_gpu_changes(self) -> None:
        board = {
            "motherboardManufacturer": "HP",
            "motherboardModel": "8742",
            "biosVendor": "Insyde",
            "biosVersion": "F.43",
        }
        disk = type(
            "Usage",
            (),
            {
                "total": 500 * 1024 * 1024,
                "used": 400 * 1024 * 1024,
                "free": 100 * 1024 * 1024,
            },
        )()
        with (
            patch.object(
                platform_info,
                "gpu_inventory",
                side_effect=[[self.gpu("GPU-a")], [self.gpu("GPU-b")]],
            ) as gpu_inventory,
            patch.object(platform_info, "board_bios_info", return_value=board),
            patch.object(
                platform_info,
                "memory_info",
                return_value={"ramTotalMiB": 12064, "ramAvailableMiB": 2048},
            ),
            patch.object(platform_info.shutil, "disk_usage", return_value=disk),
        ):
            first = platform_info.machine_fingerprint()
            second = platform_info.machine_fingerprint()

        self.assertNotEqual(first, second)
        self.assertEqual(gpu_inventory.call_count, 2)


if __name__ == "__main__":
    unittest.main()
