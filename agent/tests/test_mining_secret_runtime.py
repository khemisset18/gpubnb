from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.mining_secret_runtime import (
    MiningSecretRuntimeError,
    cleanup_lolminer_secret_configs,
    prepare_lolminer_secret_config,
    runtime_secret_config_path,
)


class MiningSecretRuntimeTests(unittest.TestCase):
    REFERENCE = "secret://local/mining/pool-main"
    RESOURCE = "resource_00000001"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_prepare_writes_only_private_lolminer_pass_config(self) -> None:
        secret = "PoolSecret-123_abc"
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value=secret),
        ):
            path = prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
            self.assertEqual(path, runtime_secret_config_path(self.RESOURCE, 7))
            self.assertEqual(path.read_text(encoding="utf-8"), f"pass={secret}\n")
            self.assertNotIn("pool-main", path.name)
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_prepare_cleans_previous_generation_before_writing_new_one(self) -> None:
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value="safe-secret"),
        ):
            first = prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
            second = prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 8)
            self.assertFalse(first.exists())
            self.assertTrue(second.exists())

    def test_cleanup_removes_only_target_resource_secret_configs(self) -> None:
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value="safe-secret"),
        ):
            target = prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
            other = prepare_lolminer_secret_config(
                "secret://local/mining/other-pool",
                "resource_00000002",
                7,
            )
            cleanup_lolminer_secret_configs(self.RESOURCE)
            self.assertFalse(target.exists())
            self.assertTrue(other.exists())

    def test_unsupported_config_characters_fail_before_file_write(self) -> None:
        for secret in ("line1\nline2", "has space", "comment#marker", "quote\"value"):
            with (
                patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
                patch(
                    "gpubnb_agent.mining_secret_runtime.require_private_directory",
                    side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
                ),
                patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value=secret),
            ):
                with self.assertRaisesRegex(MiningSecretRuntimeError, "miner_secret_value_unsupported"):
                    prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)

    def test_backend_error_is_redacted_and_not_chained(self) -> None:
        from gpubnb_agent.mining_secret_broker import MiningSecretError

        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.resolve_secret",
                side_effect=MiningSecretError("mining_secret_not_found"),
            ),
        ):
            with self.assertRaisesRegex(MiningSecretRuntimeError, "mining_secret_not_found") as raised:
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertEqual(str(raised.exception), "mining_secret_not_found")

    @unittest.skipIf(os.name == "nt", "symlink creation is privilege-dependent on Windows CI")
    def test_redirected_runtime_secret_directory_is_rejected_before_secret_resolution(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        redirected = self.root / "mining-runtime-secrets"
        redirected.symlink_to(outside, target_is_directory=True)
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret") as resolve,
        ):
            with self.assertRaisesRegex(
                MiningSecretRuntimeError,
                "miner_secret_config_path_unsafe",
            ):
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
        resolve.assert_not_called()
        self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "symlink creation is privilege-dependent on Windows CI")
    def test_redirected_agent_config_root_is_rejected_before_secret_resolution(self) -> None:
        real = self.root / "real-config"
        real.mkdir()
        redirected = self.root / "agent-config-link"
        redirected.symlink_to(real, target_is_directory=True)
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=redirected),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret") as resolve,
        ):
            with self.assertRaisesRegex(
                MiningSecretRuntimeError,
                "miner_secret_config_path_unsafe",
            ):
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
        resolve.assert_not_called()
        self.assertEqual(list(real.iterdir()), [])

    def test_reparse_point_flag_is_rejected_without_resolving_secret(self) -> None:
        fake_stat = type("FakeStat", (), {"st_file_attributes": 0x400})()
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch.object(Path, "lstat", return_value=fake_stat),
            patch.object(Path, "is_symlink", return_value=False),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret") as resolve,
        ):
            with self.assertRaisesRegex(
                MiningSecretRuntimeError,
                "miner_secret_config_path_unsafe",
            ):
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
        resolve.assert_not_called()

    def test_cleanup_failure_is_fail_closed(self) -> None:
        with patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root):
            root = self.root / "mining-runtime-secrets"
            root.mkdir(parents=True)
            candidate = runtime_secret_config_path(self.RESOURCE, 7)
            candidate.write_text("pass=safe-secret\n", encoding="utf-8")
            with patch.object(Path, "unlink", side_effect=OSError("denied")):
                with self.assertRaisesRegex(
                    MiningSecretRuntimeError,
                    "miner_secret_config_cleanup_failed",
                ):
                    cleanup_lolminer_secret_configs(self.RESOURCE)


if __name__ == "__main__":
    unittest.main()
