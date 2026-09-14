"""Stable process entrypoint that installs optional migration layers."""
from __future__ import annotations

from . import cli
from .control_channel_runtime import install as install_control_channel
from .docker_cli import ensure_docker_on_path
from .recovery_runtime import install as install_recovery_runtime
from .windows_subprocess import install_background_subprocess_policy


def main() -> int:
    # The Agent is always a headless background process on Windows. Install the
    # child-process policy before any runtime subsystem starts so legacy/future
    # PowerShell, Docker, nvidia-smi and helper launches cannot allocate visible
    # consoles. Explicit UAC belongs to Host Desktop/Tauri and is not affected.
    install_background_subprocess_policy()
    # Normalize Docker once for every supported process mode, not only the
    # Windows SCM wrapper.  The foreground CLI and ``start --daemon`` enter
    # here too, and all runtime subsystems deliberately inherit this process
    # environment when they invoke Docker.  This also makes GPUBNB_DOCKER a
    # real operational override instead of a resolver-only setting.
    ensure_docker_on_path()
    # Recovery owns the base process loop. Install it BEFORE control-channel so
    # the existing control wrapper can capture that loop, layer its heartbeat /
    # job functions on top, and still execute its qualified _stop_all() cleanup
    # in finally when the service exits. recovery_runtime dereferences
    # cli.heartbeat/run_next_job at runtime, so it still calls the wrapped
    # control-channel functions after the second install.
    install_recovery_runtime(cli)
    install_control_channel(cli)
    return cli.main()
