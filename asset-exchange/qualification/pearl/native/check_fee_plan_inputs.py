"""Check a public lab plan and the failure reasons for altered authorizations offline."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

from fee_plan import choose_quote, verify_plan
from private_node import MAGIC, record, require


def check(plan_file, digest, network, verifier):
    original, quotes = verify_plan(plan_file, digest, network, verifier)
    for rate, fee in [(1000, 1500), (11000, 2000), (20000, 3000), (21746, 3000), (21747, None)]:
        selected = choose_quote(quotes, rate)
        require((selected["FeeGrains"] if selected else None) == fee, "wrong fee-plan boundary")
    other_script = "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    unknown = {**original, "extra": "unexpected"}
    second = original["options"][1]
    options = original["options"]
    changes = [
        ("wrong-commitment", original, "0"*64, network, "recovery plan commitment mismatch"),
        ("wrong-private-network", original, digest, "simnet" if network == "regtest" else "regtest", "private plan identity mismatch"),
        ("unknown-field", unknown, None, network, "unexpected recovery plan fields"),
        ("larger-budget", {**original, "maxRefundFeeGrains": 3001}, None, network, "invalid lab payment intent"),
        ("smaller-payout", {**original, "minRefundGrains": 996999}, None, network, "invalid lab payment intent"),
        ("noninteger-budget", {**original, "maxRefundFeeGrains": 3000.0}, None, network, "non-integer network or payment parameter"),
        ("missing-option", {**original, "options": options[:-1]}, None, network, "incomplete fee plan"),
        ("reordered-options", {**original, "options": list(reversed(options))}, None, network, "unexpected refund fee or order"),
        ("reused-contract-as-destination", {**original, "nextScript": original["contractScript"]},
         None, network, "invalid lab payment intent"),
        ("different-refund-beneficiary", {**original, "destination": other_script},
         None, network, "native verification refused fee option 1500"),
        ("different-child-destination", {**original, "nextScript": other_script},
         None, network, "native verification refused fee option 1500"),
        ("wrong-refund", {**original, "options": [{**options[0], "refund": second["refund"]}, *options[1:]]},
         None, network, "native verification refused fee option 1500"),
        ("child-of-another-option", {**original, "options": [{**options[0], "child": second["child"]}, *options[1:]]},
         None, network, "native verification refused fee option 1500"),
        ("wrong-child-txid", {**original, "options": [{**options[0], "childTxid": second["childTxid"]}, *options[1:]]},
         None, network, "verified plan quote mismatch"),
    ]
    with tempfile.TemporaryDirectory(prefix="prl-plan-input-") as tmp:
        path = Path(tmp) / "candidate.json"
        for name, document, expected_digest, expected_network, error in changes:
            data = json.dumps(document, sort_keys=True).encode()
            path.write_bytes(data)
            try:
                verify_plan(path, expected_digest or hashlib.sha256(data).hexdigest(), expected_network, verifier)
            except RuntimeError as exc:
                require(str(exc) == error, f"{name} did not reach its expected check: {exc}")
                record("mutation-refused", network=network, check=name, reason=str(exc))
            else:
                raise RuntimeError(f"accepted changed plan: {name}")
        raw = plan_file.read_bytes()
        for name, data, error in [
                ("duplicate-field", b'{"format":"second",' + raw[1:], "duplicate field in recovery plan"),
                ("oversize-document", b" " * 32769, "recovery plan commitment mismatch")]:
            path.write_bytes(data)
            try:
                verify_plan(path, hashlib.sha256(data).hexdigest(), network, verifier)
            except RuntimeError as exc:
                require(str(exc) == error, f"{name} reached an unexpected check")
                record("mutation-refused", network=network, check=name, reason=str(exc))
            else:
                raise RuntimeError(f"accepted changed document: {name}")
    record("offline-plan-checks-complete", network=network, choices=len(quotes), boundaries=5, refusals=len(changes)+2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=tuple(MAGIC), required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--commitment", required=True)
    parser.add_argument("--verify-refund", type=Path, required=True)
    args = parser.parse_args()
    check(args.plan, args.commitment, args.network, args.verify_refund.resolve(strict=True))
