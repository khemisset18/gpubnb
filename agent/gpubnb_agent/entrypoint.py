"""Stable process entrypoint that installs optional migration layers."""
from __future__ import annotations

import sys
from typing import Any


def _service_bootstrap_requested(argv: list[str] | tuple[str, ...] | None = None) -> bool:
    arguments = sys.argv if argv is None else argv
    return len(arguments) > 1 and arguments[1] == "_service"


def install_process_runtime(cli_module: Any) -> str | None:
    """Install process-wide runtime layers in their qualified order.

    The Windows SCM path calls this only after its dispatcher is connected. Normal
    CLI/daemon processes call it before ``cli.main()`` exactly as before.
    """
    from .control_channel_runtime import install as install_control_channel
    from .docker_cli import ensure_docker_on_path
    from .publishability_work_gate import install as install_publishability_work_gate
    from .recovery_runtime import install as install_recovery_runtime
    from .windows_subprocess import install_background_subprocess_policy

    # The Agent is always a headless background process on Windows. Install the
    # child-process policy before any runtime subsystem starts so legacy/future
    # PowerShell, Docker, nvidia-smi and helper launches cannot allocate visible
    # consoles. Explicit UAC belongs to Host Desktop/Tauri and is not affected.
    install_background_subprocess_policy()
    # Normalize Docker once for every supported process mode, not only the
    # Windows SCM wrapper. The foreground CLI and ``start --daemon`` enter here
    # too, and all runtime subsystems deliberately inherit this process environment
    # when they invoke Docker. This also makes GPUBNB_DOCKER a real operational
    # override instead of a resolver-only setting.
    docker_executable = ensure_docker_on_path()
    # Recovery owns the base process loop. Install it BEFORE control-channel so
    # the existing control wrapper can capture that loop, layer its heartbeat /
    # job functions on top, and still execute its qualified _stop_all() cleanup
    # in finally when the service exits. recovery_runtime dereferences
    # cli.heartbeat/run_next_job at runtime, so it still calls the wrapped
    # control-channel functions after the second install.
    install_recovery_runtime(cli_module)
    install_control_channel(cli_module)
    # A heartbeat may succeed while the server explicitly says the machine is
    # not publishable (quarantine, compatibility enforcement, etc.). Keep the
    # control/diagnostic plane alive but prevent any new normal job poll until
    # a later accepted heartbeat explicitly restores publishability.
    install_publishability_work_gate(cli_module)
    return docker_executable


def main() -> int:
    # A frozen one-file service can start while Windows, storage and antivirus are
    # still cold. Reach StartServiceCtrlDispatcher before importing the full Agent
    # runtime so SCM does not interpret normal module initialization as a hung
    # service. SvcDoRun installs the identical qualified runtime layers afterwards.
    if _service_bootstrap_requested():
        from .windows_service import dispatch_service

        return dispatch_service()

    from . import cli

    install_process_runtime(cli)
    return cli.main()
