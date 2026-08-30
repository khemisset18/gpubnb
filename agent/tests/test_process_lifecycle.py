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

    def test_conventional_version_flag_is_supported(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as exit_context:
            cli.parser().parse_args(["--version"])
        self.assertEqual(exit_context.exception.code, 0)
        self.assertEqual(output.getvalue().strip(), cli.__version__)

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
            json.dumps({"pid": 4242, "executable": "/opt/gpubnb-agent", "mode": "_run"}),
            encoding="ascii",
        )
        output = io.StringIO()

        with (
            patch.object(cli, "_process_matches", return_value=False),
            patch(
                "gpubnb_agent.windows_service.service_status",
                return_value={"installed": False, "running": False},
            ),
            redirect_stdout(output),
        ):
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

    def test_daemon_start_tolerates_a_slow_but_real_confirmation(self) -> None:
        # Regression for a real failure: on Windows, each confirmation poll below
        # verifies the child's identity via a `Get-CimInstance` PowerShell
        # subprocess, individually measured at ~0.3-1.5s under ordinary load. A
        # child that is genuinely starting (not hung) but takes several slow
        # polls to confirm must not be killed by too tight a deadline - that
        # exact scenario (9 simulated seconds to confirm) was reproduced live and
        # would have failed the previous 5-second budget.
        process = MagicMock(pid=4242)
        process.poll.return_value = None
        output = io.StringIO()

        clock = {"value": 0.0}

        def fake_monotonic() -> float:
            clock["value"] += 1.0
            return clock["value"]

        # Not-yet-confirmed for 8 slow polls (~8s elapsed), matches on the 9th.
        pid_side_effect = [None, *([None] * 8), 4242]

        with (
            patch.object(cli, "_running_agent_pid", side_effect=pid_side_effect),
            patch.object(cli.subprocess, "Popen", return_value=process),
            patch.object(cli.time, "monotonic", side_effect=fake_monotonic),
            patch.object(cli.time, "sleep"),
            redirect_stdout(output),
        ):
            self.assertEqual(cli.command_start(argparse.Namespace(daemon=True)), 0)

        self.assertIn("PID 4242", output.getvalue())
        process.terminate.assert_not_called()

    def test_stop_never_signals_an_unverified_pid(self) -> None:
        cli.pid_path().write_text(
            json.dumps({"pid": 4242, "executable": "/opt/gpubnb-agent", "mode": "_run"}),
            encoding="ascii",
        )

        with (
            patch.object(cli, "_process_matches", return_value=False),
            patch.object(cli.os, "kill") as kill,
        ):
            self.assertEqual(cli.command_stop(argparse.Namespace()), 1)

        kill.assert_not_called()
        self.assertFalse(cli.pid_path().exists())

    def test_status_accepts_verified_windows_service_identity(self) -> None:
        cli.pid_path().write_text(
            json.dumps(
                {
                    "pid": 4242,
                    "executable": r"C:\Program Files\GPUbnb\gpubnb-agent.exe",
                    "mode": "_service",
                }
            ),
            encoding="ascii",
        )

        with patch.object(cli, "_process_matches", return_value=True) as matches:
            self.assertEqual(cli._running_agent_pid(), 4242)

        matches.assert_called_once_with(
            4242, r"C:\Program Files\GPUbnb\gpubnb-agent.exe", "_service"
        )


if __name__ == "__main__":
    unittest.main()
