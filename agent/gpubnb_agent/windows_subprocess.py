"""Process-wide Windows child-process policy for the headless Agent.

The GPUbnb Agent is a background service/daemon. None of its ordinary child
processes (PowerShell probes, Docker CLI, nvidia-smi, miners, service helpers)
are interactive terminal surfaces. On Windows, a console-subsystem child may
otherwise allocate a visible console when the parent has no console, producing
focus-stealing flashes on the provider desktop.

Individual high-risk paths still use explicit no-console helpers. This module is
the process-wide safety net for legacy and future subprocess calls. Explicit
CREATE_NEW_CONSOLE and DETACHED_PROCESS requests are preserved as intentional
caller policy instead of being rewritten.
"""
from __future__ import annotations

import os
import subprocess
from typing import Any

WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
WINDOWS_CREATE_NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x00000010)
WINDOWS_DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)


def background_creationflags(current: int) -> int:
    """Return Windows flags for a non-interactive Agent child process.

    If a caller explicitly requested a new console or a detached process, keep
    that decision unchanged. Otherwise add CREATE_NO_WINDOW while preserving
    every other creation flag (for example CREATE_NEW_PROCESS_GROUP).
    """
    flags = int(current)
    if flags & (WINDOWS_CREATE_NEW_CONSOLE | WINDOWS_DETACHED_PROCESS):
        return flags
    return flags | WINDOWS_CREATE_NO_WINDOW


def install_background_subprocess_policy() -> None:
    """Make subprocess.Popen default to no visible Windows console.

    This is intentionally installed only from the executable entrypoint, not at
    package-import time, so importing GPUbnb modules in test/tooling processes
    does not mutate their global subprocess behavior.
    """
    if os.name != "nt":
        return
    current = subprocess.Popen
    if getattr(current, "_gpubnb_background_policy", False):
        return

    original = current

    class BackgroundPopen(original):  # type: ignore[misc, valid-type]
        _gpubnb_background_policy = True

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            # GPUbnb production call sites pass creationflags by keyword. Keep
            # positional compatibility untouched rather than guessing the
            # stdlib Popen positional layout across supported Python versions.
            if "creationflags" in kwargs:
                kwargs["creationflags"] = background_creationflags(
                    int(kwargs.get("creationflags") or 0)
                )
            else:
                kwargs["creationflags"] = WINDOWS_CREATE_NO_WINDOW
            super().__init__(*args, **kwargs)

    subprocess.Popen = BackgroundPopen  # type: ignore[assignment]
