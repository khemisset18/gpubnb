"""Offline DOGE D8 *software* request preflight; never a hardware approval.

This tool never signs, connects to a device, invokes a daemon, transmits or
broadcasts a transaction. Independent receipts MUST come from a previously
retained trusted source; supplying self-computed matching digests is NOT an
independent authorization. No real funds or wallet keys.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
EXCHANGE = HERE.parents[2]
sys.path.insert(0, str(EXCHANGE / "wallet-agent" / "dogecoin"))
import refund_ladder as policy

MAX_REQUEST_BYTES = 65_536
REPORT_STATUS = "SOFTWARE_REQUEST_PREFLIGHT_PASS_HARDWARE_BLOCKED"
MUTATION_NAMES = (
    "network", "genesis", "source_commit", "request_id", "expiry",
    "destination", "funding_value", "funding_outpoint", "refund_role_or_redeem",
    "fee_cap", "fee_step", "refund_amount", "sighash", "unsigned_transaction",
    "sequence", "lock_time", "request_digest",
)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read_json(path):
    """No symlink, non-regular, oversized, or duplicate-key input."""
    location = Path(path)
    require(not location.is_symlink(), "request symlink not allowed")
    st = location.stat()
    require(location.is_file() and st.st_nlink == 1 and
            0 < st.st_size <= MAX_REQUEST_BYTES, "invalid bounded public request file")
    raw = location.read_bytes()
    require(0 < len(raw) <= MAX_REQUEST_BYTES, "oversized request")
    def unique(pairs):
        doc = {}
        for k, v in pairs:
            require(k not in doc, "duplicate JSON request key")
            doc[k] = v
        return doc
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def mutate(request, kind):
    value = copy.deepcopy(request)
    def toggle(hex_value):
        require(type(hex_value) is str and len(hex_value) > 2, "not a hex string")
        return hex_value[:-2] + ("00" if hex_value[-2:] != "00" else "01")
    if kind == "network":
        value["network"] = "mainnet"
    elif kind == "genesis":
        value["genesis"] = "00" * 32
    elif kind == "source_commit":
        value["sourceCommit"] = "0" * 40
    elif kind == "request_id":
        value["requestId"] += "x"
    elif kind == "expiry":
        value["requestExpiresAtHeight"] += 1
    elif kind == "destination":
        value["destinationHex"] = toggle(value["destinationHex"])
    elif kind == "funding_value":
        value["funding"]["valueKoinu"] = str(int(value["funding"]["valueKoinu"]) + 1)
    elif kind == "funding_outpoint":
        value["funding"]["vout"] += 1
    elif kind == "refund_role_or_redeem":
        value["contract"]["redeemHex"] = toggle(value["contract"]["redeemHex"])
    elif kind == "fee_cap":
        value["policy"]["maxFeeKoinu"] = str(int(value["policy"]["maxFeeKoinu"]) + 1)
    elif kind == "fee_step":
        value["entries"][0]["feeKoinu"] = str(int(value["entries"][0]["feeKoinu"]) + 1)
    elif kind == "refund_amount":
        value["entries"][0]["outputValueKoinu"] = str(int(value["entries"][0]["outputValueKoinu"]) + 1)
    elif kind == "sighash":
        value["entries"][0]["sighashHex"] = toggle(value["entries"][0]["sighashHex"])
    elif kind == "unsigned_transaction":
        value["entries"][0]["unsignedTransactionHex"] = toggle(value["entries"][0]["unsignedTransactionHex"])
    elif kind == "sequence":
        raw = bytes.fromhex(value["entries"][0]["unsignedTransactionHex"])
        old = b"\xfe\xff\xff\xff"
        require(raw.count(old) == 1, "fixture must contain one sequence")
        value["entries"][0]["unsignedTransactionHex"] = raw.replace(old, b"\xff\xff\xff\xff", 1).hex()
    elif kind == "lock_time":
        raw = bytes.fromhex(value["entries"][0]["unsignedTransactionHex"])
        require(len(raw) > 15, "unsigned transaction too short")
        value["entries"][0]["unsignedTransactionHex"] = (
            raw[:-4] + (int.from_bytes(raw[-4:], "little") + 1).to_bytes(4, "little")
        ).hex()
    elif kind == "request_digest":
        value["requestDigest"] = toggle(value["requestDigest"])
    else:
        raise ValueError("unknown security mutation")
    require(value != request, "mutation had no effect")
    return value


def evaluate(request, *, independently_retained_terms_digest,
             independently_retained_request_digest, observed_regtest_height):
    """Check all fields and originals BEFORE any hardware signing interaction.

    Calling this function does not authenticate the supplied digest origins
    or the observed chain height. Those are physical H8 prerequisites.
    """
    require(type(request) is dict, "request JSON object required")
    require(type(observed_regtest_height) is int, "integer height required")
    for name, digest in (("terms", independently_retained_terms_digest),
                         ("request", independently_retained_request_digest)):
        require(type(digest) is str and re.fullmatch("[0-9a-f]{64}", digest) is not None,
                "invalid independently retained " + name + " digest")
    checked = policy.validate_refund_signing_request(
        request, trusted_terms_digest=independently_retained_terms_digest,
        trusted_request_digest=independently_retained_request_digest,
        current_height=observed_regtest_height)
    review = policy.signer_review_fields(checked,
        trusted_terms_digest=independently_retained_terms_digest,
        trusted_request_digest=independently_retained_request_digest,
        current_height=observed_regtest_height)
    require(type(review) is dict and review["network"] == "regtest" and
            review["genesis"] == policy.GENESIS, "untrusted display review")
    refused = []
    for kind in MUTATION_NAMES:
        tampered = mutate(checked, kind)
        try:
            policy.validate_refund_signing_request(tampered,
                trusted_terms_digest=independently_retained_terms_digest,
                trusted_request_digest=independently_retained_request_digest,
                current_height=observed_regtest_height)
        except (ValueError, TypeError, KeyError, IndexError):
            refused.append(kind)
        else:
            raise ValueError("unsafe pre-signature policy mutation accepted: " + kind)
    require(tuple(refused) == MUTATION_NAMES, "pre-signature refusal matrix incomplete")
    return {
        "schemaVersion": 1,
        "stage": "DOGE_D8_REQUEST_SOFTWARE_PREFLIGHT_ONLY",
        "status": REPORT_STATUS,
        "canSign": False,
        "hardwareQualified": False,
        "physicalDeviceConnected": False,
        "deviceDisplayVerified": False,
        "approvedForDOGEMainnet": False,
        "chainHeightSourceAuthenticated": False,
        "independentReceiptOriginAuthenticated": False,
        "inputRequestSha256": hashlib.sha256(json.dumps(checked, sort_keys=True,
            separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest(),
        "separatelySuppliedTermsDigest": independently_retained_terms_digest,
        "separatelySuppliedRequestDigest": independently_retained_request_digest,
        "publicReviewFieldsForComparisonOnly": review,
        "policyRefusalsBeforeSigning": refused,
        "refusalChecksCompleted": len(refused),
        "missingHardwareProof": [
            "D2 hardware signer and Regtest firmware profile proven",
            "independent digest receipt origin and Regtest tip authenticated",
            "all terms displayed and verified on the physical device",
            "hardware declines mutated requests before producing a signature",
            "real device disconnect/reconnect/replay and firmware mismatch H8.1-H8.5",
        ],
        "realFundsUsed": 0,
        "broadcasts": 0,
    }


def emit_exclusive(path, output):
    raw = (json.dumps(output, sort_keys=True, ensure_ascii=True, indent=2) + "\n").encode("ascii")
    target = Path(path)
    require(not target.is_symlink(), "output symlink forbidden")
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Offline prephysical DOGE D8 request checks, NO signing")
    parser.add_argument("request_file")
    parser.add_argument("trusted_terms_digest")
    parser.add_argument("trusted_request_digest")
    parser.add_argument("regtest_height", type=int)
    parser.add_argument("new_output_file")
    args = parser.parse_args()
    result = evaluate(read_json(args.request_file),
                      independently_retained_terms_digest=args.trusted_terms_digest,
                      independently_retained_request_digest=args.trusted_request_digest,
                      observed_regtest_height=args.regtest_height)
    emit_exclusive(args.new_output_file, result)
    print(json.dumps({"status": result["status"],
                      "refusalChecksCompleted": result["refusalChecksCompleted"],
                      "canSign": False, "hardwareQualified": False}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print("DOGE_D8_PREFLIGHT_REFUSED: " + str(error), file=sys.stderr)
        raise SystemExit(1)
