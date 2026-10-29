"""D2 diagnostics for the exact D0 archive; importing this module executes nothing.

The C ABI verifies synthetic serialized inputs and an existing public signature
fixture. It does not submit transactions or implement full transaction policy.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import struct
import subprocess
import sys
import tarfile
import time

D2_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(D2_DIR.parent / "d1"))
from network_identity import (ARCHIVE, D0_COMMIT, GENESIS, SHA256, read_json,
                              require, validate_handoff, validate_namespace,
                              validate_network)

AUTHORIZATION = "AUTHORIZE_D2_SCRIPT_DIAGNOSTICS"
LIBRARY_MEMBER = "dogecoin-1.14.9/lib/libdogecoinconsensus.so.0.0.0"
LIBRARY_SHA256 = "3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b"
SOURCE_COMMIT = "e0a1c157791544e818c901bd9341896965afbf9d"
CLTV_HEIGHT = 1351
GENERATE_SCHEDULE = (1350, 1, 1)
MAX_GENERATED_BLOCKS = 1352
MAX_TRIES_PER_CALL = 1000000
ALLOWED_METHODS = frozenset({"getblockchaininfo", "getblockhash", "getnetworkinfo",
                             "getpeerinfo", "decodescript", "generatetoaddress", "stop"})
P2SH, DERSIG, CLTV = 1, 4, 512
PREIMAGE = b"GPUbnb D2 public synthetic input"  # exactly 32 public bytes
PUBKEY = bytes.fromhex("038479a0fa998cd35259a2ef0a7a5c68662c1474f88ccb6d08a7677bbec7f22041")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def push(data):
    require(type(data) is bytes and len(data) <= 75, "fixture push must be direct and <=75 bytes")
    return bytes([len(data)]) + data


def hash160(data):
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def script_hash_output(redeem):
    return b"\xa9\x14" + hash160(redeem) + b"\x87"


def base58check(payload):
    raw = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    value, encoded = int.from_bytes(raw, "big"), ""
    while value:
        value, digit = divmod(value, 58)
        encoded = alphabet[digit] + encoded
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + encoded


# Coinbase-only synthetic destination: regtest P2SH(OP_RETURN), no wallet/key.
BURN_REDEEM = b"\x6a"
BURN_ADDRESS = base58check(b"\xc4" + hash160(BURN_REDEEM))
LOCK_SCRIPT = b"\x02\x47\x05\xb1\x75\x51"  # 1351 CLTV DROP TRUE
HASH_SCRIPT = b"\xa8" + push(hashlib.sha256(PREIMAGE).digest()) + b"\x87"
HTLC_REDEEM = (b"\x63\x82\x01\x20\x88\xa8" + push(hashlib.sha256(PREIMAGE).digest()) +
               b"\x88" + push(PUBKEY) + b"\xac\x67\x02\x47\x05\xb1\x75" + push(PUBKEY) + b"\xac\x68")
DECODE_FIXTURES = (
    {"name": "legacy_p2pk", "hex": (push(PUBKEY) + b"\xac").hex(), "expectedType": "pubkey"},
    {"name": "legacy_p2pkh", "hex": (b"\x76\xa9\x14" + hash160(PUBKEY) + b"\x88\xac").hex(), "expectedType": "pubkeyhash"},
    {"name": "candidate_p2sh_output", "hex": script_hash_output(HTLC_REDEEM).hex(), "expectedType": "scripthash"},
    {"name": "candidate_htlc_redeem", "hex": HTLC_REDEEM.hex(), "expectedType": "nonstandard"},
    {"name": "bare_cltv_control", "hex": LOCK_SCRIPT.hex(), "expectedType": "nonstandard"},
)


def synthetic_tx(script_sig=b"", locktime=0, sequence=0xFFFFFFFE):
    require(type(locktime) is int and 0 <= locktime <= 0xFFFFFFFF, "invalid fixture locktime")
    require(type(sequence) is int and 0 <= sequence <= 0xFFFFFFFF, "invalid fixture sequence")
    require(len(script_sig) < 253, "fixture scriptSig too large")
    return (struct.pack("<I", 1) + b"\x01" + b"\x01" * 32 + struct.pack("<I", 0) +
            bytes([len(script_sig)]) + script_sig + struct.pack("<I", sequence) + b"\x01" +
            struct.pack("<Q", 0) + b"\x01\x6a" + struct.pack("<I", locktime))


def consensus_vectors():
    vectors = []
    def add(name, script, sig=b"", lock=0, seq=0xFFFFFFFE, flags=0, expected=1, error=0, tx=None, index=0):
        vectors.append({"name": name, "scriptPubKeyHex": script.hex(),
                        "transactionHex": (synthetic_tx(sig, lock, seq) if tx is None else tx).hex(),
                        "inputIndex": index, "flags": flags, "expectedResult": expected, "expectedError": error})
    add("true_control", b"\x51")
    add("false_control", b"\x00", expected=0)
    add("p2sh_true_redeem", script_hash_output(b"\x51"), push(b"\x51"), flags=P2SH)
    add("p2sh_false_without_flag_control", script_hash_output(b"\x00"), push(b"\x00"))
    add("p2sh_false_with_flag_rejected", script_hash_output(b"\x00"), push(b"\x00"), flags=P2SH, expected=0)
    add("p2sh_hash_mismatch", script_hash_output(b"\x51"), push(b"\x00"), flags=P2SH, expected=0)
    add("cltv_inactive_control", LOCK_SCRIPT, lock=1350)
    add("cltv_before_lock_rejected", LOCK_SCRIPT, lock=1350, flags=CLTV, expected=0)
    add("cltv_equal_lock_accepts_script", LOCK_SCRIPT, lock=1351, flags=CLTV)
    add("cltv_after_lock_accepts_script", LOCK_SCRIPT, lock=1352, flags=CLTV)
    add("cltv_final_sequence_rejected", LOCK_SCRIPT, lock=1351, seq=0xFFFFFFFF, flags=CLTV, expected=0)
    add("cltv_height_time_type_rejected", LOCK_SCRIPT, lock=500000000, flags=CLTV, expected=0)
    add("cltv_negative_operand_rejected", b"\x4f\xb1\x75\x51", lock=1351, flags=CLTV, expected=0)
    add("p2sh_cltv_equal", script_hash_output(LOCK_SCRIPT), push(LOCK_SCRIPT), lock=1351, flags=P2SH | CLTV)
    add("p2sh_cltv_early_rejected", script_hash_output(LOCK_SCRIPT), push(LOCK_SCRIPT), lock=1350, flags=P2SH | CLTV, expected=0)
    add("hashlock_public_preimage", HASH_SCRIPT, push(PREIMAGE))
    add("hashlock_wrong_preimage_rejected", HASH_SCRIPT, push(b"x" * 32), expected=0)
    add("htlc_no_signature_claim_rejected", HTLC_REDEEM, push(PREIMAGE) + b"\x51", flags=P2SH | DERSIG | CLTV, expected=0)
    add("htlc_no_signature_refund_rejected", HTLC_REDEEM, b"\x00", lock=1351, flags=P2SH | DERSIG | CLTV, expected=0)
    add("malformed_transaction_rejected", b"\x51", tx=b"\x00", expected=0, error=3)
    add("wrong_input_index_rejected", b"\x51", index=1, expected=0, error=1)
    source = read_json(D2_DIR / "source-fixtures.json")
    require(source["sourceCommit"] == SOURCE_COMMIT and source["license"] == "MIT", "wrong public vector source")
    fixture = source["publicSignatureFixture"]
    public_tx = bytes.fromhex(fixture["serializedTransaction"])
    pub_script = bytes.fromhex(fixture["scriptPubKeyHex"])
    add("upstream_public_signature_verify_only", pub_script, tx=public_tx, flags=fixture["flags"])
    tampered = bytearray(public_tx); tampered[50] ^= 1
    add("upstream_signature_mutation_rejected", pub_script, tx=bytes(tampered), flags=fixture["flags"], expected=0)
    return vectors


def rpc_arguments(binary, common, method, *params):
    require(method in ALLOWED_METHODS, "RPC outside D2 exact allowlist")
    if method == "getblockhash":
        valid = params == ("0",)
    elif method == "decodescript":
        valid = len(params) == 1 and params[0] in {f["hex"] for f in DECODE_FIXTURES}
    elif method == "generatetoaddress":
        valid = (len(params) == 4 and params[0] in {"1350", "1"} and params[1] == BURN_ADDRESS and
                 params[2:] == (str(MAX_TRIES_PER_CALL), "0"))
    else:
        valid = not params
    require(valid, "RPC parameters outside D2 reviewed fixtures")
    return [str(binary), *common, "-rpcconnect=127.0.0.1", method, *params]


def validate_server_methods(console):
    methods = re.findall(r"ThreadRPCServer method=([a-zA-Z0-9_]+)", console)
    require(bool(methods) and set(methods) == ALLOWED_METHODS and methods[-1] == "stop", "wrong server RPC method set/order")
    require(methods.count("generatetoaddress") == len(GENERATE_SCHEDULE), "unexpected mining call count")
    require(methods.count("decodescript") == len(DECODE_FIXTURES), "unexpected script diagnostic call count")
    return methods


def validate_height(observation, height, active):
    require(type(height) is int and height in {0, 1350, 1351, 1352}, "unreviewed height")
    require(observation.get("chain") == "regtest" and observation.get("blocks") == height and
            type(observation.get("blocks")) is int and observation.get("headers") == height and
            type(observation.get("headers")) is int, "unexpected diagnostic chain height")
    entries = [s for s in observation.get("softforks", []) if s.get("id") == "bip65"]
    require(len(entries) == 1 and entries[0].get("reject", {}).get("status") is active,
            "CLTV activation identity differs from source expectation")


def manifest():
    return {"schemaVersion": 1, "phase": "D2_SCRIPT_DIAGNOSTICS", "authorization": AUTHORIZATION,
            "d0ArchiveSha256": SHA256, "sourceCommit": SOURCE_COMMIT,
            "libraryMember": LIBRARY_MEMBER, "librarySha256": LIBRARY_SHA256,
            "cAbi": {"version": 1, "functions": ["bitcoinconsensus_version", "bitcoinconsensus_verify_script"],
                     "allowedFlags": [0, P2SH, CLTV, P2SH | CLTV, P2SH | DERSIG | CLTV]},
            "rpcAllowlist": sorted(ALLOWED_METHODS), "miningSchedule": list(GENERATE_SCHEDULE),
            "maxSyntheticBlocks": MAX_GENERATED_BLOCKS, "maxTriesPerCall": MAX_TRIES_PER_CALL,
            "syntheticCoinbaseDestination": BURN_ADDRESS, "coinbaseRedeemHex": BURN_REDEEM.hex(),
            "decodeFixtures": list(DECODE_FIXTURES), "consensusVectors": consensus_vectors(),
            "resources": {"maxWallSeconds": 600, "maxCpuSeconds": 420, "maxAddressSpaceMiB": 2048,
                          "maxSingleFileMiB": 512, "maxDataMiB": 512, "nodes": 1},
            "wallet": False, "signing": False, "transactionBroadcast": False, "externalNetwork": False,
            "qualificationStatus": "BLOCKED", "blockingCriteria": ["full transaction standardness not measured",
                "positive signature-bound HTLC claim/refund construction not demonstrated"],
            "note": "Script C-ABI flags are explicit test inputs, not proof of network consensus activation; node observes activation separately."}


def validate_spdx_member(sbom, member, expected):
    files = [f for f in sbom.get("files", []) if f.get("fileName", "").removeprefix("./") == member]
    require(len(files) == 1, "one signed SPDX file member required")
    hashes = [c["checksumValue"] for c in files[0].get("checksums", []) if c.get("algorithm") == "SHA256"]
    require(hashes == [expected], "signed SPDX member hash mismatch")


def extract_verified_members(archive, sbom, bins):
    require(not archive.is_symlink() and archive.is_file(), "regular D0 archive required")
    require(sha256(archive.read_bytes()) == SHA256, "D0 archive hash mismatch")
    outputs = {}
    with tarfile.open(archive, "r:gz") as source:
        for member_name, target_name in (("dogecoin-1.14.9/bin/dogecoind", "dogecoind"),
                ("dogecoin-1.14.9/bin/dogecoin-cli", "dogecoin-cli"), (LIBRARY_MEMBER, "libdogecoinconsensus.so.0.0.0")):
            matches = [m for m in source.getmembers() if m.name.removeprefix("./") == member_name]
            require(len(matches) == 1 and matches[0].isfile(), "one regular archive member required")
            require(matches[0].size < 128 * 1024 * 1024, "oversized executable member")
            content = source.extractfile(matches[0]).read()
            digest = sha256(content)
            if member_name == LIBRARY_MEMBER:
                require(digest == LIBRARY_SHA256, "qualified consensus library hash mismatch")
            validate_spdx_member(sbom, member_name, digest)
            target = bins / target_name; target.write_bytes(content); target.chmod(0o700)
            outputs[target_name] = {"member": member_name, "sha256": digest}
    return outputs


def execute_consensus_vectors(library_path):
    require(sha256(library_path.read_bytes()) == LIBRARY_SHA256, "consensus library changed before load")
    library = ctypes.CDLL(str(library_path), mode=ctypes.RTLD_LOCAL)
    library.bitcoinconsensus_version.argtypes = []
    library.bitcoinconsensus_version.restype = ctypes.c_uint
    require(library.bitcoinconsensus_version() == 1, "wrong consensus C ABI version")
    verify = library.bitcoinconsensus_verify_script
    verify.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint,
                       ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_int)]
    verify.restype = ctypes.c_int
    observations = []
    for vector in consensus_vectors():
        script, tx = bytes.fromhex(vector["scriptPubKeyHex"]), bytes.fromhex(vector["transactionHex"])
        error = ctypes.c_int(-1)
        result = verify(script, len(script), tx, len(tx), vector["inputIndex"], vector["flags"], ctypes.byref(error))
        observation = {"name": vector["name"], "result": result, "error": error.value,
                       "expectedResult": vector["expectedResult"], "expectedError": vector["expectedError"]}
        observations.append(observation)
        require(result == vector["expectedResult"] and error.value == vector["expectedError"],
                "consensus vector mismatch: " + vector["name"])
    return observations


def run(args):
    require(args.authorization == AUTHORIZATION, "distinct D2 script-diagnostic authorization required")
    parent, current = args.parent_net_ns, os.readlink("/proc/self/ns/net")
    links = json.loads(subprocess.check_output(["ip", "-json", "link", "show"], text=True))
    validate_namespace(parent, current, links)
    evidence, verification, work = Path(args.evidence).resolve(), Path(args.verification).resolve(), Path(args.work).resolve()
    sbom = read_json(evidence / "dogecoin-1.14.9-internal-reproduction.spdx.json")
    validate_handoff(read_json(verification / "provenance.json"), read_json(verification / "sbom.json"), sbom)
    require(not work.exists(), "fresh private D2 working directory required")
    work.mkdir(mode=0o700)
    bins, data, out = work / "bin", work / "data", work / "evidence"
    for directory in (bins, data, out): directory.mkdir(mode=0o700)
    report = {"diagnosticStatus": "FAIL", "qualificationStatus": "BLOCKED", "phase": "D2",
              "activationAuthorized": False, "mainnetUsed": False, "realFundsUsed": False,
              "walletDisabled": True, "signingPerformed": False, "broadcastPerformed": False,
              "d0ArchiveSha256": SHA256, "blockingCriteria": manifest()["blockingCriteria"]}
    def save(): (out / "d2-report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    save()
    (out / "effective-manifest.json").write_text(json.dumps(manifest(), indent=2, sort_keys=True) + "\n")
    report["members"] = extract_verified_members(evidence / ARCHIVE, sbom, bins)
    resource.setrlimit(resource.RLIMIT_CPU, (420, 420))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024**2, 512 * 1024**2))
    def terminate(_number, _frame): raise TimeoutError("D2 diagnostic interrupted")
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGALRM, terminate); signal.alarm(600)
    report["consensusVectors"] = execute_consensus_vectors(bins / "libdogecoinconsensus.so.0.0.0")
    save()
    config = data / "dogecoin.conf"; config.write_text("regtest=1\ntestnet=0\n"); config.chmod(0o600)
    common = [f"-datadir={data}", f"-conf={config}", "-regtest=1", "-testnet=0", "-rpcport=18332"]
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    rpc_trace = []
    generated = 0
    def rpc(method, *params):
        nonlocal generated
        command = rpc_arguments(bins / "dogecoin-cli", common, method, *params)
        if method == "generatetoaddress":
            require(len([x for x in rpc_trace if x["method"] == method]) < len(GENERATE_SCHEDULE), "mining schedule exhausted")
            stage = len([x for x in rpc_trace if x["method"] == method])
            require(params[0] == str(GENERATE_SCHEDULE[stage]), "mining schedule/order mismatch")
            generated += int(params[0]); require(generated <= MAX_GENERATED_BLOCKS, "synthetic block budget exceeded")
        rpc_trace.append({"method": method, "params": list(params)})
        (out / "rpc-requests.json").write_text(json.dumps(rpc_trace, indent=2) + "\n")
        result = subprocess.run(command, env=env, capture_output=True, text=True, check=False,
                                timeout=180 if method == "generatetoaddress" else 10)
        # These fixed methods expose only public fixture/chain data. Never retain
        # cookies, private node data or the inherited GitHub environment.
        rpc_trace[-1].update({"exitCode": result.returncode, "stdoutSha256": sha256(result.stdout.encode()),
                              "stderr": result.stderr[:4096]})
        (out / "rpc-requests.json").write_text(json.dumps(rpc_trace, indent=2) + "\n")
        result.check_returncode()
        return result.stdout
    process = None
    try:
        with (out / "daemon-console.log").open("w") as log:
            process = subprocess.Popen([str(bins / "dogecoind"), *common, "-server=1", "-daemon=0",
                "-listen=0", "-connect=0", "-dnsseed=0", "-dns=0", "-discover=0", "-upnp=0",
                "-listenonion=0", "-onion=0", "-disablewallet=1", "-debug=rpc", "-rpcbind=127.0.0.1",
                "-rpcallowip=127.0.0.1", "-printtoconsole=1", "-dbcache=64", "-par=1"],
                env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 45
                while True:
                    require(process.poll() is None, "isolated node exited before readiness")
                    try:
                        chain = json.loads(rpc("getblockchaininfo")); break
                    except subprocess.CalledProcessError:
                        require(time.monotonic() < deadline, "RPC readiness deadline exceeded"); time.sleep(0.25)
                initial = {"blockchain": chain, "genesis": rpc("getblockhash", "0").strip(),
                           "network": json.loads(rpc("getnetworkinfo")), "peers": json.loads(rpc("getpeerinfo"))}
                validate_network(initial); validate_height(chain, 0, False)
                report["initialIdentity"] = initial
                decoded = []
                for fixture in DECODE_FIXTURES:
                    result = json.loads(rpc("decodescript", fixture["hex"]))
                    require(result.get("type") == fixture["expectedType"], "script Solver classification mismatch")
                    if fixture["name"] == "candidate_htlc_redeem":
                        require(result.get("p2sh") == base58check(b"\xc4" + hash160(HTLC_REDEEM)), "wrong synthetic candidate P2SH address")
                    decoded.append({"fixture": fixture, "observed": result})
                report["scriptClassifications"] = decoded
                heights, expected_height = [], 0
                for count in GENERATE_SCHEDULE:
                    hashes = json.loads(rpc("generatetoaddress", str(count), BURN_ADDRESS, str(MAX_TRIES_PER_CALL), "0"))
                    require(type(hashes) is list and len(hashes) == count and all(re.fullmatch(r"[0-9a-f]{64}", x) for x in hashes), "unexpected synthetic block generation result")
                    expected_height += count
                    observed = json.loads(rpc("getblockchaininfo"))
                    validate_height(observed, expected_height, expected_height >= CLTV_HEIGHT)
                    require(observed.get("bestblockhash") == hashes[-1], "generated tip mismatch")
                    heights.append(observed)
                    require(sum(x.stat().st_size for x in data.rglob("*") if x.is_file()) <= 512 * 1024**2, "D2 data budget exceeded")
                report["heightObservations"] = heights
                final_network, peers = json.loads(rpc("getnetworkinfo")), json.loads(rpc("getpeerinfo"))
                require(final_network.get("connections") == 0 and type(final_network.get("connections")) is int and peers == [], "D2 external connection or peer detected")
                require(final_network.get("version") == 1140900 and final_network.get("subversion") == "/Shibetoshi:1.14.9/", "D2 identity changed")
                report["finalNetwork"] = final_network; report["finalPeers"] = peers
            finally:
                if process.poll() is None:
                    try:
                        rpc("stop"); process.wait(timeout=15)
                    except (subprocess.SubprocessError, OSError, TimeoutError):
                        process.kill(); process.wait(timeout=10)
                        raise RuntimeError("D2 node failed clean shutdown")
        require(process.returncode == 0, "D2 daemon exit failure")
        report["shutdownExitCode"] = process.returncode
        report["serverRpcMethods"] = validate_server_methods((out / "daemon-console.log").read_text())
        require(not list(data.rglob("wallet*")), "unexpected wallet files")
        final_links = json.loads(subprocess.check_output(["ip", "-json", "link", "show"], text=True))
        validate_namespace(parent, os.readlink("/proc/self/ns/net"), final_links)
        report.update({"diagnosticStatus": "PASS", "generatedSyntheticBlocks": generated,
            "namespaceInterfacesBefore": links, "namespaceInterfacesAfter": final_links,
            "rpcRequests": rpc_trace, "walletFilesAbsent": True,
            "rpcRestriction": "private cookie plus fixed harness allowlist in loopback-only namespace; release has no native per-method RPC ACL",
            "standardnessLimit": "decodescript invokes Solver only; neither full transaction standardness nor mempool admission was tested",
            "scriptLimit": "explicit C-ABI CLTV flag cases are not signed HTLC claim/refund or transaction finality tests"})
    except BaseException as error:
        report["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        signal.alarm(0); save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", action="store_true")
    for option in ("evidence", "verification", "work", "authorization", "parent-net-ns"):
        parser.add_argument("--" + option)
    arguments = parser.parse_args()
    if arguments.manifest:
        print(json.dumps(manifest(), indent=2, sort_keys=True))
    else:
        require(all(getattr(arguments, k.replace("-", "_")) for k in ("evidence", "verification", "work", "authorization", "parent-net-ns")), "all execution options required")
        run(arguments)
