from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.docker_cli import ensure_docker_on_path, find_docker_cli


class DockerCliResolutionTests(unittest.TestCase):
    def test_windows_all_users_install_is_found_without_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            docker = root / "Docker" / "Docker" / "resources" / "bin" / "docker.exe"
            docker.parent.mkdir(parents=True)
            docker.write_bytes(b"MZ")
            with (
                patch("gpubnb_agent.docker_cli.platform.system", return_value="Windows"),
                patch("gpubnb_agent.docker_cli.shutil.which", return_value=None),
                patch.dict(os.environ, {"ProgramFiles": str(root), "PATH": ""}, clear=False),
            ):
                self.assertEqual(find_docker_cli(), str(docker.resolve()))

    def test_windows_per_user_install_is_found_without_service_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            local = Path(temporary)
            docker = local / "Programs" / "DockerDesktop" / "resources" / "bin" / "docker.exe"
            docker.parent.mkdir(parents=True)
            docker.write_bytes(b"MZ")
            with (
                patch("gpubnb_agent.docker_cli.platform.system", return_value="Windows"),
                patch("gpubnb_agent.docker_cli.shutil.which", return_value=None),
                patch.dict(
                    os.environ,
                    {"LOCALAPPDATA": str(local), "ProgramFiles": str(local / "missing"), "PATH": ""},
                    clear=False,
                ),
            ):
                self.assertEqual(find_docker_cli(), str(docker.resolve()))

    def test_service_bootstrap_prepends_resolved_cli_directory_to_child_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            docker = Path(temporary) / "docker.exe"
            docker.write_bytes(b"MZ")
            original = os.environ.get("PATH")
            try:
                os.environ["PATH"] = "unrelated"
                with patch("gpubnb_agent.docker_cli.find_docker_cli", return_value=str(docker.resolve())):
                    resolved = ensure_docker_on_path()
                self.assertEqual(resolved, str(docker.resolve()))
                self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(docker.parent.resolve()))
            finally:
                if original is None:
                    os.environ.pop("PATH", None)
                else:
                    os.environ["PATH"] = original

    def test_windows_service_bootstraps_docker_before_heartbeat_worker(self) -> None:
        source = (Path(__file__).parents[1] / "gpubnb_agent" / "windows_service.py").read_text(encoding="utf-8")
        bootstrap = source.index("docker_executable = ensure_docker_on_path()")
        worker = source.index("supervise_heartbeat(self._stop_event, heartbeat_loop, logger)")
        self.assertLess(bootstrap, worker)


if __name__ == "__main__":
    unittest.main()
