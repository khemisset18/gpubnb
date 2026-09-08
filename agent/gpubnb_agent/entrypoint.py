"""Stable process entrypoint that installs optional migration layers."""
from __future__ import annotations

from . import cli
from .control_channel_runtime import install as install_control_channel
from .docker_cli import ensure_docker_on_path


def main() -> int:
    # Normalize Docker once for every supported process mode, not only the
    # Windows SCM wrapper.  The foreground CLI and ``start --daemon`` enter
    # here too, and all runtime subsystems deliberately inherit this process
    # environment when they invoke Docker.  This also makes GPUBNB_DOCKER a
    # real operational override instead of a resolver-only setting.
    ensure_docker_on_path()
    install_control_channel(cli)
    return cli.main()
