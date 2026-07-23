import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.client import signed_headers
from gpubnb_agent.platform_info import parse_nvidia_csv
from gpubnb_agent.storage import fingerprint, generate_key, load_key, public_key


class PlatformTests(unittest.TestCase):
    def test_parses_nvidia_smi_csv(self):
        rows = parse_nvidia_csv("NVIDIA RTX 4090, GPU-abc, 24564, 1024, 576.80, 12.8, 48, 31, 125.5\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["vramMiB"], 24564)
        self.assertEqual(rows[0]["cudaVersion"], "12.8")

    def test_rejects_impossible_telemetry(self):
        self.assertEqual(parse_nvidia_csv("GPU, uuid, 100, 200, 1, 1, 500, 200, 1\n"), [])


class KeyTests(unittest.TestCase):
    def test_key_round_trip_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
            created = generate_key()
            loaded = load_key()
            self.assertEqual(bytes(created), bytes(loaded))
            self.assertGreaterEqual(len(public_key()), 32)
            self.assertEqual(len(fingerprint().split(":")), 6)
            if os.name != "nt":
                self.assertEqual(Path(directory, "agent.key").stat().st_mode & 0o777, 0o600)

    def test_signed_headers_are_ed25519(self):
        key = SigningKey.generate()
        headers = signed_headers(key, "machine", "GET", "/agent/challenge/machine")
        self.assertIn("x-agent-signature", headers)
        self.assertIn("x-agent-timestamp", headers)


if __name__ == "__main__":
    unittest.main()
