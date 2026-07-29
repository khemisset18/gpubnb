import argparse
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

from gpubnb_agent import cli


class ProcessLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.config_directory = Path(self.temporary_directory.name)
        self.environment = patch.dict(
            os.environ, {"GPUBNB_CONFIG_DIR": str(self.config_directory)}
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary_directory.cleanup()

    def test_frozen_agent_relaunches_the_sidecar(self) -> None:
        executable = r"C:\Program Files\GPUbnb\gpubnb-agent.exe"
        with (
            patch.object(sys, "frozen", True, create=True),
            patch.object(sys, "executable", executable),
        ):
            self.assertEqual(cli._agent_process_command(), [executable, "_run"])

    def test_source_agent_relaunches_the_module(self) -> None:
        with patch.object(sys, "executable", "/usr/bin/python3"):
            self.assertEqual(
                cli._agent_process_command(),
                ["/usr/bin/python3", "-m", "gpubnb_agent", "_run"],
            )

    def test_status_rejects_a_reused_pid(self) -> None:
        cli.pid_path().write_text(
            json.dumps({"pid": 4242, "executable": "/opt/gpubnb-agent"}),
            encoding="ascii",
        )
        output = io.StringIO()

        with patch.object(cli, "_process_matches", return_value=False), redirect_stdout(output):
            self.assertEqual(cli.command_status(argparse.Namespace()), 0)

        status = json.loads(output.getvalue())
        self.assertFalse(status["running"])
        self.assertIsNone(status["pid"])

    def test_daemon_start_requires_verified_child_identity(self) -> None:
        process = MagicMock(pid=4242)
        process.poll.return_value = None
        output = io.StringIO()

        with (
            patch.object(cli, "_running_agent_pid", side_effect=[None, 4242]),
            patch.object(cli.subprocess, "Popen", return_value=process) as popen,
            redirect_stdout(output),
        ):
            self.assertEqual(cli.command_start(argparse.Namespace(daemon=True)), 0)

        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0][-1], "_run")
        self.assertIn("PID 4242", output.getvalue())

    def test_stop_never_signals_an_unverified_pid(self) -> None:
        cli.pid_path().write_text(
            json.dumps({"pid": 4242, "executable": "/opt/gpubnb-agent"}),
            encoding="ascii",
        )

        with (
            patch.object(cli, "_process_matches", return_value=False),
            patch.object(cli.os, "kill") as kill,
        ):
            self.assertEqual(cli.command_stop(argparse.Namespace()), 1)

        kill.assert_not_called()
        self.assertFalse(cli.pid_path().exists())


if __name__ == "__main__":
    unittest.main()
