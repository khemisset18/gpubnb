"""Standard-library adversarial tests for the independent Stage 4 verifier."""
from __future__ import annotations

import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import verify_stage4_package as verifier  # noqa: E402


COMMIT = "1234567890abcdef1234567890abcdef12345678"
PUBLISHER = "200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a"


def minimal_amd64_pe() -> bytes:
    data = bytearray(1024)
    data[0:2] = b"MZ"
    pe = 128
    struct.pack_into("<I", data, 60, pe)
    data[pe:pe + 4] = b"PE\0\0"
    struct.pack_into("<HH", data, pe + 4, 0x8664, 1)
    struct.pack_into("<H", data, pe + 20, 240)
    optional = pe + 24
    struct.pack_into("<H", data, optional, 0x20B)
    struct.pack_into("<I", data, optional + 108, 16)
    struct.pack_into("<II", data, optional + 120, 0x1000, 40)
    section = optional + 240
    struct.pack_into("<IIII", data, section + 8, 512, 0x1000, 512, 512)
    struct.pack_into("<I", data, 512 + 12, 0x1040)
    data[576:589] = b"KERNEL32.dll\0"
    return bytes(data)


class PackageVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        identity = {
            "agent": {"frozen": True, "agentVersion": "0.6.6", "buildCommit": COMMIT},
            "agentRuntime": {"idnaCodec": True, "dnsResolution": True, "tlsContext": True},
            "helper": {"sourceCommit": COMMIT, "workerSignerSha256": PUBLISHER,
                       "mutationAuthority": "release-candidate", "workerProtocol": 1,
                       "mediaTransportProtocol": 2, "browserMediaProtocol": 1,
                       "browserInputProtocol": 1},
            "worker": {"sourceCommit": COMMIT, "mediaSignerSha256": PUBLISHER},
            "media": {"sourceCommit": COMMIT, "mediaAbi": 2, "nvencApi": "13.0"},
        }
        identity_path = self.root / "build-identities.json"
        identity_path.write_text(json.dumps(identity), encoding="utf-8")
        files = []
        pe = minimal_amd64_pe()
        for name in verifier.NAMES:
            (self.root / name).write_bytes(pe)
            files.append({"name": name, "sha256": verifier.sha(self.root / name),
                          "architecture": "AMD64", "imports": ["kernel32.dll"]})
        manifest = {
            "schemaVersion": 2, "kind": "STAGE4_UNSIGNED_PRIVATE_CANDIDATE",
            "signatureStatus": "unsigned", "sourceCommit": COMMIT,
            "publisherSha256": PUBLISHER, "protocols": verifier.PROTOCOLS,
            "installable": False, "publicBookabilityEnabled": False,
            "iddDriverIncluded": False,
            "buildIdentitiesSha256": verifier.sha(identity_path), "files": files,
        }
        manifest_path = self.root / "stage4.manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.manifest_hash = verifier.sha(manifest_path)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_exact_four_component_fixture_is_accepted(self) -> None:
        result = verifier.verify(self.root, self.manifest_hash, COMMIT, PUBLISHER)
        self.assertEqual(len(result["files"]), 4)

    def test_component_substitution_during_pe_inspection_is_detected(self) -> None:
        real_pe_info = verifier.pe_info
        mutated = False

        def mutate_after_inspection(path: Path) -> dict[str, object]:
            nonlocal mutated
            result = real_pe_info(path)
            if not mutated and Path(path).name == verifier.NAMES[0]:
                Path(path).write_bytes(b"replacement after initial hash")
                mutated = True
            return result

        with mock.patch.object(verifier, "pe_info", side_effect=mutate_after_inspection):
            with self.assertRaisesRegex(
                ValueError, "stage4_component_changed_during_verification:gpubnb-agent.exe"
            ):
                verifier.verify(self.root, self.manifest_hash, COMMIT, PUBLISHER)
        self.assertTrue(mutated)


if __name__ == "__main__":
    unittest.main()
