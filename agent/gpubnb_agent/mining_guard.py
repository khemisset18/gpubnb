"""Keeps GPU mining and Developer Workspace rentals mutually exclusive.

This is enforced from the agent service - the one component that is always running,
whether or not the Tauri desktop app happens to be open - rather than from
``rental_mining_coordinator.rs`` alone, which only reflects reality while the GUI
process is alive. A crash, reboot, or the owner simply never opening the app must not
be able to let a miner keep running once a rental needs the GPU.

The approach mirrors ``startup_reconciliation.rs`` on the host-desktop side: a running
process is only ever treated as "ours" when it resolves to a canonical path under our
own approved miner install root - never by process name alone - so this module can
never be tricked (or accidentally triggered) into touching something it doesn't own.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Protocol

APPROVED_MINER_FILE_NAMES = ("xmrig.exe", "xmrig", "lolMiner.exe", "lolMiner")
STOP_TIMEOUT_SECONDS = 30.0
POLL_INTERVAL_SECONDS = 0.5


class ProcessInspector(Protocol):
    """Read-only view of the machine, plus the one privileged action (terminating a
    process this module has already positively identified as ours). Kept as a
    protocol so the exclusivity policy can be tested without touching the real OS."""

    def running_processes(self) -> list[tuple[int, str]]:
        """[(pid, executable_path)] for every process currently running. Must raise
        rather than return a partial list: a partial list could let a real miner slip
        past undetected."""
        ...

    def terminate(self, pid: int) -> None: ...

    def is_running(self, pid: int) -> bool: ...


class WindowsProcessInspector:
    """Real implementation, Windows-only (the only platform GPUbnb Host ships to)."""

    def running_processes(self) -> list[tuple[int, str]]:
        command = (
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath "
            "| ConvertTo-Json -Compress"
        )
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True, text=True, timeout=15, check=False, shell=False,
        )
        if result.returncode != 0:
            raise RuntimeError("mining_guard_process_enumeration_failed")
        try:
            data = json.loads(result.stdout or "[]")
        except json.JSONDecodeError as exc:
            raise RuntimeError("mining_guard_process_enumeration_invalid_output") from exc
        entries = data if isinstance(data, list) else [data]
        processes: list[tuple[int, str]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            pid = entry.get("ProcessId")
            path = entry.get("ExecutablePath")
            if isinstance(pid, int) and isinstance(path, str) and path:
                processes.append((pid, path))
        return processes

    def terminate(self, pid: int) -> None:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/F", "/T"],
            capture_output=True, text=True, timeout=10, check=False, shell=False,
        )

    def is_running(self, pid: int) -> bool:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             f"[bool](Get-Process -Id {pid} -ErrorAction SilentlyContinue)"],
            capture_output=True, text=True, timeout=10, check=False, shell=False,
        )
        return result.returncode == 0 and result.stdout.strip().lower() == "true"


def miner_install_root() -> Path:
    """Mirrors miner_paths::approved_miner_root() on the Rust side: the one directory
    GPUbnb Host ever installs approved miner binaries into."""
    override = os.environ.get("GPUBNB_APPROVED_MINER_DIR")
    if override:
        return Path(override)
    base = os.environ.get("GPUBNB_DATA_DIR")
    if not base:
        local = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if not local:
            raise RuntimeError("gpubnb_data_directory_unavailable")
        base = str(Path(local) / "GPUbnb" / "Host")
    return Path(base) / "miners" / "xmrig"


def _approved_paths(install_root: Path) -> set[str]:
    if not install_root.is_dir():
        return set()
    approved = set()
    for name in APPROVED_MINER_FILE_NAMES:
        candidate = install_root / name
        if candidate.is_file():
            try:
                approved.add(str(candidate.resolve()))
            except OSError:
                continue
    return approved


def find_running_miners(install_root: Path, inspector: ProcessInspector) -> list[dict[str, object]]:
    """Positively-identified running miner processes: only ones whose executable path
    resolves to a file that is actually present under our own install root right now.
    A process we can't positively resolve is left alone rather than guessed at."""
    approved = _approved_paths(install_root)
    if not approved:
        return []
    found: list[dict[str, object]] = []
    for pid, path in inspector.running_processes():
        try:
            resolved = str(Path(path).resolve())
        except OSError:
            continue
        if resolved in approved:
            found.append({"pid": pid, "path": resolved})
    return found


def stop_all_miners_and_verify(
    install_root: Path,
    inspector: ProcessInspector,
    timeout_seconds: float = STOP_TIMEOUT_SECONDS,
) -> bool:
    """Stops every approved miner process found and blocks until each is confirmed
    dead. Returns False - never raises - if any miner cannot be verified dead within
    the timeout. Callers MUST treat False as fail-closed and refuse to proceed: a
    Developer Workspace runtime must never start while this is anything but True."""
    miners = find_running_miners(install_root, inspector)
    if not miners:
        return True
    for miner in miners:
        inspector.terminate(int(miner["pid"]))
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not any(inspector.is_running(int(m["pid"])) for m in miners):
            return True
        time.sleep(POLL_INTERVAL_SECONDS)
    return not any(inspector.is_running(int(m["pid"])) for m in miners)
