from __future__ import annotations

import socket
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from gpubnb_agent.control_channel import ControlCommand
from gpubnb_agent.control_channel_runtime import _Runtime
from gpubnb_agent.execution_control import (
    APPROVED_BINARIES,
    ExecutionControlError,
    ExecutionResult,
    build_miner_arguments,
    parse_mining_launch_spec,
    stop_rental,
)


class ExecutionControlPolicyTests(unittest.TestCase):
    @staticmethod
    def _public_dns(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 3333))]

    def test_start_payload_is_allowlisted_and_contains_no_resolved_secret(self) -> None:
        payload = {
            "resourceId": "resource_00000001",
            "profileId": "xmrig_randomx",
            "poolUrl": "stratum+tls://pool.example.com:3333",
            "walletAddress": "wallet123",
            "workerName": "worker01",
            "performanceMode": "BALANCED",
        }
        with patch("gpubnb_agent.execution_control.socket.getaddrinfo", side_effect=self._public_dns):
            spec = parse_mining_launch_spec(payload)
        self.assertEqual(spec.profile_id, "xmrig_randomx")
        self.assertEqual(
            build_miner_arguments(spec),
            [
                "--algo=randomx",
                "--url=stratum+tls://pool.example.com:3333",
                "--user=wallet123.worker01",
            ],
        )

        with patch("gpubnb_agent.execution_control.socket.getaddrinfo", side_effect=self._public_dns):
            with self.assertRaisesRegex(ExecutionControlError, "miner_secret_resolution_required"):
                parse_mining_launch_spec({**payload, "poolCredentialRef": "vault://miners/pool"})

    def test_private_loopback_and_credentialed_pool_urls_fail_closed(self) -> None:
        base = {
            "resourceId": "resource_00000001",
            "profileId": "xmrig_randomx",
            "walletAddress": "wallet123",
            "workerName": "worker01",
            "performanceMode": "ECO",
        }
        with self.assertRaisesRegex(ExecutionControlError, "mining_pool_address_not_public"):
            parse_mining_launch_spec({**base, "poolUrl": "stratum+tcp://127.0.0.1:3333"})
        with self.assertRaisesRegex(ExecutionControlError, "mining_pool_credentials_not_allowed"):
            parse_mining_launch_spec({**base, "poolUrl": "stratum+tls://user:secret@pool.example.com:3333"})
        with self.assertRaisesRegex(ExecutionControlError, "mining_profile_not_approved"):
            parse_mining_launch_spec({**base, "profileId": "trex_rvn_kawpow", "poolUrl": "stratum+tls://pool.example.com:3333"})

    def test_python_manifest_is_locked_to_rust_pinned_binary_hashes(self) -> None:
        manifest = (
            Path(__file__).parents[2]
            / "apps"
            / "host-desktop"
            / "src-tauri"
            / "src"
            / "approved_miner_manifest.rs"
        ).read_text(encoding="utf-8")
        for profile_id, platforms in APPROVED_BINARIES.items():
            self.assertIn(f'"{profile_id}"', manifest)
            for _, expected_sha in platforms.values():
                self.assertIn(expected_sha, manifest)

    def test_stop_rental_targets_only_exact_session_derived_resources(self) -> None:
        calls: list[list[str]] = []

        def docker(args: list[str]):
            calls.append(args)
            result = Mock()
            result.returncode = 0
            result.stdout = ""
            result.stderr = ""
            return result

        with (
            patch("gpubnb_agent.execution_control.stop_mining", return_value=ExecutionResult("mining_stop_verified")),
            patch("gpubnb_agent.execution_control._docker", side_effect=docker),
            patch("gpubnb_agent.execution_control._docker_absent", return_value=True),
        ):
            result = stop_rental({
                "sessionId": "session_0123456789abcdef",
                "workspaceSlug": "developer",
            })

        self.assertEqual(result.detail_code, "rental_cleanup_verified")
        flattened = "\n".join(" ".join(call) for call in calls)
        self.assertIn("gpubnb-dev-", flattened)
        self.assertIn("gpubnb-dev-proxy-", flattened)
        self.assertIn("gpubnb-workspace-", flattened)
        self.assertNotIn("docker system prune", flattened)
        self.assertNotIn("rm -f $(", flattened)

    def test_stop_rental_requires_a_strict_session_identity(self) -> None:
        with self.assertRaisesRegex(ExecutionControlError, "stop_rental_session_id_invalid"):
            stop_rental({"sessionId": "*", "workspaceSlug": "developer"})


class DirectMutationBridgeTests(unittest.TestCase):
    def _runtime(self) -> _Runtime:
        runtime = object.__new__(_Runtime)
        runtime.machine_id = "machine_00000001"
        runtime._mutation_lock = threading.Lock()
        runtime.emit = Mock()
        runtime.gpu_supervisor = Mock()
        return runtime

    @staticmethod
    def _command(
        kind: str,
        payload: object | None = None,
        *,
        lease: dict[str, object] | None = None,
    ) -> ControlCommand:
        return ControlCommand(
            command_id="command_00000001",
            machine_id="machine_00000001",
            sequence=1,
            kind=kind,
            issued_at_ms=1,
            expires_at_ms=2,
            lease=lease,
            payload={} if payload is None else payload,
        )

    @classmethod
    def _mining_command(cls, kind: str) -> ControlCommand:
        payload = {
            "resourceId": "resource_00000001",
            "hardwareUuid": "GPU-aaaaaaaa",
            "runtimeGeneration": "7",
        }
        if kind == "START_MINING":
            payload.update({
                "profileId": "lolminer_etchash",
                "poolUrl": "stratum+tcp://1.1.1.1:4444",
                "walletAddress": "wallet.example-123",
                "workerName": "worker_1",
                "performanceMode": "FULL",
            })
        return cls._command(
            kind,
            payload,
            lease={
                "resourceId": "resource_00000001",
                "holderId": "holder_00000001",
                "leaseId": "lease_00000001",
                "fencingToken": "7",
            },
        )

    def test_mining_telemetry_report_uses_dedicated_signed_endpoint_and_string_counters(self) -> None:
        runtime = self._runtime()
        runtime.api = object()
        runtime.key = object()
        sample = {
            "resourceId": "resource_00000001",
            "hardwareUuid": "GPU-aaaaaaaa",
            "runtimeGeneration": 9_007_199_254_740_993,
            "profileId": "lolminer_etchash",
            "processPid": 4242,
            "temperatureC": 91.0,
            "powerWatts": 44.5,
            "gpuUtilizationPercent": 97.0,
            "memoryUsedMiB": 2048.0,
            "deviceName": "GTX 1650",
            "thermalStopCelsius": 92,
            "hashrate": 80.5,
            "hashrateUnit": "MH/s",
            "acceptedShares": 4,
            "staleShares": 0,
            "hardwareErrors": 0,
            "uptimeSeconds": 65,
            "poolConnected": True,
        }
        with (
            patch("gpubnb_agent.control_channel_runtime.reserve_agent_counter", return_value=123),
            patch("gpubnb_agent.control_channel_runtime.agent_request", return_value={"accepted": True}) as request,
        ):
            runtime._report_mining_telemetry(sample)

        args = request.call_args.args
        self.assertEqual(args[3], "/internal/mining/telemetry")
        self.assertEqual(args[4], "POST")
        body = args[5]
        self.assertEqual(body["agentCounter"], "123")
        self.assertEqual(body["telemetry"]["runtimeGeneration"], "9007199254740993")
        self.assertEqual(body["telemetry"]["hardwareUuid"], "GPU-aaaaaaaa")
        self.assertNotIn("walletAddress", body["telemetry"])
        self.assertNotIn("poolUrl", body["telemetry"])
        self.assertNotIn("rawLog", body["telemetry"])

    def test_stop_mining_returns_terminal_success_only_after_verified_resource_adapter(self) -> None:
        runtime = self._runtime()
        runtime.gpu_supervisor.stop.return_value = ExecutionResult("mining_resource_stop_verified")
        result = runtime._run_mutation(self._mining_command("STOP_MINING"))
        self.assertEqual(result.status, "SUCCEEDED")
        self.assertEqual(result.detail_code, "mining_resource_stop_verified")
        runtime.gpu_supervisor.stop.assert_called_once_with({
            "resourceId": "resource_00000001",
            "hardwareUuid": "GPU-aaaaaaaa",
            "runtimeGeneration": 7,
        })

    def test_stop_rental_rejects_compute_runtime_before_cleanup(self) -> None:
        runtime = self._runtime()
        with patch("gpubnb_agent.control_channel_runtime.stop_rental") as cleanup:
            result = runtime._run_mutation(self._command(
                "STOP_RENTAL",
                {"sessionId": "session_0123456789abcdef", "workspaceSlug": "compute"},
            ))
        self.assertEqual(result.status, "REJECTED")
        self.assertEqual(result.detail_code, "stop_rental_workspace_not_direct")
        cleanup.assert_not_called()

    def test_policy_failure_is_rejected_not_retried_as_execution_failure(self) -> None:
        runtime = self._runtime()
        runtime.gpu_supervisor.start.side_effect = ExecutionControlError(
            "mining_profile_not_resource_gpu_approved"
        )
        result = runtime._run_mutation(self._mining_command("START_MINING"))
        self.assertEqual(result.status, "REJECTED")
        self.assertEqual(result.detail_code, "mining_profile_not_resource_gpu_approved")
        runtime.gpu_supervisor.start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
