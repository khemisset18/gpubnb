"""Exercise the two offline processes with the published lab capsules."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def invoke(binary, payload, expected_error=None):
    result = subprocess.run([binary], input=payload, capture_output=True, timeout=10)
    if expected_error is None:
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode())
        return result.stdout.decode().strip()
    reason = result.stderr.decode().splitlines()[0]
    if result.returncode == 0 or reason != "panic: " + expected_error:
        raise RuntimeError(f"unexpected outcome {result.returncode} {reason}")
    return f"exit={result.returncode} {reason}"


def check(binary_dir, network):
    here = Path(__file__).resolve().parent
    capsule = (here / f"{network}-refund.json").read_bytes()
    recipient = json.loads((here / f"{network}-recipient-spend.json").read_bytes())
    intent = json.loads(capsule)
    verifier = binary_dir / "verifyrefund"
    signer = binary_dir / "recipient"
    txid = invoke(verifier, capsule)
    if txid != recipient["refund"]:
        raise RuntimeError("refunded outpoint differs from recipient receipt")
    print(f"{network} public refund verified sha256={hashlib.sha256(capsule).hexdigest()} txid={txid}")
    different_destination = {**intent, "Intent": {**intent["Intent"], "Destination": intent["Intent"]["ContractScript"]}}
    different_amount = {**intent, "Intent": {**intent["Intent"], "RefundValue": 998499}}
    for case, payload, reason in [
        ("trailing JSON", capsule + b"{}", "malformed recovery input"),
        ("truncated JSON", capsule[:-1], "malformed recovery input"),
        ("unknown field", json.dumps({**intent, "extra": 1}).encode(), "malformed recovery input"),
        ("capsule size", b" " * 16385, "oversize or unreadable recovery input"),
        ("transaction size", json.dumps({**intent, "Refund": "00" * 4096}).encode(), "oversize fixture transaction"),
        ("changed destination", json.dumps(different_destination).encode(), "wrong refund destination"),
        ("changed amount", json.dumps(different_amount).encode(), "wrong amount or fee"),
    ]:
        print(f"{network} verifyrefund {case}: {invoke(verifier, payload, reason)}")
    request = {"Network": network, "Refund": intent["Refund"]}
    for case, payload, reason in [
        ("other lab recipient", json.dumps(request).encode(), "refund does not pay the agreed lab recipient"),
        ("public-network label", b'{"Network":"mainnet","Refund":"00"}', "private network required"),
        ("second object", json.dumps(request).encode() + b"{}", "malformed recipient request"),
        ("input size", b" " * 8193, "oversize recipient request"),
    ]:
        print(f"{network} recipient {case}: {invoke(signer, payload, reason)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary_dir", type=Path)
    args = parser.parse_args()
    for private_net in ("regtest", "simnet"):
        check(args.binary_dir.resolve(strict=True), private_net)
