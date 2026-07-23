import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.client import signed_headers
from gpubnb_agent.platform_info import parse_nvidia_csv, virtualization_available
from gpubnb_agent.storage import fingerprint, generate_key, load_key, public_key
from gpubnb_agent.runner import diagnostic_command, prepare_workspace, workspace_health_command


class PlatformTests(unittest.TestCase):
    def test_parses_nvidia_smi_csv(self):
        rows = parse_nvidia_csv("NVIDIA RTX 4090, GPU-abc, 24564, 1024, 576.80, 12.8, 48, 31, 125.5\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["vramMiB"], 24564)
        self.assertEqual(rows[0]["cudaVersion"], "12.8")

    def test_rejects_impossible_telemetry(self):
        self.assertEqual(parse_nvidia_csv("GPU, uuid, 100, 200, 1, 1, 500, 200, 1\n"), [])

    def test_virtualization_probe_returns_boolean(self):
        self.assertIsInstance(virtualization_available(), bool)


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


class RunnerTests(unittest.TestCase):
    def test_requires_digest_pinned_image(self):
        with self.assertRaises(RuntimeError):
            diagnostic_command("nvidia/cuda:latest")

    def test_hardens_docker_invocation(self):
        image = "registry.example/gpubnb/diagnostic@sha256:" + ("a" * 64)
        command = diagnostic_command(image)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)
        self.assertIn("--cap-drop=ALL", command)
        self.assertNotIn("--privileged", command)

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_preparation_pulls_uncached_image_and_runs_health_check(self, run):
        image = "registry.example/gpubnb/diagnostic@sha256:" + ("a" * 64)
        run.side_effect = [
            type("Result", (), {"returncode": 1, "stderr": "missing"})(),
            type("Result", (), {"returncode": 0, "stderr": ""})(),
            type("Result", (), {"returncode": 0, "stderr": ""})(),
        ]
        result = prepare_workspace(image, 120)
        self.assertEqual(run.call_args_list[1].args[0][:2], ["docker", "pull"])
        self.assertTrue(result["gpuDetected"])
        self.assertFalse(result["metrics"]["cacheHit"])

    def test_developer_healthcheck_is_inside_hardened_container(self):
        image = "registry.example/gpubnb/developer@sha256:" + ("b" * 64)
        command = workspace_health_command(image, "developer")
        self.assertIn("/usr/local/bin/gpubnb-developer-healthcheck", command)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)


if __name__ == "__main__":
    unittest.main()
