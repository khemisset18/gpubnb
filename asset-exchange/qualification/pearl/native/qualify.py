"""Replay a locally prepared private chain on two independent pinned pearld processes."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from private_node import GENESIS, MAGIC, RpcError, private_node, record, require


def accept(node, raw):
    result, = node.rpc("testmempoolaccept", [raw], 0.1)
    return result


def reject(node, raw, case, expected):
    result = accept(node, raw)
    reason = result.get("reject-reason", "")
    require(result.get("allowed", False) is False and any(s in reason.lower() for s in expected),
            f"{case}: unexpected mempool outcome {result}")
    record(case, reason=reason)


def submit_fixture_block(node, expected, raw):
    require(node.rpc("submitblock", raw) is None, "peer block rejected")
    require(node.rpc("getblock", expected, 0) == raw, "wrong block")


def generate(node):
    block, = node.rpc("generate", 1, timeout=240)
    return block, node.rpc("getblock", block, 0)


def recovery_input(f):
    return {"Intent": {"Network": f["network"], "Genesis": GENESIS, "Magic": f["magic"],
                       "FundingTxid": f["fundingTxid"], "ContractScript": f["contractScript"],
                       "Destination": f["destination"], "Height": f["height"],
                       "ContractValue": 1_000_000, "RefundValue": 998_500},
            "Funding": f["funding"], "Refund": f["refund"]}


def check_recovery(verifier, capsule, expected, *, valid=True):
    result = subprocess.run([verifier], input=json.dumps(capsule), text=True, capture_output=True,
                            env={"LC_ALL": "C"}, timeout=10)
    if valid:
        require(result.returncode == 0 and result.stdout.strip() == expected, "independent refund check failed")
    else:
        require(result.returncode != 0, "changed public recovery intent accepted")


def confirm_recipient_spend(a, b, f, child):
    decoded = b.rpc("decoderawtransaction", child["raw"])
    source, = decoded["vin"]
    dest, = decoded["vout"]
    require(decoded["txid"] == child["txid"] and source["txid"] == f["refundTxid"] and source["vout"] == 0,
            "independent child does not spend the confirmed refund")
    require(dest["value"] * 100_000_000 == 996_500 and dest["scriptPubKey"]["hex"] == child["nextScript"],
            "wrong independent recipient output")
    result = accept(b, child["raw"])
    require(result["allowed"] and result["fees"]["base"] * 100_000_000 == 2_000, "unexpected child or fee")
    require(b.rpc("sendrawtransaction", child["raw"]) == child["txid"], "changed recipient transaction")
    block, raw = generate(b)
    submit_fixture_block(a, block, raw)
    for observer in (a, b):
        utxo = observer.rpc("gettxout", child["txid"], 0)
        require(observer.rpc("gettxout", f["refundTxid"], 0) is None and utxo["confirmations"] == 1 and
                utxo["value"] * 100_000_000 == 996_500 and utxo["scriptPubKey"]["hex"] == child["nextScript"],
                "recipient payment missing from canonical chain")
    record("independent-recipient-spent-refund", refund=f["refundTxid"], child=child["txid"],
           height=b.rpc("getblockcount"), block=block, paid_grains=996_500, fee_grains=2_000)
    return result["vsize"]


def check_high_relay(binary, temp, material, f, archive, final_block, refund_vsize, child, child_vsize, rate):
    with private_node(binary, temp / f"relay-{rate}", f["network"], f["payout"], relay_grains_per_kvb=rate) as observer:
        floor = int(observer.rpc("getnetworkinfo")["relayfee"] * 100_000_000)
        require(floor == rate, "unexpected higher relay policy")
        for path in (material / "blocks.jsonl", archive):
            with path.open() as saved:
                for line in saved:
                    submit_fixture_block(observer, *json.loads(line))
        require(observer.rpc("getblockcount") == f["height"], "wrong fee-check height")
        required_fee = floor * refund_vsize // 1000
        reject(observer, f["refund"], "fixed-refund-above-fee-budget",
               (f"has 1500 fees which is under the required amount of {required_fee}",))
        require(not observer.rpc("getrawmempool") and observer.rpc("gettxout", f["fundingTxid"], 0),
                "policy rejection changed spend state")
        if child is not None:
            raw_pair = [f["refund"], child["raw"]]
            pair = observer.rpc("testmempoolaccept", raw_pair, 0.1)
            require(len(pair) == 2 and [item["txid"] for item in pair] == [f["refundTxid"], child["txid"]]
                    and all(not item.get("allowed", False) for item in pair), "paired preview changed fee decision")
            try:
                observer.rpc("submitpackage", raw_pair)
            except RpcError as error:
                require(error.args[0]["code"] == -32601, "unexpected package RPC error")
                record("package-relay-unavailable", rate_grains_per_kvb=floor, total_fee_grains=3_500,
                       total_vsize=refund_vsize + child_vsize, preview_reasons=[r.get("reject-reason") for r in pair],
                       error=error.args[0])
            else:
                raise RuntimeError("unexpected package submission behavior on pinned node")
            require(not observer.rpc("getrawmempool"), "package probe changed the mempool")
        submit_fixture_block(observer, *final_block)
        payout = observer.rpc("gettxout", f["refundTxid"], 0)
        require(payout["confirmations"] == 1 and payout["value"] * 100_000_000 == 998_500 and
                payout["scriptPubKey"]["hex"] == f["destination"], "different policy rejected canonical refund")
        record("relay-policy-versus-confirmed-refund", min_relay_grains_per_kvb=floor, refund_grains=1500,
               required_grains=required_fee, vsize=refund_vsize, refund=f["refundTxid"], block=final_block[0])


def assess(binary, verifier, material, network, temp, expected_commitment, fee_bump, fee_boundaries,
           recipient_commitment=None, high_relay=False):
    f = json.loads((material / "fixture.json").read_text())
    require(f["network"] == network and f["magic"] == MAGIC[network], "wrong network fixture")
    child = None
    child_vsize = None
    if recipient_commitment is not None:
        child = f["recipientSpend"]
        digest = hashlib.sha256(json.dumps(child, sort_keys=True).encode()).hexdigest()
        require(digest == recipient_commitment and child["recipientScript"] == f["destination"] and
                child["network"] == network and child["refund"] == f["refundTxid"], "recipient commitment mismatch")
    capsule = recovery_input(f)
    canonical = json.dumps(capsule, sort_keys=True).encode()
    checksum = hashlib.sha256(canonical).hexdigest()
    require(checksum == expected_commitment, "recovery intent differs from preparation receipt")
    check_recovery(verifier, capsule, f["refundTxid"])
    for field, value in [("Magic", 0), ("Destination", f["contractScript"]), ("RefundValue", 998499)]:
        altered = {**capsule, "Intent": {**capsule["Intent"], field: value}}
        check_recovery(verifier, altered, f["refundTxid"], valid=False)
    # Reuse only this public recovery record and its separately retained commitment on restart.
    recovery_file = temp / "refund.json"
    recovery_file.write_bytes(canonical)
    record("independent-verifier-before-funding", refund=f["refundTxid"], receipt_sha256=checksum,
           wrong_magic_rejected=True, wrong_destination_rejected=True, wrong_amount_rejected=True)
    with private_node(binary, temp / "observer-a", network, f["payout"]) as a:
        with private_node(binary, temp / "observer-b", network, f["payout"]) as b:
            with (material / "blocks.jsonl").open() as stream:
                for line in stream:
                    block, raw = json.loads(line)
                    for n in (a, b):
                        submit_fixture_block(n, block, raw)
            for n in (a, b):
                require(n.rpc("getblockcount") == 100, "immature/incomplete fixture")
                require(accept(n, f["funding"])["allowed"] is True, "funding unavailable")
            record("two-independently-validated-chains", height=100, tip=a.rpc("getbestblockhash"))
            confirmation = a.rpc("sendrawtransaction", f["funding"])
            require(confirmation == f["fundingTxid"], "funding ID changed")
            fundblock, fund_raw = generate(a)
            submit_fixture_block(b, fundblock, fund_raw)
            utxo = b.rpc("gettxout", confirmation, 0)
            require(utxo["confirmations"] == 1 and utxo["scriptPubKey"]["hex"] == f["contractScript"]
                    and utxo["value"] * 100_000_000 == 1_000_000, "unexpected confirmed lock")
            record("funding-confirmed", txid=confirmation, block=fundblock, value_grains=1_000_000)
            reject(a, f["refund"], "refund-premature", ("final", "lock"))
            reject(a, f["badSecret"], "wrong-preimage", ("script", "verify"))
            reject(a, f["dust"], "dust", ("dust",))
            reject(a, f["zeroFee"], "zero-fee-admission", ("fee",))
            if fee_boundaries:
                fee, dust = f["feeFloorGrains"], f["dustFloorGrains"]
                reject(a, f["belowFee"], "one-grain-under-relay-floor",
                       (f"has {fee-1} fees which is under the required amount of {fee}",))
                reject(a, f["belowDust"], "one-grain-under-dust-floor", (f"payment is dust: {dust-1}",))
                at_fee, at_dust = accept(a, f["atFee"]), accept(a, f["atDust"])
                require(at_fee["allowed"] and at_fee["vsize"] == fee and
                        at_fee["fees"]["base"] * 100_000_000 == fee, "exact relay floor not admitted")
                require(at_dust["allowed"] and at_dust["fees"]["base"] * 100_000_000 == 1_000_000-dust,
                        "exact P2TR dust floor not admitted")
                record("exact-policy-boundaries", fee_grains=fee, vsize=at_fee["vsize"],
                       dust_grains=dust, fee_txid=at_fee["txid"], dust_txid=at_dust["txid"])
            valid_claim = accept(a, f["claim"])
            require(valid_claim["allowed"], "claim refused")
            claim_id = f["claimTxid"]
            if fee_bump:
                first = a.rpc("sendrawtransaction", f["rbfBase"])
                reject(a, f["rbfLower"], "replacement-lower-fee", ("fee",))
                require(accept(a, f["rbfHigher"])["allowed"], "higher-fee replacement refused")
                claim_id = a.rpc("sendrawtransaction", f["rbfHigher"])
                require(set(a.rpc("getrawmempool")) == {claim_id} and first != claim_id,
                        "replacement did not evict the lower-fee claim")
                record("opt-in-replacement", replaced=first, confirmed_candidate=claim_id,
                       original_fee_grains=500, replacement_fee_grains=4000)
            else:
                require(a.rpc("sendrawtransaction", f["claim"]) == claim_id, "claim ID mismatch")
            # Inspect the same prevout on physically separate chain databases.
            claimblock, _ = generate(a)
            require(claim_id in a.rpc("getblock", claimblock, 1)["tx"], "claim never confirmed")
            require(a.rpc("gettxout", confirmation, 0) is None and b.rpc("gettxout", confirmation, 0) is not None,
                    "expected independent observer disagreement")
            record("claim-confirmed-observers-disagree", claim=claim_id, a_tip=claimblock, b_tip=fundblock)
            fork = []
            while b.rpc("getblockcount") < f["height"]:
                if b.rpc("getblockcount") == f["height"] - 1:
                    reject(b, f["refund"], "refund-at-H-minus-one", ("final", "lock"))
                fork.append(generate(b))
            require(accept(b, f["refund"])["allowed"], "refund unavailable at H")
            reject(b, f["shortLock"], "insufficient-script-locktime", ("script", "lock", "verify"))
            reject(b, f["badDestination"], "signature-binds-destination", ("script", "signature", "verify"))
            pre_restart_tip = b.rpc("getbestblockhash")
            archive = temp / "observer-archive.jsonl"
            with archive.open("x") as backup:
                for entry in [(fundblock, fund_raw), *fork]:
                    backup.write(json.dumps(entry) + "\n")
            # Crash this owned observer after durable blocks. The refund is still off-chain.
            b.proc.kill()
            require(b.proc.wait(timeout=15) == -9, "crash injection did not stop the owned node")
        # No signer or Exchange backend participates in recovery. Recover using a fresh process and the file only.
        with private_node(binary, temp / "observer-b", network, f["payout"], existing=True) as b:
            recovered_height = b.rpc("getblockcount")
            recovered_tip = b.rpc("getbestblockhash")
            # A sudden process death may lose unflushed blocks. Validate the
            # persisted prefix against the independent block archive before use.
            require(0 <= recovered_height <= f["height"], "unexpected restart height")
            if recovered_height == 0:
                require(recovered_tip == GENESIS, "restart genesis mismatch")
            height = 0
            for path in (material / "blocks.jsonl", archive):
                with path.open() as backup:
                    for line in backup:
                        height += 1
                        expected, public_block = json.loads(line)
                        if height == recovered_height:
                            require(recovered_tip == expected, "restart prefix disagrees with archive")
                        if height > recovered_height:
                            submit_fixture_block(b, expected, public_block)
            require(b.rpc("getbestblockhash") == pre_restart_tip, "archive failed to restore observed tip")
            restored_utxo = b.rpc("gettxout", f["fundingTxid"], 0)
            require(restored_utxo and restored_utxo["scriptPubKey"]["hex"] == f["contractScript"]
                    and restored_utxo["value"] * 100_000_000 == 1_000_000, "funding UTXO missing after crash")
            record("crash-recovery", recovered_height=recovered_height, archived_tip=pre_restart_tip,
                   revalidated_blocks=height - recovered_height)
            require(hashlib.sha256(recovery_file.read_bytes()).hexdigest() == checksum, "recovery record changed")
            restored = json.loads(recovery_file.read_text())
            check_recovery(verifier, restored, f["refundTxid"])
            require(f["refundTxid"] not in (b.rpc("getrawmempool") or []), "unexpected pending refund")
            refund_admission = accept(b, restored["Refund"])
            require(refund_admission["allowed"], "restored refund refused")
            refund_vsize = refund_admission["vsize"]
            require(b.rpc("sendrawtransaction", restored["Refund"]) == f["refundTxid"], "refund ID changed")
            reject(b, f["claim"], "same-outpoint-conflict", ("already spent in mempool", "conflict", "replace"))
            finalblock, raw = generate(b)
            fork.append((finalblock, raw))
            payout = b.rpc("gettxout", f["refundTxid"], 0)
            require(payout["confirmations"] == 1 and payout["value"] * 100_000_000 == 998_500 and
                    payout["scriptPubKey"]["hex"] == f["destination"], "wrong recovery payout")
            record("recovered-after-restart", refund=f["refundTxid"], block=finalblock,
                   height=b.rpc("getblockcount"), paid_grains=998_500, fee_grains=1_500)
            for block, raw in fork:
                submit_fixture_block(a, block, raw)
            require(a.rpc("getbestblockhash") == b.rpc("getbestblockhash") == finalblock, "tips failed to converge")
            require(a.rpc("gettxout", claim_id, 0) is None and a.rpc("gettxout", f["refundTxid"], 0) is not None,
                    "orphaned claim or canonical refund misreported")
            require(claim_id not in (a.rpc("getrawmempool") or []), "conflicting claim reappeared")
            record("longer-fork-disconnects-claim", orphan=claimblock, agreed_tip=finalblock,
                   canonical_refund=f["refundTxid"], peers=a.rpc("getconnectioncount"))
            try:
                b.rpc("getblockhash", b.rpc("getblockcount") + 1)
            except RpcError as err:
                require(err.args[0] == {"code": -1, "message": "Block number out of range"}, "unexpected error from out-of-range height")
                record("out-of-range-rpc", error=err.args[0])
            else:
                raise RuntimeError("unknown height returned a hash")
            if child is not None:
                child_vsize = confirm_recipient_spend(a, b, f, child)
    if high_relay:
        for rate in (11_000, 20_000):
            check_high_relay(binary, temp, material, f, archive, fork[-1], refund_vsize, child, child_vsize, rate)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pearld", type=Path, required=True)
    parser.add_argument("--verify-refund", type=Path, required=True)
    parser.add_argument("--commitment", required=True, help="SHA-256 retained separately at preparation")
    parser.add_argument("--fee-bump", action="store_true", help="exercise opt-in replacement using the prepared fee variants")
    parser.add_argument("--fee-boundaries", action="store_true", help="require the one-grain fee and dust boundary fixtures")
    parser.add_argument("--recipient-commitment", help="separately retained receipt of the independent recipient")
    parser.add_argument("--high-relay", action="store_true", help="recheck identical blocks under a higher relay fee")
    parser.add_argument("--material", type=Path, required=True)
    parser.add_argument("--network", choices=tuple(MAGIC), required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="prl-observers-") as root:
        directory = Path(root).resolve()
        assess(args.pearld.resolve(strict=True), args.verify_refund.resolve(strict=True),
               args.material.resolve(strict=True), args.network, directory, args.commitment,
               args.fee_bump, args.fee_boundaries, args.recipient_commitment, args.high_relay)
    require(not directory.exists(), "node directories still present")
    record("qualification-run-complete", network=args.network, data_removed=True)
