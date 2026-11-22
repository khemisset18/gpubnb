"""Freeze check for the *laboratory reference* D2, NOT production D2 or hardware D8.

Compares the manifest to hard-coded expected invariants AND the actual D2
implementation constants. Never opens devices, generates keys, signs or RPCs.
"""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
D2 = HERE.parent / "d2"
WALLET = HERE.parents[2] / "wallet-agent" / "dogecoin"
sys.path.insert(0, str(D2))
sys.path.insert(0, str(WALLET))

import offline_candidate
import spend_preparation
import refund_ladder
import external_signer
import script_diagnostics
import native_spends


def verify():
    profile = json.loads((HERE / "frozen_experimental_d2_profile_v1.json").read_text())
    assert type(profile) is dict
    expected = {
        "schemaVersion": 1,
        "status": "FROZEN_EXPERIMENTAL_D2_REFERENCE_NOT_HARDWARE_QUALIFIED",
        "qualified": False,
        "canSignRealDoge": False,
        "mainnetSettlementAuthorized": False,
        "network": "doge-regtest",
        "genesis": "3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5",
        "dogecoinCoreVersion": "1.14.9",
        "dogecoinSourceCommit": "e0a1c157791544e818c901bd9341896965afbf9d",
        "d0EvidenceCommit": "99724d5b66b9475dcb96f6c471c75ce01ed60f9a",
        "d0ConsensusLibrarySha256": "3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b",
        "d0LibraryAbi": 1, "nativeScriptFlags": 517,
        "script": "D2_V1_LEGACY_P2SH_SHA256_HTLC_IF_CLAIM_ELSE_CLTV_REFUND",
        "refundScriptBranch": "OP_FALSE", "nLockTimeType": "block-height",
        "speculosRefundLockHeight": 1351, "nSequence": 4294967294,
        "sighashType": 1, "allowedRefundSigHash": "SIGHASH_ALL",
        "externalSoftwareSignerProfile":
            "DOGE_REGTEST_LEGACY_P2SH_CLTV_SIGHASH_ALL_EXTERNAL_SOFTWARE_V1",
        "signerKind": "external-software-fixture-only",
        "ledgerEmulatedApplicationSource": "LedgerHQ/app-bitcoin-legacy",
        "ledgerEmulatedApplicationCommit": "79f3036daec38347747fb498470bed3cfb103440",
        "ledgerFirmwareNetworkIdentity": "dogecoin-mainnet",
        "ledgerFirmwareHardwareQualified": False, "emulatorDeviceNotPhysical": True,
        "consensusRunScope": "SIGNED_SYNTHETIC_REFUND_P2SH_DERSIG_CLTV_SCRIPT_INPUT_ONLY",
        "chainFinalityVerified": False, "utxoFundingExists": False,
        "mempoolStandardnessVerified": False,
        "physicalSignerDisplayOfContractVerified": False,
        "independentAuditD9Complete": False, "realDogeUsed": 0,
        "broadcasts": 0, "ownerRealWalletKeysUsed": False,
    }
    assert profile == expected, "experimental D2 profile manifest differs from explicit pinned reference"
    assert spend_preparation.GENESIS == profile["genesis"]
    assert offline_candidate.SOURCE == profile["dogecoinSourceCommit"]
    assert offline_candidate.SEQUENCE == profile["nSequence"]
    assert refund_ladder.SEQUENCE == profile["nSequence"]
    assert external_signer.PROFILE == profile["externalSoftwareSignerProfile"]
    assert script_diagnostics.LIBRARY_SHA256 == profile["d0ConsensusLibrarySha256"]
    assert script_diagnostics.SOURCE_COMMIT == profile["dogecoinSourceCommit"]
    assert native_spends.FLAGS == profile["nativeScriptFlags"]
    # The Ledger app is MAINNET configured and NOT a Regtest hardware signer.
    assert profile["ledgerFirmwareNetworkIdentity"] != profile["network"]
    assert not profile["physicalSignerDisplayOfContractVerified"]
    assert not profile["mainnetSettlementAuthorized"]
    return True


class FrozenExperimentalD2Tests(unittest.TestCase):
    def test_exact_d2_experimental_reference_matches_source_without_promoting_signer(self):
        self.assertTrue(verify())


if __name__ == "__main__":
    unittest.main()
