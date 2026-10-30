"""Compile a bounded future experiment proposal; this module has no executor.

No RPC implementation, subprocess, dynamic library, key or signing operation.
Missing native code/public signed fixtures are explicit, not guessed approvals.
"""
import hashlib
from pathlib import Path

from offline_candidate import SOURCE
from spend_preparation import GENESIS, prepare_spend_pair, stable_hash

CASES = (
    "valid_claim", "valid_refund_after_lock", "early_refund", "equal_candidate_height_nonfinal",
    "wrong_signature", "wrong_claim_key", "wrong_refund_key", "wrong_secret", "short_secret",
    "wrong_outpoint", "wrong_input_value", "wrong_redeem", "wrong_destination", "final_sequence",
    "lock_domain_mismatch", "changed_signed_lock", "double_spend", "absent_utxo", "immature_coinbase",
    "hard_dust", "soft_dust_reserve", "dynamic_mempool_fee_floor", "excessive_fee", "script_flag_override",
)


def compile_qualification_request(terms):
    pair = prepare_spend_pair(terms)
    here = Path(__file__).resolve().parent
    paths = ["htlc_codec.py", "spend_preparation.py", "qualification_request.py",
             "fixtures/htlc_codec_v1.json", "fixtures/spend_terms_v1.json", "fixtures/source_policy_map_v1.json"]
    inputs = [{"path":str(p),"sha256":hashlib.sha256((here/p).read_bytes()).hexdigest()} for p in paths]
    return {
        "schemaVersion":1, "kind":"OFFLINE_EXPERIMENT_REQUEST_ONLY", "sourceCommit":SOURCE,
        "network":"regtest", "genesis":GENESIS, "termsDigest":stable_hash(terms),
        "requiredOriginalArchiveSha256":"4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8",
        "requiredArchiveMembers":["dogecoin-1.14.9/bin/dogecoind","dogecoin-1.14.9/bin/dogecoin-cli",
                                  "dogecoin-1.14.9/lib/libdogecoinconsensus.so.0.0.0"],
        "requiredConsensusLibrarySha256":"3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b",
        "inputFiles":inputs, "intentDigests":{branch:stable_hash(value) for branch,value in pair.items()},
        "scenarios":list(CASES), "nativeExecutorImplemented":False, "publicSignedFixtureSetDigest":None,
        "readyForAuthorization":False, "approved":False,
        "blockingInputs":["native executor and exact executable commit not yet implemented/frozen",
                          "separately reviewed test-only public keys and signed fixture recipes required",
                          "funding prevouts, signed transaction bytes and exact effect transcript must be frozen",
                          "native policy and RPC-vs-P2P method of measurement must be independently reviewed"],
        "proposedResourceBounds":{"nodes":1,"maxSyntheticBlocks":1500,"maxGenerateCalls":4,
            "maxHtlcUtxos":4,"maxHtlcUtxoKoinu":"500000000","maxSubmissions":24,"maxReadRpcCalls":96,
            "maxCpuSeconds":600,"maxWallSeconds":900,"maxAddressSpaceMiB":2048,"maxDataMiB":512},
        "proposedConfiguration":{"acceptNonstandard":False,"promiscuousMempoolFlags":None,
            "privateFreshDatadir":True,"interfaces":["lo"],"p2pPeers":0,"walletDisabled":True,
            "publicNetwork":False,"gpuBnbCoreAccess":False,"testSignerOutsideCore":True},
        "unapprovedFutureRpcMethods":["getblockchaininfo","getblockhash","getnetworkinfo","getpeerinfo",
            "getrawmempool","getmempoolinfo","gettxout","getrawtransaction","decodescript",
            "generatetoaddress","sendrawtransaction","stop"],
        "nativeProofRequirements":["unchanged signed D0 archive/SPDX/identity revalidation",
            "positive signature-bound claim and refund under exact library flags",
            "complete IsStandardTx/AreInputsStandard and effective standard script flags",
            "mempool membership and UTXO reconciliation even after an RPC error",
            "RPC acceptance distinguished from P2P free-limiter/relay policy",
            "all predeclared negative cases reject at the independently expected layer"],
        "cleanupRequirements":["clean node stop and zero external peers/connections",
            "private test-key material never uploaded; destroy only named disposable resources after proof capture",
            "preserve public transcript, input/output hashes, namespace inventory and failure logs"],
        "excluded":["user wallets","real funds","public-network submission","Core connectivity",
                    "Mainnet","D0/D1 trust changes","D3-D9 execution","deployment","exchange activation"],
        "qualificationStatus":"BLOCKED", "executableOperations":[], "transactionBytes":None,
    }
