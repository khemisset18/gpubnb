from __future__ import annotations

import os
import tempfile
import threading
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

    def test_concurrent_generations_cannot_publish_stale_credential_last(self) -> None:
        first_resolving = threading.Event()
        release_first = threading.Event()
        errors: list[BaseException] = []

        def resolve(reference: str) -> str:
            if reference.endswith("/pool-old"):
                first_resolving.set()
                if not release_first.wait(timeout=2):
                    raise RuntimeError("test_timeout")
                return "old-secret"
            return "new-secret"

        def prepare(reference: str, generation: int) -> None:
            try:
                prepare_lolminer_secret_config(reference, self.RESOURCE, generation)
            except BaseException as exc:
                errors.append(exc)

        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", side_effect=resolve),
        ):
            old = threading.Thread(
                target=prepare,
                args=("secret://local/mining/pool-old", 7),
            )
            new = threading.Thread(
                target=prepare,
                args=("secret://local/mining/pool-new", 8),
            )
            old.start()
            self.assertTrue(first_resolving.wait(timeout=2))
            new.start()
            release_first.set()
            old.join(timeout=2)
            new.join(timeout=2)

            self.assertFalse(old.is_alive())
            self.assertFalse(new.is_alive())
            self.assertEqual(errors, [])
            old_path = runtime_secret_config_path(self.RESOURCE, 7)
            new_path = runtime_secret_config_path(self.RESOURCE, 8)
            self.assertFalse(old_path.exists())
            self.assertEqual(new_path.read_text(encoding="utf-8"), "pass=new-secret\n")

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

    @unittest.skipIf(os.name == "nt", "POSIX chmod failure path")
    def test_post_publish_permission_failure_removes_credential_file(self) -> None:
        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value="safe-secret"),
            patch.object(Path, "chmod", side_effect=OSError("chmod-denied")),
        ):
            path = runtime_secret_config_path(self.RESOURCE, 7)
            with self.assertRaisesRegex(
                MiningSecretRuntimeError,
                "miner_secret_config_write_failed",
            ):
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)
            self.assertFalse(path.exists())

    @unittest.skipIf(os.name == "nt", "POSIX chmod failure path")
    def test_post_publish_cleanup_retries_after_first_unlink_failure(self) -> None:
        original_unlink = Path.unlink
        target: Path | None = None
        target_attempts = 0

        def flaky_unlink(path: Path, *args, **kwargs):
            nonlocal target_attempts
            if path == target:
                target_attempts += 1
                if target_attempts == 1:
                    raise OSError("transient-unlink-denied")
            return original_unlink(path, *args, **kwargs)

        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value="safe-secret"),
            patch.object(Path, "chmod", side_effect=OSError("chmod-denied")),
            patch.object(Path, "unlink", new=flaky_unlink),
        ):
            target = runtime_secret_config_path(self.RESOURCE, 7)
            with self.assertRaisesRegex(
                MiningSecretRuntimeError,
                "miner_secret_config_write_failed",
            ):
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)

        self.assertGreaterEqual(target_attempts, 2)
        self.assertIsNotNone(target)
        self.assertFalse(target.exists())

    @unittest.skipIf(os.name == "nt", "POSIX chmod failure path")
    def test_post_publish_persistent_cleanup_failure_surfaces_fail_closed_code(self) -> None:
        original_unlink = Path.unlink
        target: Path | None = None

        def denied_target_unlink(path: Path, *args, **kwargs):
            if path == target:
                raise OSError("persistent-unlink-denied")
            return original_unlink(path, *args, **kwargs)

        with (
            patch("gpubnb_agent.mining_secret_runtime.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_runtime.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_runtime.resolve_secret", return_value="safe-secret"),
            patch.object(Path, "chmod", side_effect=OSError("chmod-denied")),
            patch.object(Path, "unlink", new=denied_target_unlink),
        ):
            target = runtime_secret_config_path(self.RESOURCE, 7)
            with self.assertRaisesRegex(
                MiningSecretRuntimeError,
                "miner_secret_config_cleanup_failed",
            ) as raised:
                prepare_lolminer_secret_config(self.REFERENCE, self.RESOURCE, 7)

        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)
        self.assertIsNotNone(target)
        self.assertTrue(target.exists())

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
