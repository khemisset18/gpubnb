from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.mining_secret_broker import (
    MiningSecretError,
    _secret_path,
    delete_secret,
    resolve_secret,
    secret_status,
    store_secret,
)


class FakeDpapi:
    @staticmethod
    def CryptProtectData(data, *_args):
        return b"enc:" + data[::-1]

    @staticmethod
    def CryptUnprotectData(data, *_args):
        if not data.startswith(b"enc:"):
            raise ValueError("bad blob")
        return ("GPUbnb", data[4:][::-1])


class MiningSecretBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _patch_windows(self):
        return (
            patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="Windows"),
            patch("gpubnb_agent.mining_secret_broker.config_dir", return_value=self.root),
            patch("gpubnb_agent.mining_secret_broker.require_private_directory", side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path),
            patch("gpubnb_agent.mining_secret_broker._windows_dpapi", return_value=FakeDpapi()),
        )

    def test_round_trip_stores_only_ciphertext_under_hashed_name(self) -> None:
        reference = "secret://local/mining/pool-main"
        secret = "correct horse battery staple"
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            status = store_secret(reference, secret)
            path = _secret_path(reference)
            self.assertTrue(status.present)
            self.assertTrue(path.is_file())
            self.assertNotIn("pool-main", path.name)
            raw = path.read_bytes()
            self.assertNotIn(secret.encode("utf-8"), raw)
            self.assertEqual(resolve_secret(reference), secret)

    def test_status_and_delete_never_return_plaintext(self) -> None:
        reference = "secret://local/mining/pool-secondary"
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            store_secret(reference, "s3cret!")
            status = secret_status(reference)
            self.assertEqual(status.reference, reference)
            self.assertEqual(status.backend, "windows-dpapi-machine")
            self.assertTrue(status.present)
            deleted = delete_secret(reference)
            self.assertFalse(deleted.present)
            self.assertFalse(secret_status(reference).present)

    def test_invalid_reference_and_newline_secret_fail_closed(self) -> None:
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_reference_invalid"):
                store_secret("vault://remote/not-local", "secret")
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_invalid"):
                store_secret("secret://local/mining/pool-main", "line1\nline2")

    def test_non_windows_backend_is_explicitly_unsupported(self) -> None:
        with patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="Linux"):
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_backend_unsupported"):
                secret_status("secret://local/mining/pool-main")

    def test_missing_secret_fails_closed(self) -> None:
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_not_found"):
                resolve_secret("secret://local/mining/pool-main")


if __name__ == "__main__":
    unittest.main()
