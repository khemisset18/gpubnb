#!/usr/bin/env python3
"""Read-only verification of the one new private funding guard case.

Usage: python3 verify_native_44652078768.py ARTIFACT_DIRECTORY REPOSITORY OUTPUT
The directory contains artifact.zip and its safely bounded extraction. This
checks retained native/attestation evidence and reproduces the public zipapp.
It does not start a daemon, sign, submit, mine, or repeat a native test.
"""
import argparse
import base64
from collections import Counter
import datetime
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import zipfile

CANDIDATE = "ac28d513abd8084842c14de7cdc92765164bbc8a"
HARNESS = "555419d73ff0430f862a7836ef11e129e273b980"
EXECUTION = "3aea3b7f5cfb499ae9754f04e24223ce11d3ae02"
ZIP_SHA = "2bf772edc65124f50c09724b64ba27bc23448e2903ee592f293027c446b1e413"
PACKAGE = "690a26f739217fb19701b5dc5ee3c6abac747b28e3ebaf7014c29897806c3f73"
ARCHIVE = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
REFUSAL = "funding is not confirmed on active chain; no broadcast"
PREFIXES = ["asset-exchange/qualification/dogecoin/", "asset-exchange/chain-watchers/",
            "asset-exchange/recovery/", "asset-exchange/wallet-agent/",
            "asset-exchange/core/src/errors.mjs", ".github/workflows/asset-exchange-dogecoin-multinode.yml"]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_directory", type=Path)
    parser.add_argument("repository", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    folder, repository = args.artifact_directory.resolve(), args.repository.resolve()

    def read(path):
        target = folder / path
        assert stat.S_ISREG(target.lstat().st_mode) and not target.is_symlink()
        assert target.stat().st_size <= 4 * 1024 * 1024
        return target.read_bytes()

    def load(path):
        return json.loads(read(path))

    def git(*argv):
        return subprocess.check_output(["git", *argv], cwd=repository)

    def source(ref, path):
        return git("show", ref + ":" + path)

    raw_zip = read("artifact.zip")
    assert len(raw_zip) == 187701 and sha(raw_zip) == ZIP_SHA
    with zipfile.ZipFile(folder / "artifact.zip") as archive:
        entries = archive.infolist()
        assert len(entries) == 14 and sum(x.file_size for x in entries) == 761349
        assert len({e.filename for e in entries}) == len(entries)
        assert archive.testzip() is None
        for entry in entries:
            path = PurePosixPath(entry.filename)
            assert not path.is_absolute() and ".." not in path.parts and "\\" not in entry.filename
            assert not stat.S_ISLNK(entry.external_attr >> 16)
            assert read(entry.filename) == archive.read(entry)
    sums = {}
    for line in read("lab/evidence/SHA256SUMS").decode().splitlines():
        expected, name = line.split("  ", 1)
        assert re.fullmatch("[0-9a-f]{64}", expected) and PurePosixPath(name).name == name
        actual = sha(read("lab/evidence/" + name))
        assert expected == actual
        sums[name] = actual
    assert len(sums) == 7
    identities = {}
    for name, run, commit in [
        ("d0-run.json", 40866305437, "99724d5b66b9475dcb96f6c471c75ce01ed60f9a"),
        ("d1-run.json", 40892872892, "1636df354d4fafd2cc2d9ab8595f4dca52582ad7"),
    ]:
        value = load("verification/" + name)
        assert value["id"] == run and value["head_sha"] == commit
        assert value["status"] == "completed" and value["conclusion"] == "success"
        assert value["repository"]["id"] == 1305325878
        identities[name] = {"run":run, "commit":commit, "sha256":sha(read("verification/" + name))}
    attestations = {}
    for name, predicate in [("provenance.json", "https://slsa.dev/provenance/v1"),
                            ("sbom.json", "https://spdx.dev/Document/v2.3")]:
        rows = load("verification/" + name)
        assert len(rows) == 1
        row = rows[0]
        envelope = row["attestation"]["bundle"]["dsseEnvelope"]
        statement = json.loads(base64.b64decode(envelope["payload"], validate=True))
        assert statement["predicateType"] == predicate
        assert statement["subject"] == [{"name":"dogecoin-1.14.9-x86_64-linux-gnu.tar.gz","digest":{"sha256":ARCHIVE}}]
        certificate = row["verificationResult"]["signature"]["certificate"]
        assert certificate["issuer"] == "https://token.actions.githubusercontent.com"
        assert certificate["githubWorkflowSHA"] == identities["d0-run.json"]["commit"]
        assert certificate["sourceRepositoryIdentifier"] == "1305325878"
        assert certificate["subjectAlternativeName"] == "https://github.com/khemisset18/gpubnb/.github/workflows/asset-exchange-dogecoin-d0-repro.yml@refs/heads/asset-exchange/doge-d0-cohort-validation-20261029"
        attestations[name] = {"sha256":sha(read("verification/" + name)), "predicateType":predicate,
                              "subjectArchiveSha256":ARCHIVE, "verifiedSignerCommit":certificate["githubWorkflowSHA"]}
    report = load("lab/evidence/multinode-report.json")
    manifest = load("verification/effective-manifest.json")
    assert manifest == report["manifest"]
    assert manifest["selectedNativeCases"] == ["unconfirmed-funding-refuses-rebroadcast"]
    assert manifest["network"] == "regtest" and manifest["nodes"] == 2
    assert not manifest["externalNetwork"] and not manifest["walletEnabled"] and not manifest["signingAllowed"]
    assert manifest["maxRpc"] == 400 and manifest["maxGeneratedBlocks"] == 2 and manifest["maxStandaloneInvocations"] == 8
    assert report["experimentStatus"] == "PASS" and report["qualificationStatus"] == "BLOCKED"
    assert not report["mainnetUsed"] and not report["realFundsUsed"] and not report["settlementAllowed"]
    assert report["generatedBlocks"] == 0 and report["publicReplay"]["blocks"] == 1355
    assert not report["publicReplay"]["nodeDatabasesTransferred"] and report["stages"] == []
    funding = report["fundingUnconfirmed"]
    assert funding["keysCreated"] == funding["transactionsSigned"] == funding["generatedBlocks"] == funding["refusalBroadcasts"] == 0
    assert funding["activeBlocks"] == funding["activeHeaders"] == 1355
    assert funding["fundingConfirmations"] == funding["refundConfirmations"] == 0
    assert funding["newFundingGuardIsolatedNatively"] and not funding["oldFundingReorgCasesRepeated"]
    assert funding["standaloneRefusal"] == REFUSAL and funding["standaloneInvocations"] == 2
    assert len(funding["cases"]) == 1
    case = funding["cases"][0]
    assert case["status"] == "PASS" and case["nodeSynchronized"] and case["fundingConfirmed"] is False
    assert case["nativeParentAndRefundPending"] and case["refusalBroadcasts"] == 0
    calls = report["independentRecoveryCalls"]
    assert len(calls) == 2 and [c["state"] for c in calls] == ["PENDING", "UNKNOWN"]
    assert calls[0]["fundingConfirmed"] is False and calls[1]["expectedRefusal"] == REFUSAL
    for call in calls:
        assert call["source"] == "a"
        assert not any(row["method"] == "sendrawtransaction" for row in call["rpcCalls"])
        proof = call["isolationProof"]
        assert all(proof[k] is True for k in ["backendUnavailable","isolatedPython","nodeADataUnavailable","originalSigningKeysUnavailable","separateMountNamespace"])
        assert proof["walletKeysProvided"] is False and proof["standalonePackageSha256"] == PACKAGE
    requests = load("lab/evidence/rpc-requests.json")
    stable_chain_reads = [json.loads(row["stdout"]) for row in requests
                          if row["source"] == "a" and row["method"] == "getblockchaininfo"
                          and row["exitCode"] == 0]
    stable_chain_reads = [row for row in stable_chain_reads if row["blocks"] == 1355]
    assert len(stable_chain_reads) >= 3
    assert all(row["chain"] == "regtest" and row["headers"] == 1355
               and row["bestblockhash"] == report["publicReplay"]["tip"] for row in stable_chain_reads)
    admitted = [x for x in requests if x["method"] == "sendrawtransaction"]
    assert len(admitted) == 2
    assert [x["stdout"].strip() for x in admitted] == [funding["fundingTxid"], funding["refundTxid"]]
    expected_sha = ["48fc043ae73d2088a46d386d25023c962b7fdb98d55a1030fc88c0ab1c8c61dc", funding["refundSha256"]]
    for row, expected in zip(admitted, expected_sha):
        assert row["source"] == "a" and row["exitCode"] == 0 and row["reachedServer"] is True
        assert sha(bytes.fromhex(row["params"][0])) == expected
    tx_reads = [json.loads(x["stdout"], parse_float=Decimal) for x in requests if x["method"] == "getrawtransaction"]
    assert {x["txid"] for x in tx_reads} == {funding["fundingTxid"], funding["refundTxid"]}
    native_transactions = {}
    for tx in tx_reads:
        index = 0 if tx["txid"] == funding["fundingTxid"] else 1
        assert tx.get("confirmations", 0) == 0 and not tx.get("blockhash")
        assert sha(bytes.fromhex(tx["hex"])) == expected_sha[index]
        assert len(tx["vout"]) == 1
        assert tx["vout"][0]["value"] * 100000000 == [99000000,98000000][index]
        native_transactions[tx["txid"]] = {"confirmations":0, "blockhash":None, "rawSha256":expected_sha[index],
                                          "outputKoinu":str(int(tx["vout"][0]["value"] * 100000000))}
    reached = Counter(x["source"] for x in requests if x["reachedServer"])
    standalone = Counter()
    for call in calls:
        standalone[call["source"]] += len(call["rpcCalls"])
    daemon = {node:len(re.findall(r"ThreadRPCServer method=",read("lab/evidence/daemon-"+node+".log").decode())) for node in ["a","b"]}
    assert daemon == {node:reached[node]+standalone[node] for node in daemon} == {"a":37,"b":12}
    client_count = len(requests) + sum(standalone.values())
    readiness = sum(not row["reachedServer"] for row in requests)
    assert len(requests) == 35 and sum(standalone.values()) == 18
    assert report["rpcCalls"] == client_count == 53 == sum(daemon.values()) + readiness
    assert sum(daemon.values()) == 49 and readiness == 4
    assert not any(x["method"] in ["generate","generatetoaddress","submitblock"] for x in requests)
    refusal = load("lab/evidence/cleanroom-refusal-18332-funding-unconfirmed-rebroadcast.json")
    assert refusal == {"automaticSettlement":False, "error":REFUSAL, "state":"UNKNOWN"}
    watcher = load("lab/evidence/watcher-review.json")
    assert watcher["scope"] == "unconfirmed-funding-guard-only"
    assert watcher["canAdvance"] is False and watcher["settlementAllowed"] is False
    assert watcher["newFundingGuardIsolatedNatively"] and not watcher["oldFundingReorgCasesRepeated"]
    assert git("rev-parse",HARNESS+"^{tree}").decode().strip() == "30f9e788a77232ee6d04650da28489f1688769f2"
    assert git("rev-parse",EXECUTION+"^{tree}").decode().strip() == "2ea138b33c80d7cbb7532c06a049b6d568ce44c0"
    changes = git("diff","--name-only",HARNESS,EXECUTION).decode().splitlines()
    assert changes == [".github/workflows/workspace-reliability.yml"]
    assert not git("diff","--name-only",HARNESS,EXECUTION,"--",*PREFIXES)
    assert ("harness_commit: "+HARNESS).encode() in source(EXECUTION,changes[0])
    package_path = repository / "asset-exchange/recovery/dogecoin/package.py"
    spec = importlib.util.spec_from_file_location("package_proof",package_path)
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    runtime = {}
    for value in package.FILES.values():
        path = "asset-exchange/" + value
        raw = source(CANDIDATE,path)
        assert raw == source(HARNESS,path) == source(EXECUTION,path) == (repository/path).read_bytes()
        runtime[path] = sha(raw)
    assert runtime["asset-exchange/recovery/dogecoin/recovery_core.py"] == "ab6221fb209ac05316a37d9b17beb26ad45317b125dd0c1866abf3d3240a1c8b"
    with tempfile.TemporaryDirectory(prefix="unconfirmed-package-proof-",dir=args.output.parent) as tmp:
        assert package.build_package(Path(tmp)/"first.pyz",repository/"asset-exchange") == PACKAGE
        assert package.build_package(Path(tmp)/"second.pyz",repository/"asset-exchange") == PACKAGE
    result = {
        "schemaVersion":1, "verifiedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "kind":"Internal verification of one new private native case, without repeating it",
        "result":"PASS_BOUNDED_NATIVE_UNCONFIRMED_FUNDING_REFUSAL",
        "run":44652078768, "job":136009177982, "artifact":14591413354,
        "runUrl":"https://github.com/khemisset18/gpubnb/actions/runs/44652078768",
        "artifactUrl":"https://github.com/khemisset18/gpubnb/actions/runs/44652078768/artifacts/14591413354",
        "artifactZipSha256":ZIP_SHA, "artifactBytes":len(raw_zip), "entriesVerified":14,
        "internalChecksums":sums, "candidateRuntimeCommit":CANDIDATE,
        "candidateRuntimeTree":git("rev-parse",CANDIDATE+"^{tree}").decode().strip(),
        "harnessCommit":HARNESS, "harnessTree":"30f9e788a77232ee6d04650da28489f1688769f2",
        "executionCommit":EXECUTION, "executionTree":"2ea138b33c80d7cbb7532c06a049b6d568ce44c0",
        "wholeHarnessExecutionTreeDelta":changes, "protectedSourcesIdenticalBetweenHarnessExecution":True,
        "identicalRuntimeSourcesInCandidateHarnessExecution":runtime, "packageReproducedTwiceSha256":PACKAGE,
        "d0d1RunIdentities":identities, "retainedVerifiedAttestations":attestations,
        "cryptographicAttestationReverificationLocally":False,
        "cryptographicAttestationVerification":"Successful native CI helper gh attestation verify preceded node start; retained statement, signer and subject identities rechecked locally.",
        "selectedCases":funding["cases"], "selectedPass":1, "selectedFail":0, "selectedSkip":0,
        "clientRpcCalls":53, "directClientRpcCalls":35, "standaloneRpcCalls":18,
        "daemonRpcCalls":49, "daemonRpcCallsByNode":daemon, "readinessAttemptsNotReachingServer":4,
        "resourceLimits":{"maxRpc":400,"maxGeneratedBlocks":2,"maxStandaloneInvocations":8},
        "generatedBlocks":0, "standaloneInvocations":2, "preexistingPublicTransactionAdmissions":2,
        "nativeTransactions":native_transactions, "publicBlocksReused":1355,
        "activeBlocks":1355, "activeHeaders":1355, "fundingConfirmations":0, "refundConfirmations":0,
        "nativeStableSynchronizedChainReads":len(stable_chain_reads),
        "standaloneRefusal":REFUSAL, "broadcastsByStandaloneRecovery":0, "broadcastDuringRefusal":0,
        "keysCreated":0, "signaturesCreated":0, "newFundingGuardIsolatedNatively":True,
        "oldFundingReorgCasesRepeated":False, "newNativeExecutionDuringVerification":False,
        "fundingObservationSource":"a", "pairedWatcherStages":0,
        "watcherLimitation":"This one-source funding guard case does not add paired watcher consensus or successful confirmed recovery. Those results retain their separate run identities.",
        "watchersAdvanceOrSettle":False, "mainnet":False, "realFunds":False,
        "independentVmJobs":"SKIPPED, not PASS", "completeD0D9Qualification":"BLOCKED",
        "externalIndependentAudit":"NOT_PERFORMED_OUTSIDE_MISSION",
        "nativeJobLogSha256":"65544e6e2efdd6ab2e245b76186e4dd21ef43f9d4a35185a383331debdf29fc8"
    }
    args.output.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(json.dumps({"output":str(args.output),"sha256":sha(args.output.read_bytes()),"clientRpcCalls":53,
                      "daemonRpcCalls":49,"selectedPass":1,"packageSha256":PACKAGE}))


if __name__ == "__main__":
    main()
