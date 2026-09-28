from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.mining_secret_broker import (
    MiningSecretError,
    _secret_path,
    backend_name,
    delete_secret,
    resolve_secret,
    rotate_secret,
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


class FailingDpapi:
    @staticmethod
    def CryptProtectData(data, *_args):
        raise ValueError(data.decode("utf-8"))

    @staticmethod
    def CryptUnprotectData(data, *_args):
        raise ValueError(data.decode("utf-8", errors="ignore"))


class FakeMacBackend:
    def __init__(self) -> None:
        self.values: dict[str, bytes] = {}

    def store(self, reference: str, plaintext: bytes) -> None:
        self.values[reference] = plaintext

    def status(self, reference: str) -> bool:
        return reference in self.values

    def resolve(self, reference: str) -> bytes:
        try:
            return self.values[reference]
        except KeyError:
            raise MiningSecretError("mining_secret_not_found") from None

    def delete(self, reference: str) -> None:
        self.values.pop(reference, None)


class FakeSecretTool:
    def __init__(self) -> None:
        self.values: dict[str, bytes] = {}
        self.calls: list[tuple[list[str], bytes | None]] = []

    def run(self, args, *, input=None, stdout=None, stderr=None, timeout=None, check=None):
        argv = list(args)
        self.calls.append((argv, input))
        account = argv[-1]
        action = argv[1]
        if action == "store":
            assert input is not None
            self.values[account] = input
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        if action == "lookup":
            value = self.values.get(account)
            if value is None:
                return subprocess.CompletedProcess(argv, 1, b"", b"")
            return subprocess.CompletedProcess(argv, 0, value, b"")
        if action == "clear":
            self.values.pop(account, None)
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        raise AssertionError(action)


class MiningSecretBrokerTests(unittest.TestCase):
    REFERENCE = "secret://local/mining/pool-main"

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _patch_windows(self, dpapi=FakeDpapi()):
        return (
            patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="Windows"),
            patch("gpubnb_agent.mining_secret_broker.config_dir", return_value=self.root),
            patch(
                "gpubnb_agent.mining_secret_broker.require_private_directory",
                side_effect=lambda path: path.mkdir(parents=True, exist_ok=True) or path,
            ),
            patch("gpubnb_agent.mining_secret_broker._windows_dpapi", return_value=dpapi),
        )

    def test_windows_round_trip_stores_only_ciphertext_under_hashed_name(self) -> None:
        secret = "correct horse battery staple"
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            status = store_secret(self.REFERENCE, secret)
            path = _secret_path(self.REFERENCE)
            self.assertEqual(status.backend, "windows-dpapi-machine")
            self.assertTrue(status.present)
            self.assertTrue(path.is_file())
            self.assertNotIn("pool-main", path.name)
            raw = path.read_bytes()
            self.assertNotIn(secret.encode("utf-8"), raw)
            self.assertEqual(resolve_secret(self.REFERENCE), secret)

    def test_windows_status_rotation_and_delete_never_return_plaintext(self) -> None:
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            store_secret(self.REFERENCE, "first-secret")
            self.assertTrue(secret_status(self.REFERENCE).present)
            rotated = rotate_secret(self.REFERENCE, "second-secret")
            self.assertTrue(rotated.present)
            self.assertEqual(resolve_secret(self.REFERENCE), "second-secret")
            deleted = delete_secret(self.REFERENCE)
            self.assertFalse(deleted.present)
            self.assertFalse(secret_status(self.REFERENCE).present)

    def test_linux_secret_service_uses_stdin_and_unique_hashed_attributes(self) -> None:
        fake = FakeSecretTool()
        secret = "linux-owner-secret"
        with (
            patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="Linux"),
            patch("gpubnb_agent.mining_secret_broker._linux_secret_tool", return_value="/usr/bin/secret-tool"),
            patch("gpubnb_agent.mining_secret_broker.subprocess.run", side_effect=fake.run),
        ):
            status = store_secret(self.REFERENCE, secret)
            self.assertEqual(status.backend, "linux-secret-service-user")
            self.assertEqual(resolve_secret(self.REFERENCE), secret)
            rotate_secret(self.REFERENCE, "rotated-linux-secret")
            self.assertEqual(resolve_secret(self.REFERENCE), "rotated-linux-secret")
            delete_secret(self.REFERENCE)
            self.assertFalse(secret_status(self.REFERENCE).present)

        serialized_argv = repr([args for args, _ in fake.calls])
        self.assertNotIn(secret, serialized_argv)
        self.assertNotIn("rotated-linux-secret", serialized_argv)
        store_inputs = [stdin for args, stdin in fake.calls if args[1] == "store"]
        self.assertEqual(store_inputs, [b"linux-owner-secret", b"rotated-linux-secret"])
        for args, _stdin in fake.calls:
            self.assertNotIn("pool-main", " ".join(args))

    def test_linux_backend_unavailable_fails_closed_without_secret_context(self) -> None:
        secret = "must-never-leak"
        with (
            patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="Linux"),
            patch(
                "gpubnb_agent.mining_secret_broker._linux_secret_tool",
                side_effect=MiningSecretError("mining_secret_backend_unavailable"),
            ),
        ):
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_backend_unavailable") as raised:
                store_secret(self.REFERENCE, secret)
        self.assertNotIn(secret, repr(raised.exception))

    def test_macos_keychain_backend_dispatches_without_process_argv(self) -> None:
        fake = FakeMacBackend()
        with (
            patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="Darwin"),
            patch("gpubnb_agent.mining_secret_broker._macos_backend", return_value=fake),
            patch("gpubnb_agent.mining_secret_broker.subprocess.run") as process,
        ):
            status = store_secret(self.REFERENCE, "mac-secret")
            self.assertEqual(status.backend, "macos-keychain-user")
            self.assertTrue(secret_status(self.REFERENCE).present)
            rotate_secret(self.REFERENCE, "mac-rotated")
            self.assertEqual(resolve_secret(self.REFERENCE), "mac-rotated")
            delete_secret(self.REFERENCE)
            self.assertFalse(secret_status(self.REFERENCE).present)
        process.assert_not_called()

    def test_macos_source_uses_security_framework_not_security_cli(self) -> None:
        source = (
            Path(__file__).parents[1] / "gpubnb_agent" / "mining_secret_broker.py"
        ).read_text(encoding="utf-8")
        for symbol in (
            "SecKeychainFindGenericPassword",
            "SecKeychainAddGenericPassword",
            "SecKeychainItemModifyAttributesAndData",
            "SecKeychainItemDelete",
            "SecKeychainItemFreeContent",
        ):
            self.assertIn(symbol, source)
        self.assertNotIn('["security"', source)
        self.assertNotIn("'security'", source)

    def test_backend_names_are_explicit_by_platform(self) -> None:
        for system, expected in (
            ("Windows", "windows-dpapi-machine"),
            ("Darwin", "macos-keychain-user"),
            ("Linux", "linux-secret-service-user"),
            ("FreeBSD", "unsupported"),
        ):
            with patch("gpubnb_agent.mining_secret_broker.platform.system", return_value=system):
                self.assertEqual(backend_name(), expected)

    def test_invalid_reference_newline_and_missing_rotation_fail_closed(self) -> None:
        patches = self._patch_windows()
        with patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_reference_invalid"):
                store_secret("vault://remote/not-local", "secret")
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_invalid"):
                store_secret(self.REFERENCE, "line1\nline2")
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_not_found"):
                rotate_secret("secret://local/mining/missing", "new-secret")

    def test_windows_backend_exception_does_not_chain_plaintext_into_error(self) -> None:
        secret = "plaintext-that-must-not-hit-crash-report"
        patches = self._patch_windows(FailingDpapi())
        with patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_encrypt_failed") as raised:
                store_secret(self.REFERENCE, secret)
        self.assertNotIn(secret, str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        self.assertIsNone(raised.exception.__context__)

    def test_unsupported_platform_fails_closed(self) -> None:
        with patch("gpubnb_agent.mining_secret_broker.platform.system", return_value="FreeBSD"):
            with self.assertRaisesRegex(MiningSecretError, "mining_secret_backend_unsupported"):
                secret_status(self.REFERENCE)


if __name__ == "__main__":
    unittest.main()
