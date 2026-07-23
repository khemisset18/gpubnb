import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.client import signed_headers
from gpubnb_agent.platform_info import parse_nvidia_csv, virtualization_available, machine_fingerprint
from gpubnb_agent.storage import fingerprint, generate_key, load_key, public_key, load_machine_fingerprint, save_machine_fingerprint, detect_hardware_change
from gpubnb_agent.runner import diagnostic_command, prepare_workspace, workspace_health_command, gpu_passthrough_flags


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

    def test_machine_fingerprint_is_stable(self):
        fp1 = machine_fingerprint()
        fp2 = machine_fingerprint()
        self.assertEqual(fp1, fp2)
        self.assertEqual(len(fp1), 32)
        self.assertRegex(fp1, r'^[a-f0-9]{32}$')


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_persistence_and_change_detection(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
            self.assertIsNone(load_machine_fingerprint())
            save_machine_fingerprint("abc123")
            self.assertEqual(load_machine_fingerprint(), "abc123")
            changed, prev = detect_hardware_change("abc123")
            self.assertFalse(changed)
            changed, prev = detect_hardware_change("different")
            self.assertTrue(changed)
            self.assertEqual(prev, "abc123")

    def test_first_fingerprint_saves_and_no_change(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GPUBNB_CONFIG_DIR": directory}):
            changed, prev = detect_hardware_change("newfp")
            self.assertFalse(changed)
            self.assertIsNone(prev)
            self.assertEqual(load_machine_fingerprint(), "newfp")


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

    def test_gpu_passthrough_flags_are_vendor_aware(self):
        flags = gpu_passthrough_flags()
        self.assertIsInstance(flags, list)

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_diagnostic_command_uses_amd_tool_for_amd_gpu(self, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "AMD", "gpuModel": "RX 7900", "gpuUuid": "amd-1", "vramMiB": 24576, "driverVersion": "rocm-6.0", "gpuUtilization": 0, "memoryUsedMiB": 0, "temperatureC": 40}]
        image = "registry.example/gpubnb/diagnostic@sha256:" + ("a" * 64)
        command = diagnostic_command(image)
        self.assertIn("rocm-smi", command)
        self.assertNotIn("nvidia-smi", command)

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_diagnostic_command_uses_intel_tool_for_intel_gpu(self, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "INTEL", "gpuModel": "Arc A770", "gpuUuid": "intel-1", "vramMiB": 16384, "driverVersion": "xpu-1.0", "gpuUtilization": 0, "memoryUsedMiB": 0, "temperatureC": 35}]
        image = "registry.example/gpubnb/diagnostic@sha256:" + ("a" * 64)
        command = diagnostic_command(image)
        self.assertIn("xpu-smi", command)
        self.assertNotIn("nvidia-smi", command)

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_diagnostic_command_uses_nvidia_tool_for_nvidia_gpu(self, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA", "gpuModel": "RTX 4090", "gpuUuid": "GPU-1", "vramMiB": 24576, "driverVersion": "550.0", "gpuUtilization": 0, "memoryUsedMiB": 0, "temperatureC": 40}]
        image = "registry.example/gpubnb/diagnostic@sha256:" + ("a" * 64)
        command = diagnostic_command(image)
        self.assertIn("nvidia-smi", command)

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
        self.assertIn("--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", command)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)


if __name__ == "__main__":
    unittest.main()
