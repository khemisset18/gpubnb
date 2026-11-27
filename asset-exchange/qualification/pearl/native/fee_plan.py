"""Verify a public, private-network recovery plan before funding or recovery."""
import hashlib
import json
import subprocess

from private_node import GENESIS, MAGIC, require
from qualify import relay_minimum


FEES = (1_500, 2_000, 3_000)


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate field in recovery plan")
        result[key] = value
    return result


def verify_plan(path, commitment, network, verifier):
    with path.open("rb") as source:
        data = source.read(32_769)
    require(len(data) <= 32_768 and hashlib.sha256(data).hexdigest() == commitment, "recovery plan commitment mismatch")
    p = json.loads(data, object_pairs_hook=unique_fields)
    require(set(p) == {"format", "network", "magic", "genesis", "height", "payout", "funding", "fundingTxid",
                       "contractScript", "contractGrains", "destination", "nextScript", "maxRefundFeeGrains",
                       "minRefundGrains", "options"}, "unexpected recovery plan fields")
    require(all(type(p[name]) is int for name in ("magic", "height", "contractGrains", "minRefundGrains", "maxRefundFeeGrains")),
            "non-integer network or payment parameter")
    require(network in MAGIC and (p["format"], p["network"], p["magic"], p["genesis"], p["height"]) ==
            ("prl-lab-refund-plan-v1", network, MAGIC[network], GENESIS, 104), "private plan identity mismatch")
    require((p["contractGrains"], p["minRefundGrains"], p["maxRefundFeeGrains"]) == (1_000_000, 997_000, 3_000)
            and len({p["contractScript"], p["destination"], p["nextScript"]}) == 3, "invalid lab payment intent")
    options = p["options"]
    require(isinstance(options, list) and len(options) == len(FEES), "incomplete fee plan")
    quotes = []
    for fee, choice in zip(FEES, options, strict=True):
        require(set(choice) == {"feeGrains", "refund", "refundTxid", "child", "childTxid"} and
                type(choice["feeGrains"]) is int and choice["feeGrains"] == fee, "unexpected refund fee or order")
        intent = {"Network": network, "Magic": p["magic"], "Genesis": GENESIS, "Height": p["height"],
                  "FundingTxid": p["fundingTxid"], "ContractScript": p["contractScript"], "Destination": p["destination"],
                  "ContractValue": p["contractGrains"], "RefundValue": p["contractGrains"]-fee}
        capsule = {"Intent": intent, "Funding": p["funding"], "Refund": choice["refund"],
                   "Recipient": {"Raw": choice["child"], "Destination": p["nextScript"]}}
        result = subprocess.run([verifier, "--plan-quote", str(fee)], input=json.dumps(capsule), text=True,
                                capture_output=True, env={"LC_ALL": "C"}, timeout=10)
        require(result.returncode == 0, f"native verification refused fee option {fee}")
        q = json.loads(result.stdout)
        expected_child_fee = 2_000 if fee == FEES[0] else 3_000
        require((q["Txid"], q["ChildTxid"], q["FeeGrains"], q["ChildFeeGrains"]) ==
                (choice["refundTxid"], choice["childTxid"], fee, expected_child_fee) and
                all(type(q[k]) is int and q[k] > 0 for k in ("Vsize", "ChildVsize")), "verified plan quote mismatch")
        quotes.append(q)
    require(len({q["Txid"] for q in quotes}) == len(FEES) == len({q["ChildTxid"] for q in quotes}),
            "duplicate signed plan payment")
    return p, quotes


def choose_quote(quotes, rate):
    """Return the cheapest committed pair covering both payouts at the given observed floor."""
    for quote in quotes:
        if (quote["FeeGrains"] >= relay_minimum(rate, quote["Vsize"]) and
                quote["ChildFeeGrains"] >= relay_minimum(rate, quote["ChildVsize"])):
            return quote
    return None
