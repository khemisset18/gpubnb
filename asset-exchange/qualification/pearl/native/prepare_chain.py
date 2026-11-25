"""Create a private test chain and a presigned recovery fixture, never submit funding."""
import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from qualify import recovery_input, submit_fixture_block
from private_node import MAGIC, private_node, record, require

MATURITY = 100
REFUND_HEIGHT = MATURITY + 4


def signed_fixture(process, request, recipient_tool, directory):
    recipient = None
    try:
        if recipient_tool:
            recipient = subprocess.Popen([recipient_tool], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         cwd=directory, text=True, env={"LC_ALL": "C"})
            public = json.loads(recipient.stdout.readline())
            request["recipientScript"] = public["recipientScript"]
        response, _ = process.communicate(json.dumps(request), timeout=45)
        require(process.returncode == 0, "ephemeral signer failed its Pearl VM checks")
        bundle = json.loads(response)
        if recipient:
            require(bundle["destination"] == public["recipientScript"], "refund recipient changed")
            reply, _ = recipient.communicate(json.dumps({"Network": request["network"], "Refund": bundle["refund"]}), timeout=30)
            require(recipient.returncode == 0, "independent recipient refused the refund")
            child = {**json.loads(reply), **public, "network": request["network"], "refund": bundle["refundTxid"]}
            record("recipient-spend-commitment", network=request["network"],
                   sha256=hashlib.sha256(json.dumps(child, sort_keys=True).encode()).hexdigest(),
                   recipient_exited=recipient.returncode)
            bundle["recipientSpend"] = child
        return bundle
    finally:
        if recipient and recipient.poll() is None:
            recipient.kill()
            recipient.wait()


def prepare(binary, signer, network, output, recipient_tool):
    output.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix="prl-seed-") as tmp:
        directory = Path(tmp).resolve()
        process = subprocess.Popen([signer], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   cwd=directory, text=True, env={"LC_ALL": "C"})
        try:
            hello = json.loads(process.stdout.readline())
            with private_node(binary, directory / "node", network, hello["payout"]) as node:
                with (output / "blocks.jsonl").open("x") as stream:
                    for height in range(1, MATURITY + 1):
                        block, = node.rpc("generate", 1, timeout=240)
                        raw = node.rpc("getblock", block, 0)
                        stream.write(json.dumps([block, raw]) + "\n")
                        stream.flush()
                        if height == 1:
                            coinbase_id = node.rpc("getblock", block, 1)["tx"][0]
                            coinbase = node.rpc("getrawtransaction", coinbase_id, 1)
                            out, = [v for v in coinbase["vout"] if v["scriptPubKey"]["hex"] == hello["script"]]
                            request = {"network": network, "txid": coinbase_id, "output": out["n"],
                                       "value": int(out["value"] * 100_000_000),
                                       "height": REFUND_HEIGHT, "script": hello["script"]}
                            bundle = signed_fixture(process, request, recipient_tool, directory)
                            fixture = {**hello, **request, **bundle, "magic": MAGIC[network]}
                            (output / "fixture.json").write_text(json.dumps(fixture, sort_keys=True))
                            capsule = json.dumps(recovery_input(fixture), sort_keys=True).encode()
                            record("recovery-intent-commitment", network=network,
                                   sha256=hashlib.sha256(capsule).hexdigest())
                            record("refund-verified-before-funding", network=network,
                                   funding=bundle["fundingTxid"], refund=bundle["refundTxid"],
                                   signer_exited=process.returncode, submitted=False)
                        if height == 1 or height % 10 == 0:
                            record("generated", network=network, height=height, block=block)
                    require(node.rpc("getblockcount") == MATURITY, "incorrect maturity fixture")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    record("preparation-complete", network=network, data_removed=not directory.exists())


def resume(binary, network, output, expected_commitment):
    """Rebuild solely from public blocks; the preparation signer is already gone."""
    fixture = json.loads((output / "fixture.json").read_text())
    commitment = hashlib.sha256(json.dumps(recovery_input(fixture), sort_keys=True).encode()).hexdigest()
    require(commitment == expected_commitment and fixture["network"] == network
            and fixture["magic"] == MAGIC[network], "inconsistent recovery checkpoint")
    with tempfile.TemporaryDirectory(prefix="prl-resume-") as tmp:
        directory = Path(tmp).resolve()
        with private_node(binary, directory / "node", network, fixture["payout"]) as node:
            blocks = output / "blocks.jsonl"
            with blocks.open() as saved:
                for line in saved:
                    block, raw = json.loads(line)
                    submit_fixture_block(node, block, raw)
            height = node.rpc("getblockcount")
            require(0 < height <= MATURITY, "incomplete or oversized chain checkpoint")
            coinbase = node.rpc("getblock", node.rpc("getblockhash", 1), 1)["tx"][0]
            require(coinbase == fixture["txid"], "checkpoint belongs to a different coinbase")
            record("resumed-from-public-blocks", network=network, height=height, commitment=commitment)
            with blocks.open("a") as saved:
                for height in range(height + 1, MATURITY + 1):
                    block, = node.rpc("generate", 1, timeout=420)
                    raw = node.rpc("getblock", block, 0)
                    saved.write(json.dumps([block, raw]) + "\n")
                    saved.flush()
                    record("generated", network=network, height=height, block=block)
    record("preparation-complete", network=network, data_removed=not directory.exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pearld", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--fixture-signer", type=Path)
    mode.add_argument("--resume-commitment", help="pinned SHA-256 from the preparation receipt")
    parser.add_argument("--network", choices=tuple(MAGIC), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recipient-signer", type=Path, help="independent one-shot lab recipient for a new fixture")
    args = parser.parse_args()
    if args.resume_commitment and args.recipient_signer:
        parser.error("checkpoint recovery needs public data only")
    if args.resume_commitment:
        resume(args.pearld.resolve(strict=True), args.network, args.output.resolve(), args.resume_commitment)
    else:
        prepare(args.pearld.resolve(strict=True), args.fixture_signer.resolve(strict=True),
                args.network, args.output.resolve(),
                args.recipient_signer.resolve(strict=True) if args.recipient_signer else None)
