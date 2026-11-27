"""Recover a private Pearl refund from the published blocks and two public receipts."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

EVIDENCE = Path(__file__).resolve().parent
sys.path.insert(0, str(EVIDENCE.parents[4] / "asset-exchange/qualification/pearl/native"))
from private_node import private_node, record, require
from qualify import accept, generate, submit_fixture_block


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replay(node, member, archive, height):
    named = re.fullmatch(r"(\d{3})-([0-9a-f]{64})\.blk", member.filename)
    require(named and int(named[1]) == height and 0 < member.file_size <= 1_000_000, "unexpected public block entry")
    block_hash = named[2]
    submit_fixture_block(node, block_hash, archive.read(member).hex())
    require(node.rpc("getblockhash", height) == block_hash, "public block outside canonical history")
    return block_hash


def recover(node, checkpoint, refund, child, output):
    archive_path = EVIDENCE / "regtest-public-blocks-001-104.zip"
    require(digest(archive_path) == checkpoint["archiveSha256"], "checkpoint archive digest mismatch")
    with ZipFile(archive_path) as archive:
        members = archive.infolist()
        require(len(members) == 104, "expected 104 checkpoint blocks")
        for height, member in enumerate(members, 1):
            replay(node, member, archive, height)
    require(node.rpc("getbestblockhash") == checkpoint["tip"], "wrong restoration tip")
    locked = node.rpc("gettxout", checkpoint["funding"], 0)
    require(locked and locked["value"] * 100_000_000 == 1_000_000 and
            locked["scriptPubKey"]["hex"] == refund["Intent"]["ContractScript"], "missing public contract")
    record("public-checkpoint-restored", height=104, tip=checkpoint["tip"], funding=checkpoint["funding"])

    generate_blocks = output is not None
    path = output if generate_blocks else EVIDENCE / "regtest-public-blocks-105-106.zip"
    payments = [(refund["Refund"], checkpoint["refund"], checkpoint["funding"], 998_500, refund["Intent"]["Destination"]),
                (child["raw"], checkpoint["recipient"], checkpoint["refund"], 996_500, child["nextScript"])]
    with ZipFile(path, "x" if generate_blocks else "r") as archive:
        if not generate_blocks:
            require(len(archive.infolist()) == len(payments), "unexpected continuation length")
        for height, (raw, txid, spent, amount, destination) in enumerate(payments, 105):
            if generate_blocks:
                require(accept(node, raw)["allowed"] and node.rpc("sendrawtransaction", raw) == txid,
                        "public private-network payment rejected")
                block_hash, encoded = generate(node)
                member = ZipInfo(f"{height:03d}-{block_hash}.blk", (1980, 1, 1, 0, 0, 0))
                archive.writestr(member, bytes.fromhex(encoded), compress_type=ZIP_DEFLATED, compresslevel=1)
            else:
                block_hash = replay(node, archive.infolist()[height-105], archive, height)
            paid = node.rpc("gettxout", txid, 0)
            require(paid and paid["confirmations"] == 1 and paid["scriptPubKey"]["hex"] == destination and
                    paid["value"] * 100_000_000 == amount and node.rpc("gettxout", spent, 0) is None,
                    "unexpected confirmed payment or unspent parent")
            record("public-payment-confirmed", height=height, block=block_hash, txid=txid, grains=amount)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pearld", type=Path, required=True)
    parser.add_argument("--verifier", type=Path, required=True)
    parser.add_argument("--generate-continuation", type=Path, help="create a new 105–106 archive on private Regtest")
    args = parser.parse_args()
    checkpoint = json.loads((EVIDENCE / "regtest-public-checkpoint.json").read_bytes())
    refund_path = EVIDENCE / "regtest-refund.json"
    child_path = EVIDENCE / "regtest-recipient-spend.json"
    require(checkpoint["network"] == "regtest" and digest(refund_path) == checkpoint["refundCommitment"]
            and digest(child_path) == checkpoint["recipientCommitment"], "public receipt mismatch")
    refund = json.loads(refund_path.read_bytes())
    child = json.loads(child_path.read_bytes())
    verified = subprocess.run([args.verifier.resolve(strict=True)], input=refund_path.read_bytes(),
                              capture_output=True, check=True, timeout=10)
    require(verified.stdout.decode().strip() == checkpoint["refund"] == child["refund"] and
            child["txid"] == checkpoint["recipient"], "public refund and recipient disagree")
    with tempfile.TemporaryDirectory(prefix="prl-public-replay-") as owned:
        root = Path(owned)
        with private_node(args.pearld.resolve(strict=True), root / "reader", "regtest", checkpoint["payout"]) as node:
            recover(node, checkpoint, refund, child, args.generate_continuation)
    require(not root.exists(), "private replay data directory remains")
    record("public-recovery-complete", network="regtest", generated=args.generate_continuation is not None)
