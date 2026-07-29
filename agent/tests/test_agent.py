import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.client import signed_headers
from gpubnb_agent.platform_info import parse_nvidia_csv, virtualization_available, machine_fingerprint
from gpubnb_agent.storage import fingerprint, generate_key, load_key, public_key, load_machine_fingerprint, save_machine_fingerprint, detect_hardware_change
from gpubnb_agent.runner import (
    cleanup_workspace,
    diagnostic_command,
    gpu_passthrough_flags,
    prepare_workspace,
    run_gpu_diagnostic,
    verify_protection_profile,
    workspace_health_command,
)


OFFICIAL_IMAGE = "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("a" * 64)


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
            diagnostic_command("ghcr.io/khemisset18/gpu-diagnostic:latest")

    def test_rejects_non_official_registry_image(self):
        image = "registry.example/gpubnb/diagnostic@sha256:" + ("a" * 64)
        with self.assertRaisesRegex(RuntimeError, "image officielle"):
            diagnostic_command(image)

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_hardens_official_docker_invocation(self, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        command = diagnostic_command(OFFICIAL_IMAGE)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)
        self.assertIn("--cap-drop=ALL", command)
        self.assertIn("--security-opt=no-new-privileges", command)
        self.assertIn("--gpus=device=0", command)
        self.assertNotIn("--privileged", command)
        self.assertEqual(command[-1], OFFICIAL_IMAGE)
        self.assertNotIn("nvidia-smi", command)

    def test_gpu_passthrough_flags_are_vendor_aware(self):
        flags = gpu_passthrough_flags()
        self.assertIsInstance(flags, list)

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_official_image_fails_closed_for_amd(self, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "AMD"}]
        with self.assertRaisesRegex(RuntimeError, "supports_nvidia_only"):
            diagnostic_command(OFFICIAL_IMAGE)

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_official_image_fails_closed_for_intel(self, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "INTEL"}]
        with self.assertRaisesRegex(RuntimeError, "supports_nvidia_only"):
            diagnostic_command(OFFICIAL_IMAGE)

    @patch("gpubnb_agent.runner.cleanup_workspace")
    @patch("gpubnb_agent.runner.gpu_inventory")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_parses_official_json_report(self, run, mock_gpu, cleanup):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        cleanup.return_value = {"cleaned": True, "container": "test"}
        run.return_value = type("Result", (), {
            "returncode": 0,
            "stderr": "",
            "stdout": '{"schemaVersion":1,"vendor":"NVIDIA","gpuCount":1,"gpus":[{"index":0,"name":"RTX 4090","uuid":"GPU-1","memoryTotalMiB":24564,"memoryUsedMiB":100,"temperatureC":45}]}'
        })()
        result = run_gpu_diagnostic(OFFICIAL_IMAGE, 120)
        self.assertTrue(result["gpuDetected"])
        self.assertEqual(result["metrics"]["gpuCount"], 1)
        self.assertEqual(result["metrics"]["gpus"][0]["uuid"], "GPU-1")

    @patch("gpubnb_agent.runner.cleanup_workspace")
    @patch("gpubnb_agent.runner.gpu_inventory")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_rejects_gpu_count_mismatch(self, run, mock_gpu, cleanup):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        cleanup.return_value = {"cleaned": True, "container": "test"}
        run.return_value = type("Result", (), {
            "returncode": 0,
            "stderr": "",
            "stdout": '{"schemaVersion":1,"vendor":"NVIDIA","gpuCount":2,"gpus":[]}'
        })()
        with self.assertRaisesRegex(RuntimeError, "gpu_count_mismatch"):
            run_gpu_diagnostic(OFFICIAL_IMAGE, 120)

    @patch("gpubnb_agent.runner.cleanup_workspace")
    @patch("gpubnb_agent.runner.gpu_inventory")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_rejects_impossible_official_telemetry(self, run, mock_gpu, cleanup):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        cleanup.return_value = {"cleaned": True, "container": "test"}
        run.return_value = type("Result", (), {
            "returncode": 0,
            "stderr": "",
            "stdout": '{"schemaVersion":1,"vendor":"NVIDIA","gpuCount":1,"gpus":[{"index":0,"name":"RTX","uuid":"GPU-1","memoryTotalMiB":100,"memoryUsedMiB":101,"temperatureC":45}]}'
        })()
        with self.assertRaisesRegex(RuntimeError, "memory_used"):
            run_gpu_diagnostic(OFFICIAL_IMAGE, 120)

    @patch("gpubnb_agent.runner.gpu_inventory")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_preparation_pulls_uncached_image_and_runs_health_check(self, run, mock_gpu):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        run.side_effect = [
            type("Result", (), {"returncode": 1, "stderr": "missing"})(),
            type("Result", (), {"returncode": 0, "stderr": ""})(),
            type("Result", (), {"returncode": 0, "stderr": "", "stdout": "{}"})(),
        ]
        result = prepare_workspace(OFFICIAL_IMAGE, 120)
        self.assertEqual(run.call_args_list[1].args[0][:2], ["docker", "pull"])
        self.assertTrue(result["gpuDetected"])
        self.assertFalse(result["metrics"]["cacheHit"])

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_cleanup_requires_container_absence(self, run):
        run.side_effect = [
            type("Result", (), {"returncode": 1})(),
            type("Result", (), {"returncode": 0})(),
        ]

        result = cleanup_workspace("gpubnb-diagnostic-test")

        self.assertFalse(result["cleaned"])
        self.assertEqual(run.call_args_list[1].args[0][:3], ["docker", "container", "inspect"])

    @patch("gpubnb_agent.runner.cleanup_workspace")
    @patch("gpubnb_agent.runner.gpu_inventory")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_diagnostic_fails_when_cleanup_cannot_be_verified(self, run, mock_gpu, cleanup):
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        cleanup.return_value = {"cleaned": False, "container": "test"}
        run.return_value = type("Result", (), {
            "returncode": 0,
            "stderr": "",
            "stdout": '{"schemaVersion":1,"vendor":"NVIDIA","gpuCount":1,"gpus":[{"index":0,"name":"RTX 4090","uuid":"GPU-1","memoryTotalMiB":24564,"memoryUsedMiB":100,"temperatureC":45}]}'
        })()

        with self.assertRaisesRegex(RuntimeError, "cleanup_unverified"):
            run_gpu_diagnostic(OFFICIAL_IMAGE, 120)

    @patch("gpubnb_agent.runner.cleanup_workspace")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_protection_profile_uses_inspected_docker_state(self, run, cleanup):
        cleanup.return_value = {"cleaned": True, "container": "probe"}
        run.side_effect = [
            type("Result", (), {"returncode": 0, "stderr": "", "stdout": "probe"})(),
            type("Result", (), {
                "returncode": 0,
                "stderr": "",
                "stdout": (
                    '[{"HostConfig":{"ReadonlyRootfs":true,"CapDrop":["ALL"],'
                    '"SecurityOpt":["no-new-privileges"],"Binds":null,'
                    '"Tmpfs":{"/tmp":"rw,noexec,nosuid,size=8m"},'
                    '"NetworkMode":"none"},"Mounts":[]}]'
                ),
            })(),
        ]

        result = verify_protection_profile(OFFICIAL_IMAGE)

        self.assertTrue(result["isolationVerified"])
        self.assertTrue(result["storageProtected"])
        self.assertTrue(result["networkFiltered"])

    @patch("gpubnb_agent.runner.cleanup_workspace")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_protection_profile_rejects_host_bind_mount(self, run, cleanup):
        cleanup.return_value = {"cleaned": True, "container": "probe"}
        run.side_effect = [
            type("Result", (), {"returncode": 0, "stderr": "", "stdout": "probe"})(),
            type("Result", (), {
                "returncode": 0,
                "stderr": "",
                "stdout": (
                    '[{"HostConfig":{"ReadonlyRootfs":true,"CapDrop":["ALL"],'
                    '"SecurityOpt":["no-new-privileges"],"Binds":["C:\\\\Users:/host"],'
                    '"Tmpfs":{"/tmp":"rw"},"NetworkMode":"none"},"Mounts":[]}]'
                ),
            })(),
        ]

        with self.assertRaisesRegex(RuntimeError, "not_enforced"):
            verify_protection_profile(OFFICIAL_IMAGE)

    def test_developer_healthcheck_is_inside_hardened_container(self):
        image = "registry.example/gpubnb/developer@sha256:" + ("b" * 64)
        command = workspace_health_command(image, "developer")
        self.assertIn("--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", command)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)


if __name__ == "__main__":
    unittest.main()
