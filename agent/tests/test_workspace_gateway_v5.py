from __future__ import annotations

import subprocess
import unittest

from gpubnb_agent.gpu_rental_preemption import RentalResourceSpec
from gpubnb_agent.workspace_gateway_v5 import GatewaySupervisor


def spec(resource: str, hardware: str, generation: int = 10) -> RentalResourceSpec:
    return RentalResourceSpec(
        session_id="session_00000001",
        resource_id=resource,
        hardware_uuid=hardware,
        runtime_generation=generation,
        holder_id="rental:session_00000001",
        lease_id=f"lease_{resource}_abcdef",
        fencing_token=str(generation),
    )


class WorkspaceGatewayV5Tests(unittest.TestCase):
    def test_workspace_container_receives_only_allocated_gpu_uuids(self) -> None:
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor._resource_start_context = [
            spec("resource_00000001", "GPU-aaaaaaaa"),
            spec("resource_00000003", "GPU-cccccccc"),
        ]
        calls: list[list[str]] = []

        def docker(args: list[str], timeout: int = 30, check: bool = True):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, "", "")

        supervisor._docker = docker  # type: ignore[method-assign]
        supervisor._launch_workspace_container(
            "gpubnb-workspace-test",
            "gpubnb-volume-test",
            "gpubnb-internal-test",
            "ghcr.io/khemisset18/gpubnb-developer-workspace@sha256:" + "a" * 64,
        )

        command = calls[-1]
        self.assertIn("--gpus", command)
        self.assertEqual(command[command.index("--gpus") + 1], "device=GPU-aaaaaaaa,GPU-cccccccc")
        self.assertNotIn("GPU-bbbbbbbb", " ".join(command))
        self.assertNotIn("device=0", " ".join(command))

    def test_data_workspace_never_attaches_gpus_even_with_an_active_resource_spec(self) -> None:
        # A Data session's booking still reserves a real GPU for exclusivity, so
        # _resource_start_context can be non-empty here too - but the container
        # itself must never receive --gpus, unlike Developer's.
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor._resource_start_context = [spec("resource_00000001", "GPU-aaaaaaaa")]
        calls: list[list[str]] = []

        def docker(args: list[str], timeout: int = 30, check: bool = True):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, "", "")

        supervisor._docker = docker  # type: ignore[method-assign]
        supervisor._launch_workspace_container(
            "gpubnb-workspace-test",
            "gpubnb-volume-test",
            "gpubnb-internal-test",
            "quay.io/jupyter/datascience-notebook@sha256:" + "f" * 64,
            "data",
        )

        command = calls[-1]
        self.assertNotIn("--gpus", command)
        self.assertIn("start-notebook.py", command)

    def test_api_workspace_never_attaches_gpus_even_with_an_active_resource_spec(self) -> None:
        # Same rationale as Data: the booking still reserves a real GPU for
        # exclusivity/billing, so _resource_start_context can be non-empty -
        # but v5 doesn't intercept "api" at all (only "ai"/"video" get the
        # exact-leased-GPU-UUID override), so this falls through to legacy's
        # headless-jupyter_server branch untouched, and must never attach
        # --gpus.
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor._resource_start_context = [spec("resource_00000001", "GPU-aaaaaaaa")]
        calls: list[list[str]] = []

        def docker(args: list[str], timeout: int = 30, check: bool = True):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, "", "")

        supervisor._docker = docker  # type: ignore[method-assign]
        supervisor._launch_workspace_container(
            "gpubnb-workspace-test",
            "gpubnb-volume-test",
            "gpubnb-internal-test",
            "quay.io/jupyter/datascience-notebook@sha256:" + "9" * 64,
            "api",
        )

        command = calls[-1]
        self.assertNotIn("--gpus", command)
        self.assertIn("start-notebook.py", command)
        self.assertIn("DOCKER_STACKS_JUPYTER_CMD=server", command)

    def test_ai_workspace_attaches_only_the_exact_leased_gpu_uuids(self) -> None:
        # Same rationale as Developer: renter-billed GPU compute, never a
        # fixed device index on a multi-GPU host - just launched via the
        # Jupyter/PyTorch entrypoint instead of code-server.
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor._resource_start_context = [
            spec("resource_00000001", "GPU-aaaaaaaa"),
            spec("resource_00000003", "GPU-cccccccc"),
        ]
        calls: list[list[str]] = []

        def docker(args: list[str], timeout: int = 30, check: bool = True):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, "", "")

        supervisor._docker = docker  # type: ignore[method-assign]
        supervisor._launch_workspace_container(
            "gpubnb-workspace-test",
            "gpubnb-volume-test",
            "gpubnb-internal-test",
            "quay.io/jupyter/pytorch-notebook@sha256:" + "b" * 64,
            "ai",
        )

        command = calls[-1]
        self.assertIn("--gpus", command)
        self.assertEqual(command[command.index("--gpus") + 1], "device=GPU-aaaaaaaa,GPU-cccccccc")
        self.assertNotIn("device=0", " ".join(command))
        self.assertIn("start-notebook.py", command)
        self.assertIn("/home/jovyan/work", " ".join(command))

    def test_video_workspace_attaches_only_the_exact_leased_gpu_uuids_and_requests_video_capability(self) -> None:
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor._resource_start_context = [
            spec("resource_00000001", "GPU-aaaaaaaa"),
        ]
        calls: list[list[str]] = []

        def docker(args: list[str], timeout: int = 30, check: bool = True):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, "", "")

        supervisor._docker = docker  # type: ignore[method-assign]
        supervisor._launch_workspace_container(
            "gpubnb-workspace-test",
            "gpubnb-volume-test",
            "gpubnb-internal-test",
            "quay.io/jupyter/datascience-notebook@sha256:" + "c" * 64,
            "video",
        )

        command = calls[-1]
        self.assertIn("--gpus", command)
        self.assertEqual(command[command.index("--gpus") + 1], "device=GPU-aaaaaaaa")
        self.assertIn("--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility,video", command)
        self.assertIn("start-notebook.py", command)

    def test_container_adoption_requires_exact_device_request_set(self) -> None:
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)

        def docker(args: list[str], timeout: int = 30, check: bool = True):
            payload = '[{"Driver":"nvidia","DeviceIDs":["GPU-aaaaaaaa"]}]\n'
            return subprocess.CompletedProcess(args, 0, payload, "")

        supervisor._docker = docker  # type: ignore[method-assign]
        self.assertEqual(supervisor._container_gpu_uuids("workspace"), {"GPU-aaaaaaaa"})
        self.assertNotEqual(supervisor._container_gpu_uuids("workspace"), {"GPU-bbbbbbbb"})

    def test_duplicate_hardware_uuid_is_rejected_before_docker(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "rental_workspace_gpu_uuid_duplicate"):
            GatewaySupervisor._expected_gpu_uuids([
                spec("resource_00000001", "GPU-aaaaaaaa"),
                spec("resource_00000002", "GPU-aaaaaaaa"),
            ])

    def test_missing_protocol_keeps_legacy_machine_wide_fallback(self) -> None:
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor.machine_id = "machine_00000001"
        supervisor._rental_authority_available = True
        supervisor._rental_authority = {"stale": {}}
        supervisor._request = lambda _path: {"sessions": []}  # type: ignore[method-assign]

        supervisor._refresh_rental_authority()

        self.assertFalse(supervisor._rental_authority_available)
        self.assertEqual(supervisor._rental_authority, {})

    def test_explicit_unknown_protocol_fails_closed(self) -> None:
        supervisor = GatewaySupervisor.__new__(GatewaySupervisor)
        supervisor.machine_id = "machine_00000001"
        supervisor._rental_authority_available = False
        supervisor._rental_authority = {}
        supervisor._request = lambda _path: {"protocolVersion": 999, "sessions": []}  # type: ignore[method-assign]

        with self.assertRaisesRegex(RuntimeError, "rental_resource_authority_protocol_invalid"):
            supervisor._refresh_rental_authority()


if __name__ == "__main__":
    unittest.main()
