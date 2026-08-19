import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from gpubnb_agent.p2p_connectivity import P2PError, verify_rendezvous_ticket_details


class QualificationTicketCompatibilityTests(unittest.TestCase):
    def test_rust_cli_ticket_is_verified_by_agent(self):
        ticket_cli = os.environ.get("GPUBNB_P2P_QUALIFY_TICKET_BIN")
        keygen_cli = os.environ.get("GPUBNB_P2P_QUALIFY_KEYGEN_BIN")
        if not ticket_cli or not keygen_cli:
            self.skipTest("qualification Rust binaries were not supplied")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            private_key, public_key = root / "control.key", root / "control.pub"
            subprocess.run(
                [keygen_cli, "--private-key-output", str(private_key),
                 "--public-key-output", str(public_key)],
                check=True, capture_output=True, text=True,
            )
            host, renter = root / "host.json", root / "renter.json"
            host.write_text(json.dumps({"candidates": [{
                "kind": "HOST", "endpoint": "10.0.0.10:41000", "priority": 100,
            }]}), encoding="utf-8")
            renter.write_text(json.dumps({"candidates": [{
                "kind": "SERVER_REFLEXIVE", "endpoint": "198.51.100.20:42000",
                "priority": 90,
            }]}), encoding="utf-8")
            output = root / "ticket.json"
            subprocess.run(
                [ticket_cli, "--host-candidates", str(host),
                 "--renter-candidates", str(renter),
                 "--host-ephemeral-public-key", "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx",
                 "--renter-ephemeral-public-key", "2RJD1eyFbUmtfR9kW9pWKkeY3J1Y4YEWMrq5X3b2qRZq",
                 "--session-id", "session_qualification_01",
                 "--machine-id", "machine_qualification_01",
                 "--lease-id", "lease_qualification_01",
                 "--fencing-token", "42", "--relay-policy", "DIRECT_ONLY",
                 "--signing-key-file", str(private_key), "--ttl-seconds", "60",
                 "--output", str(output)],
                check=True, capture_output=True, text=True,
            )
            ticket = json.loads(output.read_text(encoding="utf-8"))
            verifying_key = public_key.read_text(encoding="utf-8").strip()

            def verify(value):
                return verify_rendezvous_ticket_details(
                    value, verifying_key,
                    session_id="session_qualification_01",
                    machine_id="machine_qualification_01",
                    lease_id="lease_qualification_01", fencing_token="42",
                    now_ms=int(time.time() * 1_000),
                )

            verified = verify(ticket)
            self.assertEqual(verified.claims["relayPolicy"], "DIRECT_ONLY")
            self.assertEqual(verified.host_candidates[0].kind, "HOST")
            changed = json.loads(json.dumps(ticket))
            changed["claims"]["hostCandidates"][0]["priority"] += 1
            with self.assertRaisesRegex(P2PError, "p2p_ticket_signature_invalid"):
                verify(changed)


if __name__ == "__main__":
    unittest.main()
