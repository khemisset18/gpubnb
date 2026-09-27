from __future__ import annotations

from pathlib import Path
import unittest


class MiningSecretRuntimeBoundaryTests(unittest.TestCase):
    def test_only_dedicated_runtime_module_may_resolve_local_pool_secret(self) -> None:
        root = Path(__file__).parents[1] / "gpubnb_agent"
        runtime = (root / "mining_secret_runtime.py").read_text(encoding="utf-8")
        self.assertIn("resolve_secret", runtime)
        self.assertIn("from .mining_secret_broker import", runtime)

        for name in (
            "execution_control.py",
            "gpu_resource_supervisor.py",
            "control_channel_runtime.py",
            "gpu_rental_preemption.py",
        ):
            source = (root / name).read_text(encoding="utf-8")
            self.assertNotIn("resolve_secret", source, name)
            self.assertNotIn("mining_secret_broker", source, name)

    def test_supervisor_receives_only_private_config_path_never_plaintext_password(self) -> None:
        source = (
            Path(__file__).parents[1]
            / "gpubnb_agent"
            / "gpu_resource_supervisor.py"
        ).read_text(encoding="utf-8")
        self.assertIn("prepare_lolminer_secret_config", source)
        self.assertIn('"--config"', source)
        self.assertNotIn('"--pass"', source)
        self.assertNotIn("'--pass'", source)

    def test_control_plane_carries_reference_not_secret_value(self) -> None:
        source = (
            Path(__file__).parents[2]
            / "apps"
            / "api"
            / "src"
            / "mining-resource-control.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("poolCredentialRef", source)
        self.assertIn("secret:\\/\\/local\\/mining", source)
        for forbidden in ("poolPassword", "poolSecretValue", "secretValue", "privateKey", "seedPhrase"):
            self.assertNotIn(forbidden, source)

    def test_runtime_record_and_heartbeat_never_persist_secret_reference_or_config_path(self) -> None:
        source = (
            Path(__file__).parents[1]
            / "gpubnb_agent"
            / "gpu_resource_supervisor.py"
        ).read_text(encoding="utf-8")
        record_start = source.index("@dataclass\nclass RuntimeRecord:")
        record_end = source.index("class SpawnedProcess", record_start)
        record = source[record_start:record_end]
        for forbidden in ("pool_credential_ref", "secret_config", "pool_password"):
            self.assertNotIn(forbidden, record)


if __name__ == "__main__":
    unittest.main()
