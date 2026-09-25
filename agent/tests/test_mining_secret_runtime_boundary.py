from __future__ import annotations

from pathlib import Path
import unittest


class MiningSecretRuntimeBoundaryTests(unittest.TestCase):
    def test_miner_runtime_does_not_resolve_local_pool_secrets(self) -> None:
        root = Path(__file__).parents[1] / "gpubnb_agent"
        for name in ("execution_control.py", "gpu_resource_supervisor.py", "control_channel_runtime.py"):
            source = (root / name).read_text(encoding="utf-8")
            self.assertNotIn("resolve_secret", source, name)
            self.assertNotIn("mining_secret_broker", source, name)

    def test_control_path_keeps_secret_resolution_fail_closed(self) -> None:
        source = (Path(__file__).parents[1] / "gpubnb_agent" / "gpu_resource_supervisor.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("miner_secret_resolution_required", source)


if __name__ == "__main__":
    unittest.main()
