import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent import instance_lock
from gpubnb_agent.storage import pid_path


class InstanceLockTests(unittest.TestCase):
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

    def test_acquire_is_atomic_and_a_second_holder_is_rejected(self) -> None:
        # Real OS-level lock, no mocking: two genuinely separate file
        # descriptions (POSIX flock is per-open-file-description, Windows
        # byte-range locks are per-handle) contending for the same lock, the
        # way two real agent processes would.
        first = instance_lock.acquire_instance_lock("_run")
        try:
            with self.assertRaises(instance_lock.AgentAlreadyRunningError) as ctx:
                instance_lock.acquire_instance_lock("_run")
            self.assertEqual(ctx.exception.holder["pid"], os.getpid())
        finally:
            first.release()

    def test_lock_is_reacquirable_after_release(self) -> None:
        first = instance_lock.acquire_instance_lock("_run")
        first.release()
        second = instance_lock.acquire_instance_lock("_run")
        second.release()

    def test_release_is_idempotent(self) -> None:
        lock = instance_lock.acquire_instance_lock("_run")
        lock.release()
        lock.release()  # must not raise

    def test_context_manager_releases_on_exception(self) -> None:
        with self.assertRaises(ValueError):
            with instance_lock.acquire_instance_lock("_run"):
                raise ValueError("boom")
        # If release() ran, a fresh acquisition must succeed immediately.
        lock = instance_lock.acquire_instance_lock("_run")
        lock.release()

    def test_stale_content_with_no_real_lock_is_overwritten_not_trusted(self) -> None:
        # Simulates what a hard-killed prior instance leaves behind: a
        # diagnostic file claiming a PID, but no OS lock actually held (the
        # kernel released it when that process died — only agent.lock, not
        # agent.pid, is ever actually OS-locked).
        pid_path().parent.mkdir(parents=True, exist_ok=True)
        pid_path().write_bytes(json.dumps({"pid": 999999, "executable": "/bogus", "mode": "_run"}).encode())

        holder_before = instance_lock.query_lock_holder()
        self.assertIsNone(holder_before, "stale content with no real OS lock must never be reported as a live holder")

        lock = instance_lock.acquire_instance_lock("_run")
        try:
            record = json.loads(pid_path().read_bytes())
            self.assertEqual(record["pid"], os.getpid())
            self.assertIn("createdAt", record)
        finally:
            lock.release()

    def test_query_lock_holder_is_read_only_when_lock_is_free(self) -> None:
        path = instance_lock.instance_lock_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"not even valid json")
        instance_lock.query_lock_holder()
        # query_lock_holder() must never mutate the filesystem on the
        # "nobody holds it" path — only a real acquire_instance_lock() may.
        self.assertTrue(path.exists())

    def test_query_lock_holder_reports_the_real_holder(self) -> None:
        lock = instance_lock.acquire_instance_lock("_service")
        try:
            holder = instance_lock.query_lock_holder()
            self.assertIsNotNone(holder)
            self.assertEqual(holder["pid"], os.getpid())
            self.assertEqual(holder["mode"], "_service")
        finally:
            lock.release()

    def test_concurrent_acquire_from_two_real_threads_only_one_wins(self) -> None:
        # threading.Thread still gives two independent open()/lock attempts
        # (each thread opens its own file description), a reasonable stand-in
        # for two OS processes racing to start at the same instant.
        results: list[str] = []
        barrier = threading.Barrier(2)

        def attempt() -> None:
            barrier.wait()
            try:
                lock = instance_lock.acquire_instance_lock("_run")
                results.append("won")
                time.sleep(0.05)
                lock.release()
            except instance_lock.AgentAlreadyRunningError:
                results.append("lost")

        threads = [threading.Thread(target=attempt) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

        self.assertEqual(sorted(results), ["lost", "won"], "exactly one concurrent attempt must win the lock")

    def test_posix_lock_path_is_exercised_when_not_on_windows(self) -> None:
        # This suite runs on a Windows dev machine, so the real msvcrt path is
        # already covered by the tests above. Mock os.name to structurally
        # exercise the fcntl branch too, matching the cross-platform
        # requirement without needing POSIX hardware in CI. Path construction
        # happens *before* the patch (pathlib itself inspects the live
        # os.name to pick WindowsPath/PosixPath, so patching it globally
        # while still constructing paths would break pathlib, not the code
        # under test).
        calls: list[tuple[str, int]] = []

        class FakeFcntl:
            LOCK_EX = 1
            LOCK_NB = 2
            LOCK_UN = 3

            @staticmethod
            def flock(fd: int, op: int) -> None:
                calls.append(("flock", op))

        handle = instance_lock._open_rw(instance_lock.instance_lock_path())
        try:
            with (
                patch.object(instance_lock.os, "name", "posix"),
                patch.dict("sys.modules", {"fcntl": FakeFcntl}),
            ):
                instance_lock._lock(handle.fileno(), handle)
                instance_lock._unlock(handle.fileno(), handle)
        finally:
            handle.close()

        self.assertIn(("flock", FakeFcntl.LOCK_EX | FakeFcntl.LOCK_NB), calls)
        self.assertIn(("flock", FakeFcntl.LOCK_UN), calls)


if __name__ == "__main__":
    unittest.main()
