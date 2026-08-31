import unittest
from unittest.mock import Mock, patch

from gpubnb_agent.cli import resolve_developer_workspace_gpu_uuid
from gpubnb_agent.runner import DATA_HOME_TMPFS, DEVELOPER_HOME_TMPFS, MOBILE_HOME_TMPFS, workspace_health_command


IMAGE = "ghcr.io/khemisset18/gpubnb-developer@sha256:" + ("a" * 64)
GPU_UUID = "GPU-11111111-2222-3333-4444-555555555555"


class HomeTmpfsExecTests(unittest.TestCase):
    # Regression guard for a real bug caught by live Docker testing (not by any
    # prior unit test): this Windows/Docker-Desktop/WSL2 host's `--tmpfs` mounts
    # come up `noexec` by default unless `exec` is explicitly requested, which
    # silently broke a renter running their own `chmod +x` script directly from
    # $HOME (exit 126, "Permission denied") in every workspace whose $HOME is a
    # tmpfs - confirmed live against the real, already-shipped Developer image.
    def test_developer_home_tmpfs_is_exec_capable(self):
        self.assertIn(",exec,", DEVELOPER_HOME_TMPFS)

    def test_data_home_tmpfs_is_exec_capable(self):
        self.assertIn(",exec,", DATA_HOME_TMPFS)

    def test_developer_healthcheck_workspace_tmpfs_is_exec_capable(self):
        command = workspace_health_command(IMAGE, "developer", GPU_UUID)
        workspace_tmpfs = next(part for part in command if part.startswith("--tmpfs=/workspace:"))
        self.assertIn(",exec,", workspace_tmpfs)

    # Regression guard for a second real bug, also only caught by live Docker
    # testing: Mobile Workspace's pre-warmed Gradle cache (seeded into $HOME
    # every session) is ~700MB by itself - confirmed live that
    # DEVELOPER_HOME_TMPFS's 512m overflows mid-seed ("No space left on
    # device"), so Mobile needs its own larger tmpfs, not the shared one
    # every other workspace's $HOME is small enough to use.
    def test_mobile_home_tmpfs_is_large_enough_for_the_seeded_gradle_cache(self):
        self.assertIn(",exec,", MOBILE_HOME_TMPFS)
        size = int(MOBILE_HOME_TMPFS.split("size=")[1].split("m,")[0])
        self.assertGreaterEqual(size, 2048, "must comfortably exceed the ~700MB seeded Gradle cache")


class DeveloperWorkspaceHealthCommandTests(unittest.TestCase):
    # F. Developer workspace n'utilise plus device=0 comme sélection du GPU loué.
    def test_command_attaches_the_exact_leased_gpu_by_hardware_uuid(self):
        command = workspace_health_command(IMAGE, "developer", GPU_UUID)
        self.assertIn(f"--gpus=device={GPU_UUID}", command)
        self.assertNotIn("--gpus=device=0", command)

    def test_rejects_missing_or_malformed_target_gpu(self):
        for invalid in (None, "", "short", "device=0; rm -rf /", "0"):
            with self.assertRaisesRegex(RuntimeError, "developer_workspace_invalid_target_gpu"):
                workspace_health_command(IMAGE, "developer", invalid)

    def test_other_workspace_slugs_are_unaffected(self):
        # Regression guard: the GPU_DIAGNOSTIC probe path must keep using its own
        # command builder untouched by the Developer-specific UUID requirement.
        diagnostic_image = "ghcr.io/khemisset18/gpu-diagnostic@sha256:" + ("b" * 64)
        command = workspace_health_command(diagnostic_image, "compute")
        self.assertEqual(command[-1], diagnostic_image)


class DataWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "quay.io/jupyter/datascience-notebook@sha256:" + ("d" * 64)

    def test_data_workspace_never_requests_a_gpu(self):
        # No vramMiB minimum on the Data manifest - the health command (and the
        # real runtime launch it mirrors) must never attach --gpus.
        command = workspace_health_command(self.IMAGE, "data")
        self.assertFalse(any(part.startswith("--gpus") for part in command))
        self.assertFalse(any("NVIDIA_DRIVER_CAPABILITIES" in part for part in command))

    def test_data_workspace_verifies_the_real_python_data_stack_and_a_writable_home(self):
        command = workspace_health_command(self.IMAGE, "data")
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        for module in ("jupyterlab", "notebook", "pandas", "numpy", "scipy", "sklearn"):
            self.assertIn(module, script)
        self.assertIn("/home/jovyan/work", script)

    def test_data_workspace_no_gpu_uuid_required(self):
        # Unlike Developer, omitting gpu_uuid must not raise for Data.
        command = workspace_health_command(self.IMAGE, "data", None)
        self.assertEqual(command[-3], self.IMAGE)


class AudioWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "quay.io/jupyter/datascience-notebook@sha256:" + ("6" * 64)

    def test_audio_workspace_never_requests_a_gpu(self):
        # Audio DSP has no hardware-codec equivalent to Video's NVENC - this
        # workspace legitimately needs no GPU at all, same precedent as Data.
        command = workspace_health_command(self.IMAGE, "audio")
        self.assertFalse(any(part.startswith("--gpus") for part in command))
        self.assertFalse(any("NVIDIA_DRIVER_CAPABILITIES" in part for part in command))

    def test_audio_workspace_no_gpu_uuid_required(self):
        command = workspace_health_command(self.IMAGE, "audio", None)
        self.assertEqual(command[-3], self.IMAGE)

    def test_healthcheck_performs_a_real_loudnorm_pass_not_just_a_filter_list_check(self):
        command = workspace_health_command(self.IMAGE, "audio")
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        self.assertIn("loudnorm", script)
        self.assertIn("ffmpeg", script)
        self.assertIn("/home/jovyan/work", script)


class ApiWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "quay.io/jupyter/datascience-notebook@sha256:" + ("7" * 64)

    def test_api_workspace_never_requests_a_gpu(self):
        # CPU-only headless code-execution surface by design - must stay
        # usable on machines with no GPU at all, same precedent as Data/Audio.
        command = workspace_health_command(self.IMAGE, "api")
        self.assertFalse(any(part.startswith("--gpus") for part in command))
        self.assertFalse(any("NVIDIA_DRIVER_CAPABILITIES" in part for part in command))

    def test_api_workspace_no_gpu_uuid_required(self):
        command = workspace_health_command(self.IMAGE, "api", None)
        self.assertEqual(command[-3], self.IMAGE)

    def test_healthcheck_drives_a_real_rest_and_websocket_kernel_round_trip(self):
        # Not just "the process starts": proves the actual REST+WS API surface
        # this workspace exists to sell actually executes code and returns
        # the real result, mirroring what a renter's own script would do.
        command = workspace_health_command(self.IMAGE, "api")
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        self.assertIn("jupyter", script)
        self.assertIn("/api/kernels", script)
        self.assertIn("execute_request", script)
        self.assertIn("disable_check_xsrf", script)
        self.assertIn('"jupyterlab": False', script)


class MobileWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "gpubnb-mobile-workspace@sha256:" + ("3" * 64)

    def test_mobile_workspace_never_requests_a_gpu(self):
        # A headless Android build needs no GPU - no graphical emulator is
        # offered (/dev/kvm confirmed absent on this host).
        command = workspace_health_command(self.IMAGE, "mobile")
        self.assertFalse(any(part.startswith("--gpus") for part in command))
        self.assertFalse(any("NVIDIA_DRIVER_CAPABILITIES" in part for part in command))

    def test_mobile_workspace_no_gpu_uuid_required(self):
        command = workspace_health_command(self.IMAGE, "mobile", None)
        self.assertEqual(command[-3], self.IMAGE)

    def test_mobile_workspace_tmpfs_mounts_are_exec_capable(self):
        # Regression guard: this host's tmpfs mounts default to noexec, which
        # would silently break gradlew's own execution - see
        # DEVELOPER_HOME_TMPFS's comment in runner.py.
        command = workspace_health_command(self.IMAGE, "mobile")
        home_tmpfs = next(part for part in command if part.startswith("--tmpfs=/home/coder:"))
        workspace_tmpfs = next(part for part in command if part.startswith("--tmpfs=/workspace:"))
        self.assertIn(",exec,", home_tmpfs)
        self.assertIn(",exec,", workspace_tmpfs)

    def test_mobile_workspace_home_tmpfs_and_memory_budget_fit_the_seeded_gradle_cache(self):
        # Regression guard: the seeded Gradle cache is ~700MB - confirmed live
        # that the smaller, shared DEVELOPER_HOME_TMPFS (512m) overflows
        # mid-seed, and that --memory=2g (the other CPU-only healthchecks'
        # budget) is too tight once that tmpfs plus the JVM's own working
        # memory are both counted against the same cgroup.
        command = workspace_health_command(self.IMAGE, "mobile")
        home_tmpfs = next(part for part in command if part.startswith("--tmpfs=/home/coder:"))
        size = int(home_tmpfs.split("size=")[1].split("m,")[0])
        self.assertGreaterEqual(size, 2048)
        self.assertIn("--memory=4g", command)

    def test_healthcheck_drives_a_real_offline_gradle_build(self):
        # Not just "the tools are on PATH": proves a real Android build
        # actually completes fully offline (--network=none) using only the
        # cache pre-warmed into the image at build time, and checks the real
        # .aar output exists.
        command = workspace_health_command(self.IMAGE, "mobile")
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        self.assertIn("gradlew", script)
        self.assertIn("assembleDebug", script)
        self.assertIn("--offline", script)
        self.assertIn("lib-debug.aar", script)


class SecurityLabWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "gpubnb-security-lab-workspace@sha256:" + ("6" * 64)

    def test_security_lab_workspace_never_requests_a_gpu(self):
        # tshark/YARA/radare2 are all CPU-only analysis tools.
        command = workspace_health_command(self.IMAGE, "security-lab")
        self.assertFalse(any(part.startswith("--gpus") for part in command))
        self.assertFalse(any("NVIDIA_DRIVER_CAPABILITIES" in part for part in command))

    def test_security_lab_workspace_no_gpu_uuid_required(self):
        command = workspace_health_command(self.IMAGE, "security-lab", None)
        self.assertEqual(command[-3], self.IMAGE)

    def test_healthcheck_drives_real_functional_proofs_for_all_three_tools(self):
        # Not just "the binaries are on PATH": tshark parses a real pcap,
        # YARA matches a real rule against a real sample, and radare2
        # genuinely analyzes a real ELF binary.
        command = workspace_health_command(self.IMAGE, "security-lab")
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        self.assertIn("tshark", script)
        self.assertIn("yara", script)
        self.assertIn("r2", script)
        self.assertIn("GpubnbHealthcheck", script)


class AiWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "quay.io/jupyter/pytorch-notebook@sha256:" + ("f" * 64)

    def test_command_attaches_the_exact_leased_gpu_by_hardware_uuid(self):
        # Same rationale as Developer: renter-billed GPU compute, never
        # device=0 on a multi-GPU host.
        command = workspace_health_command(self.IMAGE, "ai", GPU_UUID)
        self.assertIn(f"--gpus=device={GPU_UUID}", command)
        self.assertNotIn("--gpus=device=0", command)

    def test_rejects_missing_or_malformed_target_gpu(self):
        for invalid in (None, "", "short", "device=0; rm -rf /", "0"):
            with self.assertRaisesRegex(RuntimeError, "ai_workspace_invalid_target_gpu"):
                workspace_health_command(self.IMAGE, "ai", invalid)

    def test_verifies_torch_actually_sees_cuda_not_just_that_it_imports(self):
        command = workspace_health_command(self.IMAGE, "ai", GPU_UUID)
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        self.assertIn("torch", script)
        self.assertIn("torch.cuda.is_available()", script)
        self.assertIn("torch.cuda.device_count()", script)
        self.assertIn("/home/jovyan/work", script)


class VideoWorkspaceHealthCommandTests(unittest.TestCase):
    IMAGE = "quay.io/jupyter/datascience-notebook@sha256:" + ("7" * 64)

    def test_command_attaches_the_exact_leased_gpu_by_hardware_uuid(self):
        command = workspace_health_command(self.IMAGE, "video", GPU_UUID)
        self.assertIn(f"--gpus=device={GPU_UUID}", command)
        self.assertNotIn("--gpus=device=0", command)

    def test_rejects_missing_or_malformed_target_gpu(self):
        for invalid in (None, "", "short", "device=0; rm -rf /", "0"):
            with self.assertRaisesRegex(RuntimeError, "video_workspace_invalid_target_gpu"):
                workspace_health_command(self.IMAGE, "video", invalid)

    def test_requests_the_video_driver_capability_nvenc_actually_needs(self):
        # Confirmed live: NVENC fails closed ("Cannot load libnvidia-encode.so.1")
        # with only compute,utility - "video" must be included too.
        command = workspace_health_command(self.IMAGE, "video", GPU_UUID)
        self.assertIn("--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility,video", command)

    def test_healthcheck_performs_a_real_nvenc_encode_not_just_a_codec_list_check(self):
        command = workspace_health_command(self.IMAGE, "video", GPU_UUID)
        self.assertEqual(command[-2], "-c")
        self.assertEqual(command[-3], self.IMAGE)
        script = command[-1]
        self.assertIn("h264_nvenc", script)
        self.assertIn("ffmpeg", script)
        self.assertIn("/home/jovyan/work", script)


class ResolveDeveloperWorkspaceGpuUuidTests(unittest.TestCase):
    def _authority(self, session_id, hardware_uuid, resource_id="resource_test01"):
        return {
            "protocolVersion": 1,
            "leaseTtlSeconds": 45,
            "sessions": [{
                "sessionId": session_id,
                "status": "PREPARING",
                "resources": [{
                    "resourceId": resource_id,
                    "hardwareUuid": hardware_uuid,
                    "vendor": "NVIDIA",
                    "lease": {
                        "resourceId": resource_id,
                        "holderId": f"rental:{session_id}",
                        "leaseId": "lease_test0000001",
                        "fencingToken": "1",
                    },
                }],
            }],
        }

    # E. Developer workspace récupère le hardwareUuid depuis rental-authority.
    def test_resolves_hardware_uuid_from_rental_authority(self):
        session_id = "session_test"
        authority = self._authority(session_id, GPU_UUID)

        def fake_agent_request(_api, _key, _machine_id, path, *_args, **_kwargs):
            self.assertEqual(path, "/agent/mining/machine_test/rental-authority")
            return authority

        with (
            patch("gpubnb_agent.cli.agent_request", side_effect=fake_agent_request),
            patch("gpubnb_agent.cli.gpu_inventory", return_value=[{"gpuUuid": GPU_UUID}]),
        ):
            resolved = resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)
        self.assertEqual(resolved, GPU_UUID)

    def test_resolution_is_case_insensitive_against_local_inventory(self):
        session_id = "session_test"
        authority = self._authority(session_id, GPU_UUID)

        with (
            patch("gpubnb_agent.cli.agent_request", return_value=authority),
            patch("gpubnb_agent.cli.gpu_inventory", return_value=[{"gpuUuid": GPU_UUID.lower()}]),
        ):
            resolved = resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)
        self.assertEqual(resolved, GPU_UUID)

    # H. rental authority absente -> fail-closed.
    def test_fails_closed_when_session_absent_from_authority(self):
        session_id = "session_test"
        empty_authority = {"protocolVersion": 1, "leaseTtlSeconds": 45, "sessions": []}
        with patch("gpubnb_agent.cli.agent_request", return_value=empty_authority):
            with self.assertRaisesRegex(RuntimeError, "rental_resource_authority_missing_for_session"):
                resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)

    def test_fails_closed_when_rental_authority_request_itself_fails(self):
        session_id = "session_test"
        with patch("gpubnb_agent.cli.agent_request", side_effect=RuntimeError("API inaccessible: connection refused")):
            with self.assertRaisesRegex(RuntimeError, "connection refused"):
                resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)

    def test_fails_closed_when_session_is_blocked(self):
        session_id = "session_test"
        authority = {
            "protocolVersion": 1,
            "leaseTtlSeconds": 45,
            "sessions": [{"sessionId": session_id, "status": "PREPARING", "blockedReason": "rental_gpu_resource_disabled", "resources": []}],
        }
        with patch("gpubnb_agent.cli.agent_request", return_value=authority):
            with self.assertRaisesRegex(RuntimeError, "rental_gpu_resource_disabled"):
                resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)

    # G. mismatch UUID -> fail-closed.
    def test_fails_closed_when_leased_uuid_is_not_present_on_this_host(self):
        session_id = "session_test"
        authority = self._authority(session_id, GPU_UUID)
        other_local_uuid = "GPU-99999999-8888-7777-6666-555555555555"
        with (
            patch("gpubnb_agent.cli.agent_request", return_value=authority),
            patch("gpubnb_agent.cli.gpu_inventory", return_value=[{"gpuUuid": other_local_uuid}]),
        ):
            with self.assertRaisesRegex(RuntimeError, "developer_workspace_gpu_uuid_not_found_locally"):
                resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)

    def test_fails_closed_when_host_reports_no_gpu_at_all(self):
        session_id = "session_test"
        authority = self._authority(session_id, GPU_UUID)
        with (
            patch("gpubnb_agent.cli.agent_request", return_value=authority),
            patch("gpubnb_agent.cli.gpu_inventory", return_value=[]),
        ):
            with self.assertRaisesRegex(RuntimeError, "developer_workspace_gpu_uuid_not_found_locally"):
                resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)

    def test_fails_closed_on_more_than_one_leased_accelerator(self):
        session_id = "session_test"
        authority = self._authority(session_id, GPU_UUID)
        authority["sessions"][0]["resources"].append({
            "resourceId": "resource_test02",
            "hardwareUuid": "GPU-22222222-3333-4444-5555-666666666666",
            "vendor": "NVIDIA",
            "lease": {
                "resourceId": "resource_test02",
                "holderId": f"rental:{session_id}",
                "leaseId": "lease_test0000002",
                "fencingToken": "1",
            },
        })
        with patch("gpubnb_agent.cli.agent_request", return_value=authority):
            with self.assertRaisesRegex(RuntimeError, "developer_workspace_requires_exactly_one_accelerator"):
                resolve_developer_workspace_gpu_uuid(Mock(), object(), "machine_test", session_id)


if __name__ == "__main__":
    unittest.main()
