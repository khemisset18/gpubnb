"""Atomic, OS-enforced single-instance lock for the agent process.

Every prior mechanism (a plain PID file, read-then-write) was inherently racy:
two processes could both observe "nothing running" before either one wrote its
own record. This uses an OS-level advisory lock instead — fcntl.flock on
POSIX, a byte-range lock via msvcrt on Windows — which is:

  - Atomic: a single syscall either grants exclusive ownership or fails.
  - Self-cleaning: the kernel releases the lock when the owning process exits
    for ANY reason (normal return, exception, SIGTERM, even SIGKILL/
    TerminateProcess), independent of whether our own cleanup code ever runs.

That second property is what makes "stale lock" a non-issue at the OS level:
if acquisition succeeds, no live process can be holding it, full stop — no
PID/executable heuristics required to decide that.

Two separate files are used deliberately:
  - agent.lock: holds the OS lock only, content is never read by anyone.
    Windows' msvcrt.locking() is a *mandatory* byte-range lock — unlike
    POSIX flock, it also blocks ordinary reads of that byte range from other
    handles, so a file that is both locked AND read back (for diagnostics)
    would make readers see spurious PermissionErrors while the lock is held.
  - agent.pid (storage.pid_path()): the human/diagnostic record (pid,
    executable, mode, createdAt), written with a plain atomic file replace
    *after* the lock is held. Never itself locked, so it is always safely
    readable — including by `gpubnb-agent status` while the agent runs.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .storage import _atomic_write, _secure_directory, config_dir, pid_path


class AgentAlreadyRunningError(RuntimeError):
    def __init__(self, holder: dict[str, Any] | None):
        self.holder = holder
        detail = f" (PID {holder.get('pid')})" if holder else ""
        super().__init__(f"agent_already_running{detail}")


def instance_lock_path() -> Path:
    return config_dir() / "agent.lock"


def _lock(fd: int, handle: Any) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(fd: int, handle: Any) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)


def _open_rw(path: Path) -> Any:
    # Not "a+b": append mode forces every write to end-of-file on POSIX
    # (O_APPEND), fighting explicit seeks. A plain fd with no O_APPEND gives
    # full, unambiguous control.
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    return os.fdopen(fd, "r+b")


class InstanceLock:
    """Holds the OS-level lock for as long as this object is alive. Always
    release() (or use as a context manager) so the diagnostic file is
    removed on a clean exit; the OS lock itself is released by the kernel
    regardless, even if release() never runs."""

    def __init__(self, lock_path: Path, fd: int, handle: Any) -> None:
        self._lock_path = lock_path
        self._fd = fd
        self._handle = handle
        self._released = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        try:
            _unlock(self._fd, self._handle)
        except OSError:
            pass
        try:
            self._handle.close()
        except OSError:
            pass
        try:
            self._lock_path.unlink()
        except FileNotFoundError:
            pass
        try:
            pid_path().unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "InstanceLock":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


def acquire_instance_lock(process_mode: str) -> InstanceLock:
    """Atomically acquire the single-instance lock, or raise
    AgentAlreadyRunningError if a live instance already holds it."""
    lock_path = instance_lock_path()
    _secure_directory(lock_path.parent)
    handle = _open_rw(lock_path)
    fd = handle.fileno()
    try:
        _lock(fd, handle)
    except OSError as exc:
        handle.close()
        raise AgentAlreadyRunningError(_read_holder()) from exc
    except Exception:
        handle.close()
        raise

    # We hold the OS lock: no other live process can, so any existing
    # diagnostic content is necessarily stale (left by a hard-killed prior
    # instance). Overwrite it unconditionally, atomically.
    record = {
        "pid": os.getpid(),
        "executable": sys.executable,
        "mode": process_mode,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write(pid_path(), json.dumps(record))
    return InstanceLock(lock_path, fd, handle)


def _read_holder() -> dict[str, Any] | None:
    try:
        value = json.loads(pid_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def query_lock_holder() -> dict[str, Any] | None:
    """Non-destructively determine whether a live instance holds the lock.
    Returns the holder's diagnostic record if so, else None. Never mutates
    the filesystem: if the lock turns out to be free, any agent.pid content
    found is necessarily stale, but the next real acquire_instance_lock()
    call is what overwrites it — this function only reads."""
    lock_path = instance_lock_path()
    try:
        handle = _open_rw(lock_path)
    except OSError:
        return None
    try:
        fd = handle.fileno()
        try:
            _lock(fd, handle)
        except OSError:
            return _read_holder()
        # Acquired -> nobody holds it, so any agent.pid content is stale.
        _unlock(fd, handle)
        return None
    finally:
        try:
            handle.close()
        except (OSError, ValueError):
            pass
