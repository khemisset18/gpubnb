"""Offline adversarial fixtures only; never invoke a Dogecoin executable."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import unittest

from network_identity import (AUTHORIZATION, D0_COMMIT, D0_RUN, GENESIS, SHA256,
                              authorize, decode_cli_observations, validate_handoff,
                              rpc_arguments, validate_namespace, validate_network, validate_server_rpc_methods)


class NetworkIdentityTests(unittest.TestCase):
    def observed(self):
        return {"blockchain": {"chain": "regtest", "blocks": 0, "headers": 0, "bestblockhash": GENESIS},
                "genesis": GENESIS, "network": {"version": 1140900,
                "subversion": "/Shibetoshi:1.14.9/", "connections": 0}, "peers": []}

    def test_accepts_expected_offline_fixture(self):
        validate_network(self.observed())

    def test_pinned_cli_string_results_are_unquoted(self):
        fixture = self.observed()
        observed = decode_cli_observations(json.dumps(fixture["blockchain"]), GENESIS + "\n",
                                           json.dumps(fixture["network"]), "[]\n")
        self.assertEqual(observed, fixture)
        with self.assertRaises(ValueError):
            decode_cli_observations(json.dumps(fixture["blockchain"]), json.dumps(GENESIS),
                                    json.dumps(fixture["network"]), "[]")

    def test_wallet_mining_and_broadcast_rpc_are_forbidden(self):
        self.assertEqual(rpc_arguments("cli", ["-regtest=1"], "getblockhash", "0")[-2:],
                         ["getblockhash", "0"])
        for method in ("sendrawtransaction", "sendtoaddress", "generate", "loadwallet", "getnewaddress"):
            with self.subTest(method=method), self.assertRaises(ValueError):
                rpc_arguments("cli", [], method)
        with self.assertRaises(ValueError): rpc_arguments("cli", [], "getblockhash", "1")

    def test_server_rpc_log_must_contain_only_identity_methods_and_final_stop(self):
        methods = ['getblockchaininfo', 'getblockhash', 'getnetworkinfo', 'getpeerinfo', 'stop']
        def log(items): return '\n'.join('ThreadRPCServer method=' + item for item in items)
        self.assertEqual(validate_server_rpc_methods(log(methods)), methods)
        for bad in [[], methods[:-1], methods + ['sendrawtransaction'], methods + ['getnetworkinfo']]:
            with self.subTest(methods=bad), self.assertRaises(ValueError): validate_server_rpc_methods(log(bad))

    def test_rejects_mainnet_testnet_and_wrong_genesis(self):
        for chain in ("main", "test", "bitcoin", "REGTEST"):
            value = self.observed(); value["blockchain"]["chain"] = chain
            with self.subTest(chain=chain), self.assertRaises(ValueError): validate_network(value)
        for key in ("genesis", "bestblockhash"):
            value = self.observed()
            if key == "genesis": value[key] = "00" * 32
            else: value["blockchain"][key] = "00" * 32
            with self.subTest(key=key), self.assertRaises(ValueError): validate_network(value)

    def test_rejects_nonfresh_chain_and_boolean_counts(self):
        for key in ("blocks", "headers"):
            for number in (1, -1, False, "0"):
                value = self.observed(); value["blockchain"][key] = number
                with self.subTest(key=key, number=number), self.assertRaises(ValueError): validate_network(value)

    def test_rejects_peers_version_suffix_and_connections(self):
        changes = [("version", 1140800), ("subversion", "/Shibetoshi:1.14.9.0-e0a1c1577/"),
                   ("connections", 1), ("connections", False)]
        for key, value in changes:
            observed = self.observed(); observed["network"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError): validate_network(observed)
        observed = self.observed(); observed["peers"] = [{"addr": "127.0.0.1"}]
        with self.assertRaises(ValueError): validate_network(observed)

    def test_network_namespace_requires_new_loopback_only(self):
        links = [{"ifname": "lo", "flags": ["UP"]}]
        validate_namespace("net:[1]", "net:[2]", links)
        for parent, current, interfaces in [("net:[1]", "net:[1]", links),
                ("net:[1]", "net:[2]", links + [{"ifname": "eth0"}]),
                ("net:[1]", "net:[2]", [{"ifname": "lo", "flags": []}])]:
            with self.subTest(interfaces=interfaces), self.assertRaises(ValueError):
                validate_namespace(parent, current, interfaces)

    def handoff(self, predicate, content):
        return [{"verificationResult": {"signature": {"certificate": {
            "sourceRepositoryIdentifier": "1305325878", "sourceRepositoryOwnerIdentifier": "103233875",
            "sourceRepositoryDigest": D0_COMMIT, "buildSignerDigest": D0_COMMIT,
            "runInvocationURI": D0_RUN, "runnerEnvironment": "github-hosted"}},
            "statement": {"predicateType": predicate, "subject": [{"digest": {"sha256": SHA256}}],
                          "predicate": content}, "verifiedTimestamps": [{"type": "Tlog"}]}}]

    def test_exact_signed_sbom_and_d0_identity_are_required(self):
        sbom = {"spdxVersion": "SPDX-2.3", "files": []}
        provenance = self.handoff("https://slsa.dev/provenance/v1", {})
        signed = self.handoff("https://spdx.dev/Document/v2.3", sbom)
        validate_handoff(provenance, signed, sbom)
        for key in ("sourceRepositoryIdentifier", "sourceRepositoryOwnerIdentifier",
                    "sourceRepositoryDigest", "buildSignerDigest", "runInvocationURI", "runnerEnvironment"):
            bad = deepcopy(provenance)
            bad[0]["verificationResult"]["signature"]["certificate"][key] = "wrong"
            with self.subTest(key=key), self.assertRaises(ValueError): validate_handoff(bad, signed, sbom)
        changed = deepcopy(sbom); changed["files"] = ["tampered"]
        with self.assertRaises(ValueError): validate_handoff(provenance, signed, changed)

    def test_missing_wrong_or_multi_attestations_are_rejected(self):
        sbom = {"spdxVersion": "SPDX-2.3"}
        provenance = self.handoff("https://slsa.dev/provenance/v1", {})
        signed = self.handoff("https://spdx.dev/Document/v2.3", sbom)
        for value in ([], provenance * 2):
            with self.assertRaises(ValueError): validate_handoff(value, signed, sbom)
        bad = deepcopy(provenance); bad[0]["verificationResult"]["verifiedTimestamps"] = []
        with self.assertRaises(ValueError): validate_handoff(bad, signed, sbom)
        bad = deepcopy(signed); bad[0]["verificationResult"]["statement"]["subject"][0]["digest"]["sha256"] = "00" * 32
        with self.assertRaises(ValueError): validate_handoff(provenance, bad, sbom)

    def test_authorization_is_distinct_and_missing_token_fails_before_work(self):
        authorize(AUTHORIZATION)
        for value in (None, "", "yes", "D0_PASS"):
            with self.assertRaises(ValueError): authorize(value)
        script = Path(__file__).with_name("run-isolated.sh")
        result = subprocess.run(["bash", str(script), "/missing-d0", "/must-not-be-created", "yes"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("AUTHORIZE_D1_ISOLATED_REGTEST", result.stderr)


if __name__ == "__main__":
    unittest.main()
