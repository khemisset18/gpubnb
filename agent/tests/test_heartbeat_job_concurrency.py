import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.cli import heartbeat_loop


class FastStopEvent:
    def __init__(self) -> None:
        self.stopped = False

    def is_set(self) -> bool:
        return self.stopped

    def wait(self, _seconds: float) -> bool:
        time.sleep(0.01)
        return self.stopped


class HeartbeatJobConcurrencyTests(unittest.TestCase):
    def test_long_job_worker_does_not_block_heartbeats(self):
        stop = FastStopEvent()
        job_started = threading.Event()
        release_job = threading.Event()
        heartbeat_count = 0
        job_count = 0

        def fake_heartbeat(*_args):
            nonlocal heartbeat_count
            heartbeat_count += 1
            if heartbeat_count >= 2:
                self.assertTrue(job_started.wait(1), "the job worker should start after the first heartbeat")
                stop.stopped = True
                release_job.set()
            return {"ok": True}

        def fake_run_next_job(*_args):
            nonlocal job_count
            job_count += 1
            job_started.set()
            release_job.wait(1)

        with tempfile.TemporaryDirectory() as directory, \
             patch("gpubnb_agent.cli.load_config", return_value={"machineId": "machine-1", "intervalSeconds": 5}), \
             patch("gpubnb_agent.cli.load_key", return_value=object()), \
             patch("gpubnb_agent.cli.workspace_image", return_value="image@sha256:" + "a" * 64), \
             patch("gpubnb_agent.cli.prewarm_workspace_image", return_value={"ready": True}), \
             patch("gpubnb_agent.cli.pid_path", return_value=Path(directory) / "agent.pid"), \
             patch("gpubnb_agent.cli.client", return_value=object()), \
             patch("gpubnb_agent.cli.heartbeat", side_effect=fake_heartbeat), \
             patch("gpubnb_agent.cli.run_next_job", side_effect=fake_run_next_job), \
             patch("gpubnb_agent.cli.print_json"):
            heartbeat_loop(stop_event=stop)  # type: ignore[arg-type]

        self.assertGreaterEqual(heartbeat_count, 2, "heartbeats must continue while a job is still running")
        self.assertEqual(job_count, 1, "only one job worker may run at a time")


if __name__ == "__main__":
    unittest.main()
