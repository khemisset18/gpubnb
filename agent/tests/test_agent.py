import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.client import ApiClient, heartbeat, signed_headers
from gpubnb_agent import platform_info
from gpubnb_agent.platform_info import parse_nvidia_csv, virtualization_available, machine_fingerprint, docker_info
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

    def test_docker_info_gives_the_runtime_probe_extra_time(self):
        # Regression for a real failure: `docker info` (unlike `docker version`)
        # enumerates the full daemon state and was measured taking up to ~14s on
        # a real Windows/Docker Desktop host under contention (e.g. right after
        # other Docker activity), well past run_command's default 8s timeout. A
        # false timeout there reports nvidiaRuntimeAvailable=False on a host
        # where the NVIDIA Container Toolkit is genuinely installed, which then
        # fails every Developer-workspace compatibility check downstream.
        calls: list[tuple[list[str], int]] = []

        def fake_run_command(command: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
            calls.append((command, timeout))
            if command[1] == "info":
                return subprocess.CompletedProcess(command, 0, '{"nvidia":{}}\n', "")
            return subprocess.CompletedProcess(command, 0, '"27.3.1"', "")

        with patch.object(platform_info.shutil, "which", return_value="/usr/bin/docker"), patch.object(
            platform_info, "run_command", side_effect=fake_run_command
        ):
            result = docker_info()

        self.assertTrue(result["nvidiaRuntime"])
        info_calls = [timeout for command, timeout in calls if command[1] == "info"]
        version_calls = [timeout for command, timeout in calls if command[1] == "version"]
        self.assertEqual(info_calls, [20], "the info probe must request the longer, proven-necessary timeout")
        self.assertEqual(version_calls, [8], "the cheaper version probe is unaffected - still uses the default")

    def test_docker_info_still_reports_false_on_a_genuine_timeout(self):
        # The longer timeout must not turn into "never times out": a daemon that
        # genuinely never answers within 20s must still report nvidiaRuntime as
        # unavailable, not hang the caller (heartbeat loop) indefinitely.
        def fake_run_command(command: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
            if command[1] == "info":
                return subprocess.CompletedProcess(command, 127, "", "command unavailable")
            return subprocess.CompletedProcess(command, 0, '"27.3.1"', "")

        with patch.object(platform_info.shutil, "which", return_value="/usr/bin/docker"), patch.object(
            platform_info, "run_command", side_effect=fake_run_command
        ):
            result = docker_info()

        self.assertFalse(result["nvidiaRuntime"])
        self.assertTrue(result["daemonReachable"])

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
            else:
                # C10: agent.key must not inherit ProgramData's default ACL, which grants
                # the local Users group read access. Query the real, actual ACL icacls
                # applied (not a mock) and confirm it excludes any broad Users/Everyone
                # grant and includes the current user or SYSTEM.
                import subprocess
                result = subprocess.run(
                    ["icacls", str(Path(directory, "agent.key"))],
                    capture_output=True, text=True, shell=False, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                output = result.stdout
                self.assertNotIn("BUILTIN\\Users", output)
                self.assertNotIn(":(R)", output)  # no bare broad read-only grant left over
                self.assertTrue("SYSTEM" in output or os.environ.get("USERNAME", "") in output)

    def test_signed_headers_are_ed25519(self):
        key = SigningKey.generate()
        headers = signed_headers(key, "machine", "GET", "/agent/challenge/machine")
        self.assertIn("x-agent-signature", headers)
        self.assertIn("x-agent-timestamp", headers)


class HeartbeatTests(unittest.TestCase):
    def test_collects_inventory_before_requesting_short_lived_challenge(self):
        events = []
        gpu = {
            "gpuUuid": "GPU-test",
            "gpuModel": "NVIDIA Test",
            "vramMiB": 4096,
            "memoryUsedMiB": 0,
            "driverVersion": "1",
            "cudaVersion": "1",
            "temperatureC": 40,
            "gpuUtilization": 0,
            "powerWatts": 1.0,
            "gpuVendor": "NVIDIA",
        }

        class Client:
            def request(self, path, method="GET", body=None, headers=None, timeout=12):
                events.append("challenge" if path.startswith("/agent/challenge/") else "heartbeat")
                return {"challenge": "challenge-value-long-enough"} if method == "GET" else {"ok": True}

        with (
            patch("gpubnb_agent.client.gpu_inventory", side_effect=lambda: events.append("gpu") or [gpu]),
            patch("gpubnb_agent.client.system_inventory", side_effect=lambda: events.append("system") or {"machineFingerprint": "abc"}),
            patch("gpubnb_agent.client.telemetry_snapshot", side_effect=lambda: events.append("telemetry") or {"schemaVersion": 2, "accelerators": []}),
            patch("gpubnb_agent.client.detect_hardware_change", return_value=(False, None)),
            patch("gpubnb_agent.client.save_machine_fingerprint"),
            patch("gpubnb_agent.client.load_counter", return_value=0),
            patch("gpubnb_agent.client.save_counter"),
        ):
            self.assertEqual(heartbeat(Client(), SigningKey.generate(), "machine-id"), {"ok": True})

        self.assertEqual(events, ["gpu", "system", "telemetry", "challenge", "heartbeat"])

    def test_retry_after_a_transient_failure_uses_a_fresh_challenge_and_signature(self):
        # C9: request_with_retry used to sign headers once outside its own retry loop,
        # so every retry replayed an already-consumed challenge and an already-used
        # signature — both single-use server-side — guaranteeing every retry failed.
        # A retry must now fetch a brand new challenge and produce a different signature.
        gpu = {
            "gpuUuid": "GPU-test", "gpuModel": "NVIDIA Test", "vramMiB": 4096,
            "memoryUsedMiB": 0, "driverVersion": "1", "cudaVersion": "1",
            "temperatureC": 40, "gpuUtilization": 0, "powerWatts": 1.0, "gpuVendor": "NVIDIA",
        }
        calls = {"challenge": 0, "heartbeat_attempts": 0}
        signatures: list[str] = []
        challenges_issued: list[str] = []

        class Client:
            def request(self, path, method="GET", body=None, headers=None, timeout=12):
                if path.startswith("/agent/challenge/"):
                    calls["challenge"] += 1
                    value = f"challenge-{calls['challenge']}-long-enough-value"
                    challenges_issued.append(value)
                    return {"challenge": value}
                calls["heartbeat_attempts"] += 1
                signatures.append(body["signature"])
                if calls["heartbeat_attempts"] == 1:
                    raise RuntimeError("simulated transient network failure")
                return {"ok": True}

        with (
            patch("gpubnb_agent.client.gpu_inventory", return_value=[gpu]),
            patch("gpubnb_agent.client.system_inventory", return_value={"machineFingerprint": "abc"}),
            patch("gpubnb_agent.client.telemetry_snapshot", return_value={"schemaVersion": 2, "accelerators": []}),
            patch("gpubnb_agent.client.detect_hardware_change", return_value=(False, None)),
            patch("gpubnb_agent.client.save_machine_fingerprint"),
            patch("gpubnb_agent.client.load_counter", return_value=0),
            patch("gpubnb_agent.client.save_counter"),
            patch("gpubnb_agent.client.time.sleep"),
        ):
            result = heartbeat(Client(), SigningKey.generate(), "machine-id")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(calls["challenge"], 2, "each attempt must fetch its own fresh challenge")
        self.assertEqual(calls["heartbeat_attempts"], 2)
        self.assertEqual(len(challenges_issued), len(set(challenges_issued)), "challenges must not repeat")
        self.assertEqual(len(signatures), len(set(signatures)), "a retry must never resend an identical signature")

    def test_counter_replay_advances_and_persists_instead_of_looping_forever(self):
        # A local counter file that fell behind the server's lastCounter (crash,
        # uninstall wiping ProgramData before the last save landed, ...) used to be
        # unrecoverable: `counter` was computed once before the retry loop, so every
        # retry — and every subsequent heartbeat cycle, since save_counter() is only
        # called on success — resent the exact same doomed value forever. The agent
        # must now burn the rejected value, persist it so it's never reused, and try
        # the next one until it catches up with the server.
        gpu = {
            "gpuUuid": "GPU-test", "gpuModel": "NVIDIA Test", "vramMiB": 4096,
            "memoryUsedMiB": 0, "driverVersion": "1", "cudaVersion": "1",
            "temperatureC": 40, "gpuUtilization": 0, "powerWatts": 1.0, "gpuVendor": "NVIDIA",
        }
        server_last_counter = 1607 + 3  # server is 3 heartbeats ahead of the local file
        saved_counters: list[int] = []

        class Client:
            def request(self, path, method="GET", body=None, headers=None, timeout=12):
                if path.startswith("/agent/challenge/"):
                    return {"challenge": "challenge-value-long-enough"}
                if body["counter"] <= server_last_counter:
                    raise RuntimeError('API HTTP 409: {"error":"counter_replay"}')
                return {"ok": True}

        with (
            patch("gpubnb_agent.client.gpu_inventory", return_value=[gpu]),
            patch("gpubnb_agent.client.system_inventory", return_value={"machineFingerprint": "abc"}),
            patch("gpubnb_agent.client.telemetry_snapshot", return_value={"schemaVersion": 2, "accelerators": []}),
            patch("gpubnb_agent.client.detect_hardware_change", return_value=(False, None)),
            patch("gpubnb_agent.client.save_machine_fingerprint"),
            patch("gpubnb_agent.client.load_counter", return_value=1607),
            patch("gpubnb_agent.client.save_counter", side_effect=saved_counters.append),
        ):
            result = heartbeat(Client(), SigningKey.generate(), "machine-id")

        self.assertEqual(result, {"ok": True})
        # Every burned attempt (1608, 1609, 1610) must be persisted, plus the final
        # accepted one (1611) — never the same value reused, never a gap skipped.
        self.assertEqual(saved_counters, [1608, 1609, 1610, 1611])

    def test_counter_replay_gives_up_after_the_resync_limit_without_reusing_values(self):
        from gpubnb_agent.client import COUNTER_REPLAY_RESYNC_LIMIT

        gpu = {
            "gpuUuid": "GPU-test", "gpuModel": "NVIDIA Test", "vramMiB": 4096,
            "memoryUsedMiB": 0, "driverVersion": "1", "cudaVersion": "1",
            "temperatureC": 40, "gpuUtilization": 0, "powerWatts": 1.0, "gpuVendor": "NVIDIA",
        }
        saved_counters: list[int] = []

        class Client:
            def request(self, path, method="GET", body=None, headers=None, timeout=12):
                if path.startswith("/agent/challenge/"):
                    return {"challenge": "challenge-value-long-enough"}
                raise RuntimeError('API HTTP 409: {"error":"counter_replay"}')

        with (
            patch("gpubnb_agent.client.gpu_inventory", return_value=[gpu]),
            patch("gpubnb_agent.client.system_inventory", return_value={"machineFingerprint": "abc"}),
            patch("gpubnb_agent.client.telemetry_snapshot", return_value={"schemaVersion": 2, "accelerators": []}),
            patch("gpubnb_agent.client.detect_hardware_change", return_value=(False, None)),
            patch("gpubnb_agent.client.save_machine_fingerprint"),
            patch("gpubnb_agent.client.load_counter", return_value=0),
            patch("gpubnb_agent.client.save_counter", side_effect=saved_counters.append),
        ):
            with self.assertRaises(RuntimeError):
                heartbeat(Client(), SigningKey.generate(), "machine-id")

        self.assertEqual(saved_counters, list(range(1, COUNTER_REPLAY_RESYNC_LIMIT + 1)))
        self.assertEqual(len(saved_counters), len(set(saved_counters)), "no burned counter may be reused")


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

    @patch("gpubnb_agent.runner.gpu_inventory")
    def test_gpu_passthrough_never_disables_seccomp(self, mock_gpu):
        for vendor in ("NVIDIA", "AMD", "INTEL"):
            mock_gpu.return_value = [{"gpuVendor": vendor}]
            flags = gpu_passthrough_flags()
            self.assertNotIn("--security-opt=seccomp=unconfined", flags)

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
        self.assertEqual(result["metrics"]["firstGpuUuid"], "GPU-1")

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
            type("Result", (), {"returncode": 0, "stderr": ""})(),
            type("Result", (), {"returncode": 0, "stderr": "", "stdout": "{}"})(),
        ]
        result = prepare_workspace(OFFICIAL_IMAGE, 120)
        self.assertEqual(run.call_count, 4)
        self.assertEqual(run.call_args_list[0].args[0][:3], ["docker", "image", "inspect"])
        self.assertEqual(run.call_args_list[1].args[0][:2], ["docker", "pull"])
        self.assertEqual(run.call_args_list[2].args[0][:3], ["docker", "image", "inspect"])
        self.assertEqual(run.call_args_list[3].args[0], workspace_health_command(OFFICIAL_IMAGE, "compute"))
        self.assertTrue(result["gpuDetected"])
        self.assertFalse(result["metrics"]["cacheHit"])

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_cleanup_requires_container_absence(self, run):
        run.side_effect = [
            type("Result", (), {"returncode": 0})(),
            type("Result", (), {"returncode": 0, "stdout": "container-id\n"})(),
        ]

        result = cleanup_workspace("gpubnb-diagnostic-test")

        self.assertFalse(result["cleaned"])
        self.assertEqual(run.call_args_list[1].args[0][:4], ["docker", "container", "ls", "-a"])

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_cleanup_rejects_docker_daemon_failure(self, run):
        run.side_effect = [
            type("Result", (), {"returncode": 1})(),
            type("Result", (), {"returncode": 1, "stdout": ""})(),
        ]

        result = cleanup_workspace("gpubnb-diagnostic-test")

        self.assertFalse(result["cleaned"])
        self.assertEqual(result["verificationExitCode"], 1)

    @patch("gpubnb_agent.runner.subprocess.run")
    def test_cleanup_accepts_verified_absence(self, run):
        run.side_effect = [
            type("Result", (), {"returncode": 0})(),
            type("Result", (), {"returncode": 0, "stdout": ""})(),
        ]

        self.assertTrue(cleanup_workspace("gpubnb-diagnostic-test")["cleaned"])

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
    @patch("gpubnb_agent.runner.gpu_inventory")
    @patch("gpubnb_agent.runner.subprocess.run")
    def test_diagnostic_container_hang_is_reported_as_a_timeout(self, run, mock_gpu, cleanup):
        # RC1 Phase 5 Test 2: a container that never exits must not hang the agent
        # forever or be silently swallowed — subprocess.run's own timeout must fire
        # and be surfaced as a stable, documented error code. Reproduced live
        # end-to-end too (real subprocess.run(timeout=30) against a stalling
        # `docker run`, via a substituted docker executable on PATH): raised the
        # exact same RuntimeError("diagnostic_timeout") after ~34s, twice.
        mock_gpu.return_value = [{"gpuVendor": "NVIDIA"}]
        cleanup.return_value = {"cleaned": True, "container": "test"}

        def raise_timeout(*args, **kwargs):
            if args and args[0][:2] == ["docker", "run"]:
                raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout", 30))
            return type("Result", (), {"returncode": 0, "stderr": "", "stdout": ""})()

        run.side_effect = raise_timeout

        with self.assertRaisesRegex(RuntimeError, "^diagnostic_timeout$"):
            run_gpu_diagnostic(OFFICIAL_IMAGE, 120)
        cleanup.assert_called_once()

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
        command = workspace_health_command(image, "developer", "GPU-11111111-2222-3333-4444-555555555555")
        self.assertIn("--entrypoint=/usr/local/bin/gpubnb-developer-healthcheck", command)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)

    def test_developer_workspace_is_writable_without_a_host_bind(self):
        # manifest.json declares /workspace as writable and forbids "ownerHomeMount".
        # --read-only otherwise locks the image's baked-in /workspace directory too,
        # so a real run of this command against the built image failed every single
        # time with "not writable" before this test existed — nothing here caught it
        # because the assertions above never looked past the entrypoint/isolation flags.
        #
        # uid=1000,gid=1000 is required too: a bare --tmpfs mount defaults to root:root
        # mode 0700, which the image's non-root "coder" user (uid/gid 1000) can't write
        # to either. That gap survived this test once already, since asserting the flag
        # string is present doesn't prove the mount is actually usable — only running the
        # real command against the published image against did.
        image = "registry.example/gpubnb/developer@sha256:" + ("b" * 64)
        command = workspace_health_command(image, "developer", "GPU-11111111-2222-3333-4444-555555555555")
        self.assertIn(
            "--tmpfs=/workspace:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700", command
        )
        self.assertIn(
            "--tmpfs=/home/coder:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0700", command
        )
        self.assertFalse(
            any(flag in ("--volume", "-v") or flag.startswith(("--volume=", "-v=")) for flag in command),
            "the developer workspace must never bind-mount a host path, including the owner's home directory",
        )


class FileTransferSigningTests(unittest.TestCase):
    def test_upload_file_signs_the_exact_uploaded_bytes(self):
        # C11: upload_file() used to send no x-agent-signature headers at all —
        # artifact upload was authenticated only by a guessable ID in the URL.
        import hashlib
        import base58 as base58_module
        from nacl.signing import VerifyKey

        key = SigningKey.generate()
        machine_id = "machine-under-test"
        content = b"real artifact bytes, not json"

        with tempfile.TemporaryDirectory() as directory:
            file_path = Path(directory, "artifact.bin")
            file_path.write_bytes(content)

            captured: dict[str, Any] = {}

            class FakeResponse:
                status = 201
                def read(self, _n): return b'{"ok":true}'
                def __enter__(self): return self
                def __exit__(self, *args): return False

            def fake_urlopen(request, timeout=None, context=None):
                captured["headers"] = {k.lower(): v for k, v in request.header_items()}
                captured["data"] = request.data
                return FakeResponse()

            client_instance = ApiClient("http://localhost:8787")
            with patch("gpubnb_agent.client.urllib.request.urlopen", side_effect=fake_urlopen):
                client_instance.upload_file("/jobs/job-1/artifacts?machineId=m", "job-1", str(file_path), key, machine_id)

        headers = captured["headers"]
        for name in ("x-agent-signature-v2", "x-agent-nonce", "x-agent-body-sha256", "x-agent-timestamp"):
            self.assertIn(name, headers, f"missing {name}")

        actual_body_sha256 = hashlib.sha256(captured["data"]).hexdigest()
        self.assertEqual(headers["x-agent-body-sha256"], actual_body_sha256, "signed hash must match the bytes actually sent")

        v2_canonical = (
            f"POST|/jobs/job-1/artifacts|{machine_id}|"
            f"{headers['x-agent-timestamp']}|{headers['x-agent-nonce']}|{actual_body_sha256}"
        )
        verify_key = VerifyKey(bytes(key.verify_key))
        verify_key.verify(v2_canonical.encode(), base58_module.b58decode(headers["x-agent-signature-v2"]))


if __name__ == "__main__":
    unittest.main()