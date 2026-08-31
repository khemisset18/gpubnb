"""GPU process detection and clean-close workflow ("Détecter et libérer le GPU").

This module never terminates a process forcibly and never closes anything on
its own initiative: `list_gpu_processes` only reports what currently holds a
context on the target GPU, and `close_gpu_process` only acts on one PID the
caller explicitly names, by asking that single process to close itself the
same way a user closing its window would (WM_CLOSE), then waiting. If the
process does not honour that request in time, it is left running - there is
no escalation to a forced kill anywhere in this module.

Classification reuses gpu_rental_preemption._is_windows_desktop_compositor_path
(the same OS-owned-path check PR #134 already ships and tests) rather than a
second copy of that logic, so "what counts as the OS itself" only ever has to
be defined in one place.
"""
from __future__ import annotations

import csv
import json
import os
import time
from dataclasses import asdict, dataclass
from typing import Any

from .gpu_resource_supervisor import SAFE_GPU_ID
from .gpu_rental_preemption import _is_windows_desktop_compositor_path
from .platform_info import find_nvidia_smi, run_command
from .storage import pid_path

CLOSE_WAIT_TIMEOUT_SECONDS = 5.0
CLOSE_POLL_INTERVAL_SECONDS = 0.25

SYSTEM_ACCOUNT_NAMES = frozenset({"SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE"})
GPUBNB_PROCESS_NAMES = frozenset({"gpubnb-agent.exe", "gpubnb-host-desktop.exe", "gpubnb-host-tunnel.exe"})
# Defense-in-depth by exact name, even though the account/session/path checks
# below should already classify every one of these as SYSTEM_PROTECTED.
CRITICAL_PROCESS_NAMES = frozenset({
    "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "winlogon.exe", "smss.exe",
})

SYSTEM_PROTECTED = "SYSTEM_PROTECTED"
GPUBNB_PROTECTED = "GPUBNB_PROTECTED"
USER_APPLICATION = "USER_APPLICATION"
UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class GpuProcessInfo:
    pid: int
    process_name: str
    executable_path: str | None
    used_gpu_memory_mib: int | None
    classification: str
    blocks_rental: bool
    has_visible_window: bool
    closable: bool
    reason: str | None


def _running_agent_pid() -> int | None:
    try:
        record = json.loads(pid_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    pid = record.get("pid")
    return pid if isinstance(pid, int) and pid > 0 else None


def _wmi_process_info(pid: int) -> dict[str, Any] | None:
    """Query Win32_Process for one PID: name, path, and owner account.

    WMI's own GetOwner() resolves the process token to an account name without
    this module parsing a SID by hand. If the account can't be resolved (access
    denied, or the process already gone), the caller must treat this as
    UNKNOWN, never as a resolvable user application.
    """
    if os.name != "nt":
        return None
    try:
        import win32com.client
    except ImportError:
        return None
    try:
        wmi = win32com.client.GetObject("winmgmts:")
        results = wmi.ExecQuery(
            f"SELECT Name, ExecutablePath, ParentProcessId FROM Win32_Process WHERE ProcessId={int(pid)}"
        )
        for row in results:
            # Win32_Process.GetOwner() has [out] parameters, which pywin32's dynamic
            # dispatch cannot resolve via a plain `row.GetOwner()` call - attribute
            # access alone invokes it with no arguments and returns only the bare
            # return code, so a later `()` call fails with "'int' object is not
            # callable". ExecMethod_ is the pattern that actually round-trips the
            # named [out] parameters (User, Domain, ReturnValue) through this
            # dynamic COM binding - verified live against a real Win32_Process.
            owner = row.ExecMethod_("GetOwner")
            account = owner.User if owner.ReturnValue == 0 else None
            return {
                "name": row.Name,
                "executable_path": row.ExecutablePath,
                "parent_pid": row.ParentProcessId,
                "account": account,
            }
    except Exception:
        return None
    return None


def _process_session_id(pid: int) -> int | None:
    if os.name != "nt":
        return None
    try:
        import win32ts
    except ImportError:
        return None
    try:
        return win32ts.ProcessIdToSessionId(pid)
    except Exception:
        return None


def _enumerate_visible_windows(pid: int) -> list[int]:
    if os.name != "nt":
        return []
    try:
        import win32gui
        import win32process
    except ImportError:
        return []
    handles: list[int] = []

    def _callback(hwnd: int, _extra: Any) -> bool:
        try:
            _, window_pid = win32process.GetWindowThreadProcessId(hwnd)
            if window_pid == pid and win32gui.IsWindowVisible(hwnd):
                handles.append(hwnd)
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(_callback, None)
    except Exception:
        return []
    return handles


def _process_has_visible_window(pid: int) -> bool:
    return len(_enumerate_visible_windows(pid)) > 0


def _post_close_to_windows(pid: int) -> int:
    """Post WM_CLOSE to every visible top-level window of pid. Never calls
    TerminateProcess or anything that touches the process itself directly."""
    if os.name != "nt":
        return 0
    try:
        import win32con
        import win32gui
    except ImportError:
        return 0
    posted = 0
    for hwnd in _enumerate_visible_windows(pid):
        try:
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            posted += 1
        except Exception:
            pass
    return posted


def _process_is_alive(pid: int) -> bool:
    if os.name != "nt":
        return False
    try:
        import pywintypes
        import win32api
        import win32con
        import win32process
    except ImportError:
        return False
    try:
        handle = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    except pywintypes.error:
        return False
    try:
        return win32process.GetExitCodeProcess(handle) == win32con.STILL_ACTIVE
    except pywintypes.error:
        return False
    finally:
        handle.Close()


def classify_process(pid: int, process_name: str) -> tuple[str, str | None]:
    """Return (classification, reason). Fails closed: any doubt -> UNKNOWN."""
    if pid <= 4:
        return SYSTEM_PROTECTED, "reserved_pid"
    lowered_name = process_name.casefold()
    if lowered_name in {name.casefold() for name in GPUBNB_PROCESS_NAMES}:
        return GPUBNB_PROTECTED, "gpubnb_component"
    agent_pid = _running_agent_pid()
    if agent_pid is not None and pid == agent_pid:
        return GPUBNB_PROTECTED, "gpubnb_running_agent"
    if lowered_name in {name.casefold() for name in CRITICAL_PROCESS_NAMES}:
        return SYSTEM_PROTECTED, "windows_critical_process"

    info = _wmi_process_info(pid)
    if info is None:
        return UNKNOWN, "process_information_unavailable"

    executable_path = info.get("executable_path")
    if executable_path and _is_windows_desktop_compositor_path(executable_path):
        return SYSTEM_PROTECTED, "windows_system_path"

    account = info.get("account")
    if account is None:
        return UNKNOWN, "process_owner_unresolved"
    if account.upper() in SYSTEM_ACCOUNT_NAMES:
        return SYSTEM_PROTECTED, "system_service_account"

    session = _process_session_id(pid)
    if session is None:
        return UNKNOWN, "session_unresolved"
    if session == 0:
        return SYSTEM_PROTECTED, "non_interactive_session"

    return USER_APPLICATION, None


def _process_to_json(process: GpuProcessInfo) -> dict[str, Any]:
    payload = asdict(process)
    return {
        "pid": payload["pid"],
        "processName": payload["process_name"],
        "executablePath": payload["executable_path"],
        "usedGpuMemoryMib": payload["used_gpu_memory_mib"],
        "classification": payload["classification"],
        "blocksRental": payload["blocks_rental"],
        "hasVisibleWindow": payload["has_visible_window"],
        "closable": payload["closable"],
        "reason": payload["reason"],
    }


def list_gpu_processes(hardware_uuid: str) -> dict[str, Any]:
    if SAFE_GPU_ID.fullmatch(hardware_uuid) is None:
        raise ValueError("invalid_gpu_hardware_uuid")
    executable = find_nvidia_smi()
    if not executable:
        raise RuntimeError("rental_gpu_nvidia_smi_unavailable")
    result = run_command(
        [
            executable,
            "--query-compute-apps=gpu_uuid,pid,used_gpu_memory,process_name",
            "--format=csv,noheader,nounits",
        ],
        timeout=12,
    )
    if result.returncode != 0:
        raise RuntimeError("rental_gpu_compute_process_query_failed")

    processes: list[GpuProcessInfo] = []
    for row in csv.reader(line for line in result.stdout.splitlines() if line.strip()):
        values = [field.strip() for field in row]
        if len(values) < 4 or values[0].casefold() != hardware_uuid.casefold():
            continue
        try:
            pid = int(values[1])
        except ValueError:
            continue
        if pid <= 0:
            continue
        process_name = values[3]
        classification, reason = classify_process(pid, process_name)
        try:
            used_memory: int | None = int(float(values[2]))
        except ValueError:
            used_memory = None
        info = _wmi_process_info(pid)
        executable_path = info.get("executable_path") if info else None
        blocks_rental = classification != SYSTEM_PROTECTED
        processes.append(
            GpuProcessInfo(
                pid=pid,
                process_name=process_name,
                executable_path=executable_path,
                used_gpu_memory_mib=used_memory,
                classification=classification,
                blocks_rental=blocks_rental,
                has_visible_window=_process_has_visible_window(pid),
                closable=classification == USER_APPLICATION,
                reason=reason,
            )
        )

    gpu_ready_for_rental = not any(process.blocks_rental for process in processes)
    return {
        "hardwareUuid": hardware_uuid,
        "gpuReadyForRental": gpu_ready_for_rental,
        "blockingReasonIfAny": None if gpu_ready_for_rental else "rental_gpu_compute_processes_present",
        "processes": [_process_to_json(process) for process in processes],
    }


def close_gpu_process(pid: int) -> dict[str, Any]:
    """Ask exactly one process to close itself. Never forcibly terminates it.

    Fully revalidates classification from scratch (fresh WMI lookup, not the
    caller's cached `list` result) before doing anything, closing the window
    between a `list` response and the user's confirmation click during which
    Windows could have reused this PID for a different, unrelated process.
    """
    if pid <= 4:
        return {"pid": pid, "result": "refused_protected", "waitedMs": 0, "stillRunning": True}
    if not _process_is_alive(pid):
        return {"pid": pid, "result": "refused_pid_mismatch", "waitedMs": 0, "stillRunning": False}

    info = _wmi_process_info(pid)
    fresh_name = info.get("name") if info else None
    classification, _ = classify_process(pid, fresh_name or "")
    if classification != USER_APPLICATION:
        return {"pid": pid, "result": "refused_protected", "waitedMs": 0, "stillRunning": True}

    if not _process_has_visible_window(pid):
        return {"pid": pid, "result": "refused_no_graceful_method", "waitedMs": 0, "stillRunning": True}

    _post_close_to_windows(pid)
    start = time.monotonic()
    while time.monotonic() - start < CLOSE_WAIT_TIMEOUT_SECONDS:
        if not _process_is_alive(pid):
            waited_ms = int((time.monotonic() - start) * 1000)
            return {"pid": pid, "result": "closed_gracefully", "waitedMs": waited_ms, "stillRunning": False}
        time.sleep(CLOSE_POLL_INTERVAL_SECONDS)

    return {
        "pid": pid,
        "result": "did_not_close_in_time",
        "waitedMs": int(CLOSE_WAIT_TIMEOUT_SECONDS * 1000),
        "stillRunning": True,
    }
