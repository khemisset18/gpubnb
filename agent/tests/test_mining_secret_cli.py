from __future__ import annotations

import argparse
import unittest
from unittest.mock import Mock, patch

from gpubnb_agent import cli
from gpubnb_agent.mining_secret_broker import MiningSecretStatus


class MiningSecretCliTests(unittest.TestCase):
    REFERENCE = "secret://local/mining/pool-main"

    def test_set_reads_secret_from_masked_prompt_not_argv_and_never_prints_it(self) -> None:
        args = argparse.Namespace(reference=self.REFERENCE)
        status = MiningSecretStatus(self.REFERENCE, "windows-dpapi-machine", True)
        with (
            patch("gpubnb_agent.cli.getpass.getpass", side_effect=["top-secret", "top-secret"]),
            patch("gpubnb_agent.mining_secret_broker.store_secret", return_value=status) as store,
            patch("gpubnb_agent.cli.print_json") as output,
        ):
            self.assertEqual(cli.command_mining_secret_set(args), 0)

        store.assert_called_once_with(self.REFERENCE, "top-secret")
        payload = output.call_args.args[0]
        self.assertEqual(payload["reference"], self.REFERENCE)
        self.assertTrue(payload["present"])
        self.assertNotIn("top-secret", repr(payload))

    def test_set_rejects_confirmation_mismatch_before_storage(self) -> None:
        args = argparse.Namespace(reference=self.REFERENCE)
        with (
            patch("gpubnb_agent.cli.getpass.getpass", side_effect=["one", "two"]),
            patch("gpubnb_agent.mining_secret_broker.store_secret") as store,
        ):
            with self.assertRaisesRegex(RuntimeError, "mining_secret_confirmation_mismatch"):
                cli.command_mining_secret_set(args)
        store.assert_not_called()

    def test_parser_has_no_plaintext_secret_argument(self) -> None:
        parsed = cli.parser().parse_args(["mining-secrets", "set", self.REFERENCE])
        self.assertEqual(parsed.reference, self.REFERENCE)
        with self.assertRaises(SystemExit):
            cli.parser().parse_args([
                "mining-secrets",
                "set",
                self.REFERENCE,
                "must-not-be-an-argv-secret",
            ])

    def test_delete_requires_explicit_confirmation(self) -> None:
        args = argparse.Namespace(reference=self.REFERENCE, yes=False)
        with patch("gpubnb_agent.mining_secret_broker.delete_secret") as delete:
            self.assertEqual(cli.command_mining_secret_delete(args), 2)
        delete.assert_not_called()


if __name__ == "__main__":
    unittest.main()
