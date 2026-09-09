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
        platform_info.machine_fingerprint.cache_clear()
        platform_info._DOCKER_INFO_CACHE = None

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

    def test_docker_runtime_inventory_is_cached_for_heartbeat_cycles(self) -> None:
        platform_info._DOCKER_INFO_CACHE = None
        expected = {
            "available": True,
            "daemonReachable": True,
            "nvidiaRuntime": True,
            "version": "29.7.2",
        }
        with patch.object(platform_info, "_uncached_docker_info", return_value=expected) as probe:
            first = platform_info.docker_info()
            second = platform_info.docker_info()

        self.assertEqual(first, expected)
        self.assertEqual(second, expected)
        self.assertEqual(probe.call_count, 1)

    def test_machine_fingerprint_is_stable_for_agent_process_lifetime(self) -> None:
        platform_info.machine_fingerprint.cache_clear()
        gpu = {
            "gpuVendor": "NVIDIA",
            "gpuUuid": "GPU-test",
            "vramMiB": 4096,
        }
        with (
            patch.object(platform_info, "gpu_inventory", return_value=[gpu]) as gpu_inventory,
            patch.object(platform_info, "board_bios_info", return_value={
                "motherboardManufacturer": "HP",
                "motherboardModel": "8742",
                "biosVendor": "Insyde",
                "biosVersion": "F.43",
            }),
            patch.object(platform_info, "memory_info", return_value={
                "ramTotalMiB": 12064,
                "ramAvailableMiB": 2048,
            }),
            patch.object(platform_info.shutil, "disk_usage", return_value=type(
                "Usage", (), {"total": 500 * 1024 * 1024, "free": 100 * 1024 * 1024}
            )()),
        ):
            first = platform_info.machine_fingerprint()
            second = platform_info.machine_fingerprint()

        self.assertEqual(first, second)
        self.assertEqual(gpu_inventory.call_count, 1)


if __name__ == "__main__":
    unittest.main()
