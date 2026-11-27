"""Exercise bounded pre-signed Pearl refunds on isolated native nodes, or replay the public blocks."""
import argparse
import json
import os
from pathlib import Path
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from fee_plan import choose_quote, verify_plan
from private_node import MAGIC, private_node, record, require
from qualify import accept, generate, relay_minimum, relay_rate, submit_fixture_block


CONFIRMED_RATES = (1_000, 11_000, 20_000, 21_746)
OVER_BUDGET = 21_747


def save_block(archive, branch, height, block):
    block_hash, raw = block
    entry = ZipInfo(f"{branch}/{height:03d}-{block_hash}.blk", (1980, 1, 1, 0, 0, 0))
    archive.writestr(entry, bytes.fromhex(raw), compress_type=ZIP_DEFLATED, compresslevel=1)


def restore(node, blocks):
    for block in blocks:
        submit_fixture_block(node, *block)
    require(node.rpc("getblockcount") == len(blocks) and node.rpc("getbestblockhash") == blocks[-1][0],
            "restored chain does not match public checkpoint")


def output_at(node, txid, amount, script):
    out = node.rpc("gettxout", txid, 0)
    require(out and out["value"] * 100_000_000 == amount and out["scriptPubKey"]["hex"] == script,
            "wrong confirmed output")
    return out


def selected_pair(nodes, quotes):
    rates = [relay_rate(node) for node in nodes]
    return choose_quote(quotes, max(rates)), rates


def try_funding(nodes, plan, quotes):
    tips = [node.rpc("getbestblockhash") for node in nodes]
    require(len(nodes) == 2 and tips[0] == tips[1], "two agreeing private observers required before funding")
    for node in nodes:
        require(node.rpc("getblockcount") == 100 and not node.rpc("getrawmempool") and
                node.rpc("gettxout", plan["fundingTxid"], 0) is None, "private contract already funded or wrong tip")
    quote, rates = selected_pair(nodes, quotes)
    if quote is None:
        record("funding-refused-by-cap", floors=rates, max_fee_grains=plan["maxRefundFeeGrains"],
               funding_submitted=False, tip=tips[0])
        return False
    require(all(accept(node, plan["funding"])["allowed"] for node in nodes), "private funding failed admission")
    require(nodes[0].rpc("sendrawtransaction", plan["funding"]) == plan["fundingTxid"], "funding ID changed")
    record("funding-submitted-after-verification", funding=plan["fundingTxid"], floors=rates,
           cheapest_refund_fee=quote["FeeGrains"], maximum_refund_fee=plan["maxRefundFeeGrains"])
    return True


def check_admission(node, plan, quotes):
    rate = relay_rate(node)
    for option, quote in zip(plan["options"], quotes, strict=True):
        result = accept(node, option["refund"])
        fee = quote["FeeGrains"]
        minimum = relay_minimum(rate, quote["Vsize"])
        if fee >= minimum:
            require(result.get("allowed") and result["vsize"] == quote["Vsize"] and
                    result["fees"]["base"] * 100_000_000 == fee, "native refund admission differs from quote")
        else:
            require(not result.get("allowed") and f"has {fee} fees which is under the required amount of {minimum}"
                    in result.get("reject-reason", ""), "unexpected reason for fee refusal")
        record("refund-admission", rate=rate, fee_grains=fee, required_grains=minimum,
               allowed=bool(result.get("allowed")), txid=quote["Txid"], reason=result.get("reject-reason"))


def confirm_pair(node, peers, plan, quotes, archive, expected_fee):
    quote, rates = selected_pair([node, *peers], quotes)
    if expected_fee is None:
        require(quote is None and not node.rpc("getrawmempool"), "over-budget choice or nonempty mempool")
        output_at(node, plan["fundingTxid"], plan["contractGrains"], plan["contractScript"])
        record("recovery-refused-by-cap", floor=max(rates), max_fee_grains=plan["maxRefundFeeGrains"],
               required_grains=relay_minimum(max(rates), quotes[-1]["Vsize"]), funding_unspent=True, sent=False)
        return
    require(quote and quote["FeeGrains"] == expected_fee, "unexpected recovery fee chosen")
    choice = next(row for row in plan["options"] if row["refundTxid"] == quote["Txid"])
    first = plan["contractGrains"] - quote["FeeGrains"]
    payments = [(105, choice["refund"], quote["Txid"], plan["fundingTxid"], first, plan["destination"],
                 quote["Vsize"], quote["FeeGrains"]),
                (106, choice["child"], quote["ChildTxid"], quote["Txid"], first - quote["ChildFeeGrains"],
                 plan["nextScript"], quote["ChildVsize"], quote["ChildFeeGrains"])]
    for height, raw, txid, parent, amount, script, vsize, fee in payments:
        for observer in [node, *peers]:
            result = accept(observer, raw)
            require(result.get("allowed") and result["vsize"] == vsize and result["fees"]["base"] * 100_000_000 == fee,
                    "signed payment failed node admission")
            require(observer.rpc("sendrawtransaction", raw) == txid and set(observer.rpc("getrawmempool")) == {txid},
                    "submitted payment did not become the sole pending transaction")
        block = generate(node)
        for peer in peers:
            submit_fixture_block(peer, *block)
        for observer in [node, *peers]:
            require(observer.rpc("getblockhash", height) == block[0] and observer.rpc("gettxout", parent, 0) is None
                    and output_at(observer, txid, amount, script)["confirmations"] == 1, "nodes disagree on payment")
        save_block(archive, f"rate-{max(rates)}", height, block)
        record("confirmed-presigned-payment", rate=max(rates), height=height, block=block[0], txid=txid,
               spent=parent, paid_grains=amount, fee_grains=fee, vsize=vsize, observers=1+len(peers))


def campaign(args, root, archive):
    plan, quotes = verify_plan(args.plan, args.commitment, args.network, args.verifier)
    record("all-payments-verified-before-funding", commitment=args.commitment, network=args.network, quotes=quotes)
    seed = []
    with args.blocks.open() as source:
        for height, line in enumerate(source, 1):
            require(height <= 100 and len(line) <= 2_000_256, "oversized public chain fixture")
            block_hash, raw = json.loads(line)
            seed.append((block_hash, raw))
    require(len(seed) == 100, "unexpected coinbase maturity checkpoint")

    def observer(name, rate=1_000, existing=False):
        return private_node(args.pearld, root / name, args.network, plan["payout"],
                            relay_grains_per_kvb=rate, existing=existing)

    with observer("a") as a:
        restore(a, seed)
        # Exercise the ordinary funding entry point with independently configured, disagreeing observers.
        with observer("above-cap", OVER_BUDGET) as over:
            restore(over, seed)
            require(not try_funding([a, over], plan, quotes), "uncovered private funding was submitted")
            require(not a.rpc("getrawmempool") and not over.rpc("getrawmempool"), "refused funding reached a mempool")
        with observer("b") as b:
            restore(b, seed)
            require(try_funding([a, b], plan, quotes), "covered private funding refused")
            for height, block in enumerate(seed, 1):
                save_block(archive, "common", height, block)
            common = list(seed)
            for height in range(101, 105):
                block = generate(a)
                submit_fixture_block(b, *block)
                common.append(block)
                save_block(archive, "common", height, block)
                for node in (a, b):
                    output_at(node, plan["fundingTxid"], plan["contractGrains"], plan["contractScript"])
                if height == 103:
                    for option in plan["options"]:
                        result = accept(b, option["refund"])
                        require(not result.get("allowed") and "not finalized" in result.get("reject-reason", ""),
                                "premature plan refund admitted")
            cheap = plan["options"][0]
            require(a.rpc("sendrawtransaction", cheap["refund"]) == cheap["refundTxid"] and
                    a.rpc("getrawmempool") == [cheap["refundTxid"]] and not b.rpc("getrawmempool"),
                    "unexpected initial pending refund")
            record("low-fee-refund-pending-on-a", txid=cheap["refundTxid"], height=104,
                   tip=b.rpc("getbestblockhash"), b_rate=relay_rate(b))

        # The HTLC and beneficiary signers have exited. Reopen the same funded B database under a new relay floor.
        plan, quotes = verify_plan(args.plan, args.commitment, args.network, args.verifier)
        with observer("b", 20_000, existing=True) as b:
            require(b.rpc("getbestblockhash") == common[-1][0] and not b.rpc("getrawmempool") and relay_rate(b) == 20_000,
                    "restarted observer lost its funded history or uses the wrong policy")
            check_admission(b, plan, quotes)
            confirm_pair(b, [a], plan, quotes, archive, 3_000)
            require(a.rpc("gettxout", cheap["refundTxid"], 0) is None, "replaced refund still canonical")
            record("pending-refund-replaced-and-observers-converged", old=cheap["refundTxid"],
                   confirmed=quotes[-1]["Txid"], common_tip=a.rpc("getbestblockhash"), floors=[1_000, 20_000])

    for rate, expected_fee in [(1_000, 1_500), (11_000, 2_000), (21_746, 3_000), (OVER_BUDGET, None)]:
        with observer(f"branch-{rate}", rate) as node:
            restore(node, common)
            require(relay_rate(node) == rate, "wrong private relay floor")
            check_admission(node, plan, quotes)
            confirm_pair(node, [], plan, quotes, archive, expected_fee)


def replay(args, root, archive):
    plan, quotes = verify_plan(args.plan, args.commitment, args.network, args.verifier)
    expected_members = {("common", h) for h in range(1, 105)}
    expected_members.update((f"rate-{r}", h) for r in CONFIRMED_RATES for h in (105, 106))
    members = {}
    for entry in archive.infolist():
        branch, name = entry.filename.split("/")
        height, filename = name.split("-", 1)
        block_hash = filename.removesuffix(".blk")
        key = (branch, int(height))
        require(key in expected_members and key not in members and len(block_hash) == 64 and
                len(bytes.fromhex(block_hash)) == 32 and filename.endswith(".blk") and 0 < entry.file_size <= 1_000_000,
                "unexpected public block in archive")
        members[key] = (block_hash, archive.read(entry).hex())
    require(set(members) == expected_members, "public archive is incomplete")
    common = [members["common", h] for h in range(1, 105)]
    for rate in CONFIRMED_RATES:
        quote = choose_quote(quotes, rate)
        with private_node(args.pearld, root / str(rate), args.network, plan["payout"], relay_grains_per_kvb=rate) as node:
            restore(node, common)
            output_at(node, plan["fundingTxid"], plan["contractGrains"], plan["contractScript"])
            amount = plan["contractGrains"]-quote["FeeGrains"]
            for height, txid, prev, value, dest in [
                    (105, quote["Txid"], plan["fundingTxid"], amount, plan["destination"]),
                    (106, quote["ChildTxid"], quote["Txid"], amount-quote["ChildFeeGrains"], plan["nextScript"])]:
                block = members[f"rate-{rate}", height]
                submit_fixture_block(node, *block)
                require(node.rpc("getblockhash", height) == block[0] and node.rpc("gettxout", prev, 0) is None and
                        output_at(node, txid, value, dest)["confirmations"] == 1, "passive replay payment mismatch")
                record("public-plan-payment-replayed", rate=rate, height=height, block=block[0], txid=txid, grains=value)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, choices=tuple(MAGIC))
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--commitment", required=True, help="independently retained SHA-256 from preparation")
    parser.add_argument("--verify-refund", dest="verifier", type=Path, required=True)
    parser.add_argument("--pearld", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--blocks", type=Path, help="100 prepared public blocks; create a new evidence ZIP")
    mode.add_argument("--replay", action="store_true", help="passively validate all four branches from the existing ZIP")
    args = parser.parse_args()
    args.verifier = args.verifier.resolve(strict=True)
    args.pearld = args.pearld.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="prl-refund-plan-") as tmp:
        root = Path(tmp)
        if args.replay:
            with ZipFile(args.archive) as archive:
                replay(args, root, archive)
        else:
            require(not args.archive.exists(), "output archive already exists")
            with tempfile.TemporaryDirectory(dir=args.archive.parent, prefix="prl-public-archive-") as staging:
                pending = Path(staging) / "public.zip"
                with ZipFile(pending, "x") as archive:
                    campaign(args, root, archive)
                # Publish a complete archive once. An interrupted run leaves the requested path available for retry.
                os.link(pending, args.archive)
    require(not root.exists(), "private plan node data directory remains")
    record("fee-plan-run-complete", network=args.network, passive=args.replay, private_data_removed=True)
