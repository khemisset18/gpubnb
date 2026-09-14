from __future__ import annotations

import unittest
from unittest.mock import patch

from gpubnb_agent import entrypoint


class EntrypointDockerBootstrapTests(unittest.TestCase):
    def test_all_process_modes_bootstrap_docker_and_runtime_layers_before_cli_dispatch(self) -> None:
        calls: list[str] = []

        with (
            patch.object(
                entrypoint,
                "install_background_subprocess_policy",
                side_effect=lambda: calls.append("subprocess"),
            ),
            patch.object(
                entrypoint,
                "ensure_docker_on_path",
                side_effect=lambda: calls.append("docker"),
            ),
            patch.object(
                entrypoint,
                "install_control_channel",
                side_effect=lambda _cli: calls.append("control"),
            ),
            patch.object(
                entrypoint,
                "install_recovery_runtime",
                side_effect=lambda _cli: calls.append("recovery"),
            ),
            patch.object(
                entrypoint.cli,
                "main",
                side_effect=lambda: calls.append("cli") or 0,
            ),
        ):
            self.assertEqual(entrypoint.main(), 0)

        self.assertEqual(
            calls,
            ["subprocess", "docker", "control", "recovery", "cli"],
        )


if __name__ == "__main__":
    unittest.main()
