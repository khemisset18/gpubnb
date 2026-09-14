from __future__ import annotations

import unittest
from types import SimpleNamespace

from gpubnb_agent.publishability_work_gate import install


class PublishabilityWorkGateTests(unittest.TestCase):
    def make_cli(self, heartbeat_results: list[dict[str, object]]):
        jobs: list[str] = []
        events: list[dict[str, object]] = []
        results = list(heartbeat_results)

        def heartbeat(*_args, **_kwargs):
            return results.pop(0)

        def run_next_job(*_args, **_kwargs):
            jobs.append("started")
            return "job-result"

        module = SimpleNamespace(
            heartbeat=heartbeat,
            run_next_job=run_next_job,
            _publishability_work_gate_installed=False,
        )
        install(module)
        return module, jobs, events

    def test_explicit_false_blocks_normal_job_until_explicit_true(self) -> None:
        module, jobs, events = self.make_cli([
            {"ok": True, "publishable": False},
            {"ok": True, "publishable": True},
        ])

        self.assertEqual(module.heartbeat(), {"ok": True, "publishable": False})
        self.assertIsNone(module.run_next_job(event_sink=events.append))
        self.assertEqual(jobs, [])
        self.assertEqual(events[-1]["event"], "unsafe_work_suspended")
        self.assertEqual(events[-1]["reason"], "heartbeat_not_publishable")

        self.assertEqual(module.heartbeat(), {"ok": True, "publishable": True})
        self.assertEqual(module.run_next_job(event_sink=events.append), "job-result")
        self.assertEqual(jobs, ["started"])

    def test_missing_field_is_legacy_compatible_but_never_clears_existing_block(self) -> None:
        module, jobs, events = self.make_cli([
            {"ok": True},
            {"ok": True, "publishable": False},
            {"ok": True},
        ])

        module.heartbeat()
        self.assertEqual(module.run_next_job(event_sink=events.append), "job-result")
        self.assertEqual(jobs, ["started"])

        module.heartbeat()
        self.assertIsNone(module.run_next_job(event_sink=events.append))
        module.heartbeat()
        self.assertIsNone(module.run_next_job(event_sink=events.append))
        self.assertEqual(jobs, ["started"])

    def test_install_is_idempotent(self) -> None:
        module, _jobs, _events = self.make_cli([{"ok": True}])
        heartbeat = module.heartbeat
        run_next_job = module.run_next_job
        install(module)
        self.assertIs(module.heartbeat, heartbeat)
        self.assertIs(module.run_next_job, run_next_job)


if __name__ == "__main__":
    unittest.main()
