from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpubnb_agent.host_tunnel import HostTunnelSupervisor


class FakeProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self.terminated = 0
        self.killed = 0

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated += 1
        self.returncode = 0

    def kill(self) -> None:
        self.killed += 1
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self.returncode or 0


class HostTunnelSupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.binary = self.root / "gpubnb-host-tunnel"
        self.binary.write_text("test-binary")
        self.now = 100.0
        self.processes: list[FakeProcess] = []
        self.spawns: list[dict] = []
        self.bootstrap_calls: list[str] = []
        self.nonce = 0

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _request(self, api, key, machine_id, path, method, body):
        del api, key, method, body
        self.bootstrap_calls.append(path)
        self.nonce += 1
        return {
            "protocol": "gpubnb-dp/1",
            "edgeId": "edge_paris_1",
            "edgeAddr": "edge.internal:4433",
            "serverName": "edge.internal",
            "caCertPem": "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
            "authority": {
                "edgeId": "edge_paris_1",
                "role": "HOST",
                "binding": {
                    "protocolVersion": 1,
                    "sessionId": "session_1",
                    "machineId": machine_id,
                    "bookingId": "booking_1",
                    "renterUserId": "user_1",
                    "issuedAtMs": 1_000_000 + self.nonce,
                    "expiresAtMs": 1_030_000 + self.nonce,
                    "nonce": f"{self.nonce:064x}",
                },
                "signatureHex": "00" * 64,
            },
            "authorityExpiresAtMs": 1_030_000 + self.nonce,
        }

    def _popen(self, args, **kwargs):
        process = FakeProcess()
        self.processes.append(process)
        self.spawns.append({"args": list(args), **kwargs})
        return process

    def _supervisor(self, random_value: float = 0.0) -> HostTunnelSupervisor:
        return HostTunnelSupervisor(
            api=object(),
            key=object(),
            machine_id="machine_1",
            config={"hostTunnelBinary": str(self.binary)},
            request_func=self._request,
            popen_factory=self._popen,
            clock=lambda: self.now,
            random_func=lambda: random_value,
        )

    def _bootstrap(self) -> dict:
        return self._request(object(), object(), "machine_1", "/bootstrap", "GET", None)

    def test_start_uses_environment_paths_not_authority_on_command_line(self) -> None:
        supervisor = self._supervisor()
        with patch("gpubnb_agent.host_tunnel.config_dir", return_value=self.root / "config"):
            self.assertTrue(supervisor.reconcile("session_1", 41000, True))
        self.assertEqual(len(self.spawns), 1)
        spawn = self.spawns[0]
        self.assertEqual(spawn["args"], [str(self.binary.resolve())])
        self.assertNotIn("signatureHex", " ".join(spawn["args"]))
        env = spawn["env"]
        self.assertEqual(env["GPUBNB_HOST_WORKSPACE_PORT"], "41000")
        authority_path = Path(env["GPUBNB_HOST_AUTHORITY"])
        self.assertTrue(authority_path.is_file())
        self.assertEqual(Path(env["GPUBNB_HOST_EDGE_CA_CERT"]).is_file(), True)
        self.assertEqual(spawn["shell"], False)

    def test_bootstrap_scope_must_match_requested_session_machine_and_edge(self) -> None:
        supervisor = self._supervisor()

        wrong_session = self._bootstrap()
        wrong_session["authority"]["binding"]["sessionId"] = "session_2"
        with self.assertRaisesRegex(RuntimeError, "session_scope_mismatch"):
            supervisor._validate_bootstrap(wrong_session, "session_1")

        wrong_machine = self._bootstrap()
        wrong_machine["authority"]["binding"]["machineId"] = "machine_2"
        with self.assertRaisesRegex(RuntimeError, "machine_scope_mismatch"):
            supervisor._validate_bootstrap(wrong_machine, "session_1")

        wrong_edge = self._bootstrap()
        wrong_edge["authority"]["edgeId"] = "edge_london_1"
        with self.assertRaisesRegex(RuntimeError, "edge_scope_mismatch"):
            supervisor._validate_bootstrap(wrong_edge, "session_1")

    def test_bootstrap_expiry_must_match_signed_binding(self) -> None:
        supervisor = self._supervisor()
        bootstrap = self._bootstrap()
        bootstrap["authorityExpiresAtMs"] += 1
        with self.assertRaisesRegex(RuntimeError, "expiry_invalid"):
            supervisor._validate_bootstrap(bootstrap, "session_1")

    def test_crash_fetches_fresh_authority_and_applies_backoff(self) -> None:
        supervisor = self._supervisor(random_value=0.0)
        with patch("gpubnb_agent.host_tunnel.config_dir", return_value=self.root / "config"):
            self.assertTrue(supervisor.reconcile("session_1", 41000, True))
            first_authority = supervisor.runtimes["session_1"].authority_path.read_text()
            self.processes[0].returncode = 2
            self.assertFalse(supervisor.reconcile("session_1", 41000, True))
            self.assertEqual(len(self.bootstrap_calls), 1)
            self.now += 1.0
            self.assertTrue(supervisor.reconcile("session_1", 41000, True))
            second_authority = supervisor.runtimes["session_1"].authority_path.read_text()
        self.assertEqual(len(self.bootstrap_calls), 2)
        self.assertNotEqual(first_authority, second_authority)

    def test_port_change_replaces_live_tunnel_without_failure_backoff(self) -> None:
        supervisor = self._supervisor()
        with patch("gpubnb_agent.host_tunnel.config_dir", return_value=self.root / "config"):
            self.assertTrue(supervisor.reconcile("session_1", 41000, True))
            first = self.processes[0]
            self.assertTrue(supervisor.reconcile("session_1", 42000, True))
        self.assertEqual(first.terminated, 1)
        self.assertEqual(len(self.processes), 2)
        self.assertEqual(supervisor.runtimes["session_1"].workspace_port, 42000)

    def test_disable_stops_tunnel_and_clears_secret_files(self) -> None:
        supervisor = self._supervisor()
        with patch("gpubnb_agent.host_tunnel.config_dir", return_value=self.root / "config"):
            self.assertTrue(supervisor.reconcile("session_1", 41000, True))
            runtime = supervisor.runtimes["session_1"]
            authority_path = runtime.authority_path
            ca_path = runtime.ca_path
            self.assertFalse(supervisor.reconcile("session_1", 41000, False))
        self.assertFalse(authority_path.exists())
        self.assertFalse(ca_path.exists())
        self.assertNotIn("session_1", supervisor.runtimes)


if __name__ == "__main__":
    unittest.main()
