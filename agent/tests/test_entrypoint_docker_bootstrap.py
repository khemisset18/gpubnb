from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from gpubnb_agent import entrypoint


class EntrypointDockerBootstrapTests(unittest.TestCase):
    def test_process_runtime_preserves_qualified_layer_order(self) -> None:
        calls: list[str] = []
        cli_module = MagicMock()

        with (
            patch(
                "gpubnb_agent.windows_subprocess.install_background_subprocess_policy",
                side_effect=lambda: calls.append("subprocess"),
            ),
            patch(
                "gpubnb_agent.docker_cli.ensure_docker_on_path",
                side_effect=lambda: calls.append("docker") or "docker.exe",
            ),
            patch(
                "gpubnb_agent.recovery_runtime.install",
                side_effect=lambda _cli: calls.append("recovery"),
            ),
            patch(
                "gpubnb_agent.control_channel_runtime.install",
                side_effect=lambda _cli: calls.append("control"),
            ),
            patch(
                "gpubnb_agent.publishability_work_gate.install",
                side_effect=lambda _cli: calls.append("publishability"),
            ),
        ):
            docker_executable = entrypoint.install_process_runtime(cli_module)

        self.assertEqual(docker_executable, "docker.exe")
        self.assertEqual(
            calls,
            ["subprocess", "docker", "recovery", "control", "publishability"],
        )

    def test_normal_process_installs_runtime_before_cli_dispatch(self) -> None:
        calls: list[str] = []

        with (
            patch.object(entrypoint, "_service_bootstrap_requested", return_value=False),
            patch.object(
                entrypoint,
                "install_process_runtime",
                side_effect=lambda _cli: calls.append("runtime"),
            ),
            patch(
                "gpubnb_agent.cli.main",
                side_effect=lambda: calls.append("cli") or 0,
            ),
        ):
            self.assertEqual(entrypoint.main(), 0)

        self.assertEqual(calls, ["runtime", "cli"])


if __name__ == "__main__":
    unittest.main()
