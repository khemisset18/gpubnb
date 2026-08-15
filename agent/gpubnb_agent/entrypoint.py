"""Stable process entrypoint that installs optional migration layers."""
from __future__ import annotations

from . import cli
from .control_channel_runtime import install as install_control_channel


def main() -> int:
    install_control_channel(cli)
    return cli.main()
