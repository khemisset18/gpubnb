#!/usr/bin/env python3
"""Verify retained native evidence, without starting a node or repeating tests.

Usage: python3 verify_native_44400212431.py ARTIFACT_DIRECTORY REPOSITORY OUTPUT
The directory contains the authenticated Actions ZIP plus its bounded extraction.
Cryptographic attestation verification is attributed to the successful CI helper;
this read-only verifier checks the retained verified identities and statements.
"""
import argparse
import base64
from collections import Counter
import datetime
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
HARNESS = "a3eef9d38e4418c80269dc521c35c895caee77e5"
EXECUTION = "4ce481379a9355d5aa49e92ebe93df032e0a6906"
ARCHIVE = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
ZIP_SHA = "7191906e1af4543fc0bd53885f1d2ab0e8534a02bad85f10b5b5da3359cecfe4"
PACKAGE = "690a26f739217fb19701b5dc5ee3c6abac747b28e3ebaf7014c29897806c3f73"
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
    def git(*argv):
        return subprocess.check_output(["git", *argv], cwd=repository)
    def source(ref, path):
        return git("show", ref + ":" + path)
    def read(path):
        target = folder / path
        mode = target.lstat().st_mode
        assert stat.S_ISREG(mode) and not target.is_symlink()
        assert target.stat().st_size <= 4 * 1024 * 1024
        return target.read_bytes()
    def load(path):
        return json.loads(read(path))
    raw_zip = read("artifact.zip")
    assert len(raw_zip) == 192195 and sha(raw_zip) == ZIP_SHA
    with zipfile.ZipFile(folder / "artifact.zip") as archive:
        entries = archive.infolist()
        assert len(entries) == 15 and sum(x.file_size for x in entries) == 861117
        assert archive.testzip() is None
        for entry in entries:
            path = PurePosixPath(entry.filename)
            assert not path.is_absolute() and ".." not in path.parts
            assert "\\" not in entry.filename and not stat.S_ISLNK(entry.external_attr >> 16)
            assert read(entry.filename) == archive.read(entry)
    files = {}
    for line in read("lab/evidence/SHA256SUMS").decode().splitlines():
        expected, name = line.split("  ", 1)
        assert re.fullmatch("[0-9a-f]{64}", expected) and PurePosixPath(name).name == name
        actual = sha(read("lab/evidence/" + name))
        assert expected == actual, name
        files[name] = actual
    assert len(files) == 8
    identities = {}
    for name, run, commit in [
        ("d0-run.json", 40866305437, "99724d5b66b9475dcb96f6c471c75ce01ed60f9a"),
        ("d1-run.json", 40892872892, "1636df354d4fafd2cc2d9ab8595f4dca52582ad7"),
    ]:
        value = load("verification/" + name)
        assert value["id"] == run and value["head_sha"] == commit
        assert value["status"] == "completed" and value["conclusion"] == "success"
        assert value["repository"]["id"] == 1305325878
        identities[name] = {"run": run, "commit": commit, "sha256": sha(read("verification/" + name))}
    attestations = {}
    for name, predicate in [("provenance.json", "https://slsa.dev/provenance/v1"),
                            ("sbom.json", "https://spdx.dev/Document/v2.3")]:
        values = load("verification/" + name)
        assert len(values) == 1
        value = values[0]
        statement = json.loads(base64.b64decode(value["attestation"]["bundle"]["dsseEnvelope"]["payload"], validate=True))
        assert statement["predicateType"] == predicate
        assert statement["subject"] == [{"name":"dogecoin-1.14.9-x86_64-linux-gnu.tar.gz","digest":{"sha256":ARCHIVE}}]
        certificate = value["verificationResult"]["signature"]["certificate"]
        assert certificate["issuer"] == "https://token.actions.githubusercontent.com"
        assert certificate["githubWorkflowSHA"] == identities["d0-run.json"]["commit"]
        assert certificate["sourceRepositoryIdentifier"] == "1305325878"
        assert certificate["subjectAlternativeName"] == "https://github.com/khemisset18/gpubnb/.github/workflows/asset-exchange-dogecoin-d0-repro.yml@refs/heads/asset-exchange/doge-d0-cohort-validation-20261029"
        attestations[name] = {"sha256":sha(read("verification/" + name)), "predicateType":predicate,
                              "subjectArchiveSha256":ARCHIVE, "verifiedSignerCommit":certificate["githubWorkflowSHA"]}
    report = load("lab/evidence/multinode-report.json")
    manifest = load("verification/effective-manifest.json")
    assert manifest == report["manifest"]
    assert manifest["network"] == "regtest" and manifest["nodes"] == 2
    assert not manifest["externalNetwork"] and not manifest["walletEnabled"] and not manifest["signingAllowed"]
    assert manifest["maxRpc"] == 400 and manifest["maxGeneratedBlocks"] == 2 and manifest["maxStandaloneInvocations"] == 8
    assert report["experimentStatus"] == "PASS" and report["qualificationStatus"] == "BLOCKED"
    assert not report["mainnetUsed"] and not report["realFundsUsed"] and not report["settlementAllowed"]
    assert report["generatedBlocks"] == 2 and report["publicReplay"]["blocks"] == 1355
    assert not report["publicReplay"]["nodeDatabasesTransferred"]
    funding = report["fundingReorg"]
    assert funding["keysCreated"] == funding["transactionsSigned"] == 0
    assert not funding["newFundingGuardIsolatedNatively"] and not funding["previousNativeSuitesRepeated"]
    assert len(funding["cases"]) == 2 and all(x["status"] == "PASS" for x in funding["cases"])
    assert funding["cases"][0]["preexistingHeaderGuardRefusedFirst"] and funding["cases"][0]["refusalBroadcasts"] == 0
    assert funding["cases"][0]["nativeActiveBlocks"] == 1355 and funding["cases"][0]["nativeHeaders"] == 1356
    assert funding["cases"][1]["bothNodesConfirmed"] and funding["cases"][1]["identicalPendingBytesRebroadcast"]
    assert funding["retainedKoinu"] == "98000000" and funding["feeKoinu"] == "1000000"
    calls = report["independentRecoveryCalls"]
    assert len(calls) == 6
    for call in calls:
        proof = call["isolationProof"]
        assert all(proof[k] is True for k in ["backendUnavailable","isolatedPython","nodeADataUnavailable","originalSigningKeysUnavailable","separateMountNamespace"])
        assert proof["walletKeysProvided"] is False and proof["standalonePackageSha256"] == PACKAGE
    refusals = [call for call in calls if call["expectedRefusal"]]
    assert len(refusals) == 1 and not any(x["method"] == "sendrawtransaction" for x in refusals[0]["rpcCalls"])
    for call in calls:
        for request in call["rpcCalls"]:
            if request["method"] == "sendrawtransaction":
                assert sha(bytes.fromhex(request["params"][0])) == funding["refundSha256"]
    requests = load("lab/evidence/rpc-requests.json")
    reached = Counter(x["source"] for x in requests if x["reachedServer"])
    standalone = Counter()
    for call in calls:
        standalone[call["source"]] += len(call["rpcCalls"])
    daemon = {name:len(re.findall(r"ThreadRPCServer method=", read("lab/evidence/daemon-"+name+".log").decode())) for name in ["a","b"]}
    assert daemon == {name:reached[name]+standalone[name] for name in daemon}
    client_count = len(requests) + sum(standalone.values())
    readiness = sum(not x["reachedServer"] for x in requests)
    assert report["rpcCalls"] == client_count == 175
    assert daemon == {"a":118,"b":53} and sum(daemon.values()) == 171 and readiness == 4
    assert client_count == sum(daemon.values()) + readiness <= manifest["maxRpc"]
    watcher = load("lab/evidence/watcher-review.json")
    assert watcher["settlementAllowed"] is False and watcher["qualificationStatus"] == "BLOCKED"
    for stage in watcher["stages"].values():
        assert stage["canAdvance"] is False and stage["settlementAllowed"] is False
    assert watcher["stages"]["funding-rolled-back"]["consistency"] == "UNCERTAIN"
    confirmed = next(x for x in report["stages"] if x["label"] == "refund-confirmed")
    assert len(confirmed["observations"]) == 2
    assert all(x["tipHeight"] == x["blockHeight"] == 1357 and x["confirmations"] == 1 for x in confirmed["observations"])
    assert len({x["blockHash"] for x in confirmed["observations"]}) == 1
    assert git("rev-parse", CANDIDATE+"^{tree}").decode().strip() == "ecba7bcbae006f2850b3cfeae636a1a92284a60c"
    all_changes = git("diff","--name-only",HARNESS,EXECUTION).decode().splitlines()
    assert all_changes == [".github/workflows/workspace-reliability.yml"]
    assert not git("diff","--name-only",HARNESS,EXECUTION,"--",*PREFIXES)
    assert ("harness_commit: "+HARNESS).encode() in source(EXECUTION,all_changes[0])
    package_file = repository / "asset-exchange/recovery/dogecoin/package.py"
    assert package_file.read_bytes() == source(CANDIDATE,str(package_file.relative_to(repository)))
    spec = importlib.util.spec_from_file_location("package_proof",package_file)
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    runtime = {}
    for path in package.FILES.values():
        full = "asset-exchange/" + path
        candidate_bytes = source(CANDIDATE,full)
        assert candidate_bytes == source(HARNESS,full) == source(EXECUTION,full) == (repository/full).read_bytes()
        runtime[full] = sha(candidate_bytes)
    with tempfile.TemporaryDirectory(prefix="native-package-proof-",dir=args.output.parent) as tmp:
        assert package.build_package(Path(tmp)/"first.pyz",repository/"asset-exchange") == PACKAGE
        assert package.build_package(Path(tmp)/"second.pyz",repository/"asset-exchange") == PACKAGE
    other_differences = git("diff","--name-status",HARNESS,CANDIDATE,"--",*PREFIXES).decode().splitlines()
    result = {
        "schemaVersion":1, "verifiedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "kind":"Internal read-only verification of already completed private native evidence",
        "result":"PASS_BOUNDED_NATIVE_RECOVERY_REGRESSION",
        "run":44400212431,"runUrl":"https://github.com/khemisset18/gpubnb/actions/runs/44400212431",
        "job":135140878860,"artifact":14472149211,
        "artifactUrl":"https://github.com/khemisset18/gpubnb/actions/runs/44400212431/artifacts/14472149211",
        "artifactZipSha256":ZIP_SHA,"artifactBytes":len(raw_zip),"archiveEntriesVerified":15,"internalChecksums":files,
        "candidateCommit":CANDIDATE,"candidateTree":"ecba7bcbae006f2850b3cfeae636a1a92284a60c",
        "harnessCommit":HARNESS,"harnessTree":git("rev-parse",HARNESS+"^{tree}").decode().strip(),
        "executionCommit":EXECUTION,"executionTree":git("rev-parse",EXECUTION+"^{tree}").decode().strip(),
        "harnessExecutionWholeTreeDelta":all_changes,"harnessExecutionProtectedSourcesIdentical":True,
        "allSevenRuntimeSourcesIdenticalInCandidateHarnessExecution":runtime,
        "wholeCandidateAndHarnessProtectedTreesIdentical":not bool(other_differences),
        "otherRetainedHistoricalRbfDiagnosticDifferences":other_differences,
        "standalonePackageReproducedTwiceSha256":PACKAGE,
        "d0d1RunIdentities":identities,"retainedVerifiedAttestations":attestations,
        "cryptographicAttestationReverificationLocally":False,
        "cryptographicAttestationVerification":"Performed by gh attestation verify in successful native CI execution helper before nodes started; retained outputs and signer statements rechecked here.",
        "selectedCases":funding["cases"],"selectedPass":2,"selectedFail":0,"selectedSkip":0,
        "clientRpcCalls":client_count,"directClientRpcCalls":len(requests),"standaloneRpcCalls":sum(standalone.values()),
        "daemonRpcCalls":sum(daemon.values()),"daemonRpcCallsByNode":daemon,"readinessAttemptsNotReachingServer":readiness,
        "maxRpc":400,"generatedBlocks":2,"maxGeneratedBlocks":2,"standaloneInvocations":6,"maxStandaloneInvocations":8,
        "publicBlocksReused":1355,"signaturesCreated":0,"keysCreated":0,"broadcastDuringRefusal":0,
        "retainedKoinu":funding["retainedKoinu"],"feeKoinu":funding["feeKoinu"],"refundTxid":funding["refundTxid"],
        "refundBytesSha256":funding["refundSha256"],"bothNodesConfirmedAtHeight":1357,
        "newFundingGuardIsolatedNatively":False,
        "newSnapshotMutationGuardsIsolatedNatively":False,
        "limitation":"Preexisting header-lead refusal still fires first. Funding/depth and RPC snapshot mutations are isolated in software tests. No finite sequence of RPC reads makes broadcast atomic; the native node revalidates. A separate unconfirmed-funding case is not proved by this historical run.",
        "watchersAdvanceOrSettle":False,"mainnet":False,"realFunds":False,"newNativeExecutionDuringVerification":False,
        "independentVmJobs":"SKIPPED, not PASS","auxpowRbfFeeNativeSuitesRepeated":False,
        "completeD0D9Qualification":"BLOCKED","externalIndependentAudit":"NOT_PERFORMED"
    }
    args.output.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(json.dumps({"output":str(args.output),"sha256":sha(args.output.read_bytes()),"clientRpcCalls":client_count,
                      "daemonRpcCalls":sum(daemon.values()),"cases":2,"packageSha256":PACKAGE}))

if __name__ == "__main__":
    main()
