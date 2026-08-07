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

from gpubnb_agent import cli, instance_lock
from gpubnb_agent.storage import pid_path


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

    def test_status_rejects_stale_content_when_no_real_lock_is_held(self) -> None:
        # Content left behind by a hard-killed prior instance: no live
        # process actually holds the OS lock (nothing acquired it in this
        # test), so status must not trust the file's claim at face value.
        pid_path().write_text(
            json.dumps({"pid": 4242, "executable": "/opt/gpubnb-agent", "mode": "_run"}),
            encoding="ascii",
        )
        output = io.StringIO()

        with redirect_stdout(output):
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

    def test_daemon_start_reports_the_real_lock_holder_pid_even_if_it_differs_from_popen_pid(self) -> None:
        # Regression: on this Windows/venv setup, subprocess.Popen's reported
        # pid can genuinely differ from the OS process that ends up running
        # _run and holding the lock (a launcher-level indirection, observed
        # live). Confirmation must trust the real lock holder, never assume
        # process.pid is the one that acquired it.
        process = MagicMock(pid=9999)  # deliberately NOT the pid that "acquires" the lock
        process.poll.return_value = None
        output = io.StringIO()

        with (
            patch.object(cli, "_running_agent_pid", side_effect=[None, 4242]),
            patch.object(cli.subprocess, "Popen", return_value=process),
            redirect_stdout(output),
        ):
            self.assertEqual(cli.command_start(argparse.Namespace(daemon=True)), 0)

        self.assertIn("PID 4242", output.getvalue())
        self.assertNotIn("PID 9999", output.getvalue())

    def test_stop_never_signals_a_stale_unlocked_pid(self) -> None:
        pid_path().write_text(
            json.dumps({"pid": 4242, "executable": "/opt/gpubnb-agent", "mode": "_run"}),
            encoding="ascii",
        )

        with patch.object(cli.os, "kill") as kill:
            self.assertEqual(cli.command_stop(argparse.Namespace()), 1)

        kill.assert_not_called()
        self.assertFalse(pid_path().exists())

    def test_status_accepts_a_genuinely_held_lock(self) -> None:
        # No mocked heuristic: really acquire the lock the way the Windows
        # service (process_mode="_service") would, then confirm status sees
        # the real, live PID through the same atomic mechanism.
        lock = instance_lock.acquire_instance_lock("_service")
        try:
            self.assertEqual(cli._running_agent_pid(), os.getpid())
        finally:
            lock.release()

    def test_stop_signals_a_genuinely_held_lock(self) -> None:
        lock = instance_lock.acquire_instance_lock("_run")
        try:
            with patch.object(cli.os, "kill") as kill:
                self.assertEqual(cli.command_stop(argparse.Namespace()), 0)
            kill.assert_called_once_with(os.getpid(), cli.signal.SIGTERM)
        finally:
            lock.release()

    def test_heartbeat_loop_refuses_to_start_a_second_instance_on_every_entry_path(self) -> None:
        # This is the regression for the actual RC1 incident: the old guard
        # was only checked in command_start's --daemon branch, so `start`
        # without --daemon and the internal `_run` subcommand (what a
        # systemd unit or the Windows service actually invoke) bypassed it
        # entirely. heartbeat_loop() is the single function every one of
        # those paths funnels through, so acquiring the lock there is what
        # closes all of them at once — proven here by calling it directly,
        # the same way `_run` and the non-daemon `start` do, while another
        # instance already holds the lock.
        holder = instance_lock.acquire_instance_lock("_run")
        try:
            with self.assertRaises(instance_lock.AgentAlreadyRunningError):
                cli.heartbeat_loop()
        finally:
            holder.release()

    def test_heartbeat_loop_releases_the_lock_when_it_raises_after_acquiring(self) -> None:
        # No machineId configured -> heartbeat_loop raises after acquiring
        # the lock. The lock must still be released (via the `with` block),
        # not leaked, so a subsequent real start can succeed.
        with self.assertRaisesRegex(RuntimeError, "Machine non liée"):
            cli.heartbeat_loop()
        # If the lock leaked, this would raise AgentAlreadyRunningError.
        lock = instance_lock.acquire_instance_lock("_run")
        lock.release()


if __name__ == "__main__":
    unittest.main()
