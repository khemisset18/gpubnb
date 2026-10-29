"""Prepared D1 harness. Importing/testing this module never executes Dogecoin."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

AUTHORIZATION = "AUTHORIZE_D1_ISOLATED_REGTEST"
ARCHIVE = "dogecoin-1.14.9-x86_64-linux-gnu.tar.gz"
SHA256 = "4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8"
D0_COMMIT = "99724d5b66b9475dcb96f6c471c75ce01ed60f9a"
D0_RUN = "https://github.com/khemisset18/gpubnb/actions/runs/40866305437/attempts/1"
# Source-derived candidate: e0a1c157.../src/chainparams.cpp, CRegTestParams.
GENESIS = "3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def authorize(value):
    require(value == AUTHORIZATION, "distinct D1 binary-execution authorization required")


def _unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def read_json(path):
    path = Path(path)
    require(not path.is_symlink() and path.is_file(), "JSON must be a regular file")
    require(path.stat().st_size <= 2 * 1024 * 1024, "oversized JSON evidence")
    return json.loads(path.read_text(), object_pairs_hook=_unique)


def validate_namespace(parent, current, links):
    require(parent.startswith("net:[") and current.startswith("net:[") and parent != current,
            "a distinct Linux network namespace is required")
    require(type(links) is list and len(links) == 1 and links[0].get("ifname") == "lo",
            "only loopback may exist in the namespace")
    require("UP" in links[0].get("flags", []), "loopback must be up")


def validate_handoff(provenance, sbom_result, sbom):
    for result, predicate in ((provenance, "https://slsa.dev/provenance/v1"),
                              (sbom_result, "https://spdx.dev/Document/v2.3")):
        require(type(result) is list and len(result) == 1, "one verified attestation required")
        verified = result[0]["verificationResult"]
        cert = verified["signature"]["certificate"]
        expected = {
            "sourceRepositoryIdentifier": "1305325878",
            "sourceRepositoryOwnerIdentifier": "103233875",
            "sourceRepositoryDigest": D0_COMMIT,
            "buildSignerDigest": D0_COMMIT,
            "runInvocationURI": D0_RUN,
            "runnerEnvironment": "github-hosted",
        }
        for key, value in expected.items():
            require(cert.get(key) == value, f"unexpected D0 certificate {key}")
        statement = verified["statement"]
        require(statement.get("predicateType") == predicate, "wrong attestation predicate")
        subjects = statement.get("subject")
        require(type(subjects) is list and len(subjects) == 1 and
                subjects[0].get("digest", {}).get("sha256") == SHA256, "wrong signed artifact")
        require(bool(verified.get("verifiedTimestamps")), "missing witnessed attestation timestamp")
    require(sbom.get("spdxVersion") == "SPDX-2.3", "wrong SPDX version")
    require(sbom_result[0]["verificationResult"]["statement"]["predicate"] == sbom,
            "SBOM differs from signed predicate")


def validate_network(observed):
    chain, network = observed["blockchain"], observed["network"]
    require(chain.get("chain") == "regtest", "wrong network")
    for field in ("blocks", "headers"):
        require(type(chain.get(field)) is int and chain[field] == 0, "fresh genesis-only chain required")
    require(observed.get("genesis") == GENESIS and chain.get("bestblockhash") == GENESIS,
            "wrong Dogecoin regtest genesis")
    require(type(network.get("version")) is int and network["version"] == 1140900,
            "wrong Dogecoin version")
    require(network.get("subversion") == "/Shibetoshi:1.14.9/", "wrong release description")
    require(type(network.get("connections")) is int and network["connections"] == 0,
            "unexpected network connection")
    require(type(observed.get("peers")) is list and observed["peers"] == [], "unexpected peers")


def decode_cli_observations(blockchain, genesis, network, peers):
    # The pinned src/bitcoin-cli.cpp prints string RPC results without JSON
    # quotes. Object/array RPC results remain JSON. Never execute a node to
    # discover this formatting contract during offline preparation.
    observed = {"blockchain": json.loads(blockchain), "genesis": genesis.strip(),
                "network": json.loads(network), "peers": json.loads(peers)}
    validate_network(observed)
    return observed


def rpc_arguments(binary, common, method, *params):
    allowed = {"getblockchaininfo": (), "getblockhash": ("0",), "getnetworkinfo": (),
               "getpeerinfo": (), "stop": ()}
    require(method in allowed and params == allowed[method], "RPC outside D1 fixed allowlist")
    return [str(binary), *common, "-rpcconnect=127.0.0.1", method, *params]


def run(args):
    authorize(args.authorization)
    parent, current = args.parent_net_ns, os.readlink("/proc/self/ns/net")
    links = json.loads(subprocess.check_output(["ip", "-json", "link", "show"], text=True))
    validate_namespace(parent, current, links)
    evidence = Path(args.evidence).resolve()
    verification = Path(args.verification).resolve()
    validate_handoff(read_json(verification / "provenance.json"), read_json(verification / "sbom.json"),
                     read_json(evidence / "dogecoin-1.14.9-internal-reproduction.spdx.json"))
    archive = evidence / ARCHIVE
    require(not archive.is_symlink() and archive.is_file(), "regular D0 archive required")
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == SHA256, "D0 archive hash mismatch")
    work = Path(args.work).resolve()
    require(not work.exists(), "refusing to reuse a data directory")
    work.mkdir(mode=0o700)
    bins, data, out = work / "bin", work / "data", work / "evidence"
    for path in (bins, data, out):
        path.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as source:
        for name in ("dogecoind", "dogecoin-cli"):
            member = source.getmember("dogecoin-1.14.9/bin/" + name)
            require(member.isfile(), "regular executable member required")
            target = bins / name
            target.write_bytes(source.extractfile(member).read())
            target.chmod(0o700)
    config = data / "dogecoin.conf"
    config.write_text("regtest=1\ntestnet=0\n")
    config.chmod(0o600)
    common = [f"-datadir={data}", f"-conf={config}", "-regtest=1", "-testnet=0", "-rpcport=18332"]
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}

    def rpc(method, *params):
        result = subprocess.run(rpc_arguments(bins / "dogecoin-cli", common, method, *params),
                                env=env, capture_output=True, text=True,
                                check=True, timeout=10)
        return result.stdout

    with (out / "daemon-console.log").open("w") as log:
        process = subprocess.Popen([str(bins / "dogecoind"), *common, "-server=1", "-daemon=0",
                                    "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0",
                                    "-upnp=0", "-listenonion=0", "-disablewallet=1",
                                    "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1", "-printtoconsole=1"],
                                   env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 45
            while True:
                require(process.poll() is None, "isolated node exited before RPC readiness")
                try:
                    blockchain = rpc("getblockchaininfo")
                    break
                except subprocess.CalledProcessError:
                    require(time.monotonic() < deadline, "isolated RPC readiness timeout")
                    time.sleep(0.25)
            observed = decode_cli_observations(blockchain, rpc("getblockhash", "0"),
                                               rpc("getnetworkinfo"), rpc("getpeerinfo"))
        finally:
            if process.poll() is None:
                try:
                    rpc("stop")
                    process.wait(timeout=10)
                except (subprocess.SubprocessError, OSError):
                    process.kill()
                    process.wait(timeout=10)
                    raise RuntimeError("isolated node did not stop cleanly")
    require(process.returncode == 0, "isolated node shutdown failed")
    report = {"status": "D1_NETWORK_IDENTITY_PASS", "d0ArchiveSha256": SHA256,
              "d0HarnessCommit": D0_COMMIT, "d0Run": D0_RUN, "observations": observed,
              "networkNamespace": current, "namespaceInterfaces": links,
              "walletDisabled": True, "p2pDisabled": True, "automaticSettlementSupported": False,
              "mainnetUsed": False, "realFundsUsed": False, "broadcastPerformed": False,
              "scope": "network identity only; D2-D9 remain unqualified"}
    (out / "network-identity.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for option in ("evidence", "verification", "work", "authorization", "parent-net-ns"):
        parser.add_argument("--" + option, required=True)
    run(parser.parse_args())
