import os
import subprocess
import unittest
from unittest.mock import patch

from gpubnb_agent.gpu_process_release import (
    GPUBNB_PROTECTED,
    SYSTEM_PROTECTED,
    UNKNOWN,
    USER_APPLICATION,
    classify_process,
    close_gpu_process,
    list_gpu_processes,
)

MODULE = "gpubnb_agent.gpu_process_release"


class ClassifyProcessTests(unittest.TestCase):
    def test_reserved_pid_is_system_protected(self) -> None:
        classification, reason = classify_process(4, "System")
        self.assertEqual(classification, SYSTEM_PROTECTED)
        self.assertEqual(reason, "reserved_pid")

    def test_gpubnb_process_name_is_gpubnb_protected(self) -> None:
        with patch(f"{MODULE}._running_agent_pid", return_value=None):
            classification, reason = classify_process(1234, "gpubnb-host-desktop.exe")
        self.assertEqual(classification, GPUBNB_PROTECTED)
        self.assertEqual(reason, "gpubnb_component")

    def test_running_agent_pid_is_gpubnb_protected_even_with_unrelated_name(self) -> None:
        with patch(f"{MODULE}._running_agent_pid", return_value=9999):
            classification, reason = classify_process(9999, "python.exe")
        self.assertEqual(classification, GPUBNB_PROTECTED)
        self.assertEqual(reason, "gpubnb_running_agent")

    def test_critical_name_blocklist_is_system_protected(self) -> None:
        with patch(f"{MODULE}._running_agent_pid", return_value=None):
            classification, reason = classify_process(500, "lsass.exe")
        self.assertEqual(classification, SYSTEM_PROTECTED)
        self.assertEqual(reason, "windows_critical_process")

    def test_unresolvable_process_information_is_unknown_not_user_application(self) -> None:
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=None),
        ):
            classification, reason = classify_process(4242, "mystery.exe")
        self.assertEqual(classification, UNKNOWN)
        self.assertEqual(reason, "process_information_unavailable")

    def test_windows_system_path_is_system_protected(self) -> None:
        info = {"name": "TextInputHost.exe", "executable_path": "C:\\Windows\\SystemApps\\Shell.Host\\TextInputHost.exe", "account": None}
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=info),
            patch("gpubnb_agent.gpu_rental_preemption.os.name", "nt"),
            patch.dict(os.environ, {"SystemRoot": "C:\\Windows"}),
        ):
            classification, reason = classify_process(1888, "TextInputHost.exe")
        self.assertEqual(classification, SYSTEM_PROTECTED)
        self.assertEqual(reason, "windows_system_path")

    def test_unresolved_account_is_unknown(self) -> None:
        info = {"name": "mystery.exe", "executable_path": "C:\\Program Files\\Mystery\\mystery.exe", "account": None}
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=info),
        ):
            classification, reason = classify_process(4242, "mystery.exe")
        self.assertEqual(classification, UNKNOWN)
        self.assertEqual(reason, "process_owner_unresolved")

    def test_system_account_is_system_protected(self) -> None:
        info = {"name": "some_service.exe", "executable_path": "C:\\Program Files\\Vendor\\some_service.exe", "account": "SYSTEM"}
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=info),
        ):
            classification, reason = classify_process(777, "some_service.exe")
        self.assertEqual(classification, SYSTEM_PROTECTED)
        self.assertEqual(reason, "system_service_account")

    def test_non_interactive_session_is_system_protected(self) -> None:
        info = {"name": "backgroundsvc.exe", "executable_path": "C:\\Program Files\\Vendor\\backgroundsvc.exe", "account": "hicha"}
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=info),
            patch(f"{MODULE}._process_session_id", return_value=0),
        ):
            classification, reason = classify_process(888, "backgroundsvc.exe")
        self.assertEqual(classification, SYSTEM_PROTECTED)
        self.assertEqual(reason, "non_interactive_session")

    def test_unresolved_session_is_unknown(self) -> None:
        info = {"name": "mystery.exe", "executable_path": "C:\\Program Files\\Mystery\\mystery.exe", "account": "hicha"}
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=info),
            patch(f"{MODULE}._process_session_id", return_value=None),
        ):
            classification, reason = classify_process(999, "mystery.exe")
        self.assertEqual(classification, UNKNOWN)
        self.assertEqual(reason, "session_unresolved")

    def test_genuine_user_application_is_user_application(self) -> None:
        # Regression for the real EpicGamesLauncher.exe case observed live: a
        # third-party app, interactive session, real user account, outside
        # %SystemRoot% - this must classify as USER_APPLICATION, not be swept
        # into the same bucket as a compositor/system process.
        info = {
            "name": "EpicGamesLauncher.exe",
            "executable_path": "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe",
            "account": "hicha",
        }
        with (
            patch(f"{MODULE}._running_agent_pid", return_value=None),
            patch(f"{MODULE}._wmi_process_info", return_value=info),
            patch(f"{MODULE}._process_session_id", return_value=1),
        ):
            classification, reason = classify_process(22684, "EpicGamesLauncher.exe")
        self.assertEqual(classification, USER_APPLICATION)
        self.assertIsNone(reason)


class ListGpuProcessesTests(unittest.TestCase):
    def test_rejects_malformed_hardware_uuid(self) -> None:
        with self.assertRaises(ValueError):
            list_gpu_processes("not a uuid")

    def test_lists_only_the_target_gpu_and_reports_blocking_state(self) -> None:
        compute = subprocess.CompletedProcess(
            ["nvidia-smi"],
            0,
            "GPU-aaaaaaaa, 22684, 0, EpicGamesLauncher.exe\n"
            "GPU-aaaaaaaa, 1888, 0, C:\\Windows\\System32\\dwm.exe\n"
            "GPU-bbbbbbbb, 555, 0, other_gpu_process.exe\n",
            "",
        )
        with (
            patch(f"{MODULE}.find_nvidia_smi", return_value="nvidia-smi"),
            patch(f"{MODULE}.run_command", return_value=compute),
            patch(f"{MODULE}._wmi_process_info", return_value=None),
            patch(f"{MODULE}._process_has_visible_window", return_value=True),
            patch(
                f"{MODULE}.classify_process",
                side_effect=lambda pid, name: (USER_APPLICATION, None) if pid == 22684 else (SYSTEM_PROTECTED, "windows_system_path"),
            ),
        ):
            result = list_gpu_processes("GPU-aaaaaaaa")

        self.assertEqual(len(result["processes"]), 2)
        pids = {process["pid"] for process in result["processes"]}
        self.assertEqual(pids, {22684, 1888})
        self.assertFalse(result["gpuReadyForRental"])
        self.assertEqual(result["blockingReasonIfAny"], "rental_gpu_compute_processes_present")
        by_pid = {process["pid"]: process for process in result["processes"]}
        self.assertTrue(by_pid[22684]["closable"])
        self.assertTrue(by_pid[22684]["blocksRental"])
        self.assertFalse(by_pid[1888]["closable"])
        self.assertFalse(by_pid[1888]["blocksRental"])

    def test_gpu_ready_when_only_protected_processes_present(self) -> None:
        compute = subprocess.CompletedProcess(
            ["nvidia-smi"], 0, "GPU-aaaaaaaa, 1888, 0, C:\\Windows\\System32\\dwm.exe\n", ""
        )
        with (
            patch(f"{MODULE}.find_nvidia_smi", return_value="nvidia-smi"),
            patch(f"{MODULE}.run_command", return_value=compute),
            patch(f"{MODULE}._wmi_process_info", return_value=None),
            patch(f"{MODULE}._process_has_visible_window", return_value=False),
            patch(f"{MODULE}.classify_process", return_value=(SYSTEM_PROTECTED, "windows_system_path")),
        ):
            result = list_gpu_processes("GPU-aaaaaaaa")
        self.assertTrue(result["gpuReadyForRental"])
        self.assertIsNone(result["blockingReasonIfAny"])


class CloseGpuProcessTests(unittest.TestCase):
    def test_refuses_reserved_pid_without_any_lookup(self) -> None:
        result = close_gpu_process(4)
        self.assertEqual(result["result"], "refused_protected")
        self.assertTrue(result["stillRunning"])

    def test_refuses_pid_that_no_longer_exists(self) -> None:
        with patch(f"{MODULE}._process_is_alive", return_value=False):
            result = close_gpu_process(1234)
        self.assertEqual(result["result"], "refused_pid_mismatch")
        self.assertFalse(result["stillRunning"])

    def test_revalidation_refuses_a_process_that_is_no_longer_a_user_application(self) -> None:
        # Simulates PID reuse between `list` and `close`: at close time this PID
        # now belongs to something that must never be closed automatically.
        with (
            patch(f"{MODULE}._process_is_alive", return_value=True),
            patch(f"{MODULE}._wmi_process_info", return_value={"name": "services.exe"}),
            patch(f"{MODULE}.classify_process", return_value=(SYSTEM_PROTECTED, "windows_critical_process")),
        ):
            result = close_gpu_process(1234)
        self.assertEqual(result["result"], "refused_protected")
        self.assertTrue(result["stillRunning"])

    def test_refuses_when_no_graceful_method_is_available(self) -> None:
        with (
            patch(f"{MODULE}._process_is_alive", return_value=True),
            patch(f"{MODULE}._wmi_process_info", return_value={"name": "headless.exe"}),
            patch(f"{MODULE}.classify_process", return_value=(USER_APPLICATION, None)),
            patch(f"{MODULE}._process_has_visible_window", return_value=False),
        ):
            result = close_gpu_process(1234)
        self.assertEqual(result["result"], "refused_no_graceful_method")
        self.assertTrue(result["stillRunning"])
        # No WM_CLOSE should ever be attempted without a window to receive it.

    def test_closes_gracefully_when_the_process_exits_within_the_wait(self) -> None:
        alive_sequence = iter([True, True, False])
        with (
            patch(f"{MODULE}._process_is_alive", side_effect=lambda pid: next(alive_sequence)),
            patch(f"{MODULE}._wmi_process_info", return_value={"name": "EpicGamesLauncher.exe"}),
            patch(f"{MODULE}.classify_process", return_value=(USER_APPLICATION, None)),
            patch(f"{MODULE}._process_has_visible_window", return_value=True),
            patch(f"{MODULE}._post_close_to_windows", return_value=1) as post_close,
            patch(f"{MODULE}.time.sleep", return_value=None),
        ):
            result = close_gpu_process(22684)
        post_close.assert_called_once_with(22684)
        self.assertEqual(result["result"], "closed_gracefully")
        self.assertFalse(result["stillRunning"])

    def test_never_escalates_to_a_kill_when_the_process_does_not_close_in_time(self) -> None:
        with (
            patch(f"{MODULE}._process_is_alive", return_value=True),
            patch(f"{MODULE}._wmi_process_info", return_value={"name": "EpicGamesLauncher.exe"}),
            patch(f"{MODULE}.classify_process", return_value=(USER_APPLICATION, None)),
            patch(f"{MODULE}._process_has_visible_window", return_value=True),
            patch(f"{MODULE}._post_close_to_windows", return_value=1),
            patch(f"{MODULE}.time.sleep", return_value=None),
            patch(f"{MODULE}.CLOSE_WAIT_TIMEOUT_SECONDS", 0.01),
            patch(f"{MODULE}.CLOSE_POLL_INTERVAL_SECONDS", 0.001),
        ):
            result = close_gpu_process(22684)
        self.assertEqual(result["result"], "did_not_close_in_time")
        self.assertTrue(result["stillRunning"])


if __name__ == "__main__":
    unittest.main()
