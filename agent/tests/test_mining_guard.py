import tempfile
import unittest
from pathlib import Path

from gpubnb_agent.mining_guard import (
    find_running_miners,
    stop_all_miners_and_verify,
)


class FakeInspector:
    def __init__(self, processes: list[tuple[int, str]]) -> None:
        self._processes = processes
        self.terminated: list[int] = []
        self._never_dies: set[int] = set()

    def never_dies(self, pid: int) -> "FakeInspector":
        self._never_dies.add(pid)
        return self

    def running_processes(self) -> list[tuple[int, str]]:
        return list(self._processes)

    def terminate(self, pid: int) -> None:
        self.terminated.append(pid)
        if pid not in self._never_dies:
            self._processes = [(p, path) for p, path in self._processes if p != pid]

    def is_running(self, pid: int) -> bool:
        return any(p == pid for p, _ in self._processes)


class MiningGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.xmrig = self.root / "xmrig.exe"
        self.xmrig.write_bytes(b"fake xmrig")

    def test_no_approved_binaries_installed_reports_nothing(self) -> None:
        empty_root = self.root / "does-not-exist"
        inspector = FakeInspector([(111, str(self.xmrig))])
        self.assertEqual(find_running_miners(empty_root, inspector), [])

    def test_unrelated_processes_are_never_touched(self) -> None:
        unrelated = self.root / "notepad.exe"
        unrelated.write_bytes(b"not a miner")
        inspector = FakeInspector([(222, str(unrelated))])
        self.assertEqual(find_running_miners(self.root, inspector), [])
        self.assertTrue(stop_all_miners_and_verify(self.root, inspector))
        self.assertEqual(inspector.terminated, [])

    def test_running_approved_miner_is_found(self) -> None:
        inspector = FakeInspector([(333, str(self.xmrig))])
        found = find_running_miners(self.root, inspector)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["pid"], 333)

    def test_stop_terminates_and_verifies_death(self) -> None:
        inspector = FakeInspector([(444, str(self.xmrig))])
        self.assertTrue(stop_all_miners_and_verify(self.root, inspector, timeout_seconds=2))
        self.assertEqual(inspector.terminated, [444])
        self.assertFalse(inspector.is_running(444))

    def test_stop_fails_closed_when_process_will_not_die(self) -> None:
        inspector = FakeInspector([(555, str(self.xmrig))]).never_dies(555)
        self.assertFalse(stop_all_miners_and_verify(self.root, inspector, timeout_seconds=1))
        self.assertEqual(inspector.terminated, [555])

    def test_clean_machine_is_a_fast_success_with_no_terminations(self) -> None:
        inspector = FakeInspector([])
        self.assertTrue(stop_all_miners_and_verify(self.root, inspector))
        self.assertEqual(inspector.terminated, [])

    def test_multiple_approved_miners_all_stopped(self) -> None:
        lolminer = self.root / "lolMiner.exe"
        lolminer.write_bytes(b"fake lolminer")
        inspector = FakeInspector([(11, str(self.xmrig)), (22, str(lolminer))])
        self.assertTrue(stop_all_miners_and_verify(self.root, inspector, timeout_seconds=2))
        self.assertEqual(sorted(inspector.terminated), [11, 22])


if __name__ == "__main__":
    unittest.main()
