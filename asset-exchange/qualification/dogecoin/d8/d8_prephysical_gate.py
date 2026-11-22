"""Strict offline D8 emulator-evidence gate. NEVER an H8 hardware certificate.

Inputs are ONLY the JSON reports generated on the same GitHub Actions runner.
No network, private keys, transactions, hardware accesses or imports from the
experimental signer. Accepting these reports is not independent attestation.
"""
import argparse
import json
from pathlib import Path
import sys

PINNED_LEDGER_SOURCE = "79f3036daec38347747fb498470bed3cfb103440"
SCREEN_FIELDS = (
    "regtest_network",
    "refund_role",
    "cltv_lock_1351",
    "nonfinal_sequence",
    "funding_outpoint",
    "contract_redeem",
)
DIGEST_NEGATIVE_CHECKS = (
    "mutated_refund_value_rejected",
    "mutated_refund_lock_rejected",
    "mutated_redeem_rejected",
    "mutated_destination_signature_invalid",
    "mutated_funding_outpoint_signature_invalid",
    "mutated_sequence_signature_invalid",
    "mutated_sighash_trailer_signature_invalid",
)
BLOCKERS = (
    "D2 exact DOGE Regtest signer profile has not been frozen",
    "Ledger Legacy DOGE application reports DOGE mainnet parameters, not an authenticated private Regtest profile",
    "The device screen does not independently display every required HTLC/refund field",
    "No physical wallet, independently verified firmware or on-device operator consent",
    "H8.1-H8.5 device reconnect/replay/mutation and mismatch exercises were not performed",
    "No native CLTV consensus verification of this new simulated signature",
    "Independent D9 audit is reserved for after site completion",
)


class EvidenceError(ValueError):
    pass


def ensure(ok, message):
    if not ok:
        raise EvidenceError(message)


def require(report, key, exact, name):
    ensure(type(report) is dict and key in report and type(report[key]) is type(exact)
           and report[key] == exact, f"{name}: {key} missing or mismatched")


def evaluate(source, public, classic, htlc):
    """Validate narrow machine-observed reports and keep physical D8 unqualified."""
    for doc in (source, public, classic, htlc):
        ensure(type(doc) is dict, "one evidence report is not an object")
    for key, value in (
        ("pinned_commit", PINNED_LEDGER_SOURCE),
        ("doge_mainnet_p2pkh_p2sh_source_defined", True),
        ("doge_regtest_full_htlc_cltv_approval_and_display_qualified", False),
        ("H8_1_to_H8_5_complete", False),
        ("D8_status", "BLOCKED"),
        ("no_real_funds", True),
        ("no_mainnet_network_use", True),
    ):
        require(source, key, value, "source")
    for key, value in (
        ("scope", "EMULATOR_BOOT_AND_NON_SIGNING_APDU_ONLY"),
        ("firmware_elf_built", True),
        ("speculos_doge_app_booted", True),
        ("emulated_screen_captured", True),
        ("real_physical_screen_tested", False),
        ("hardware_D8_qualified", False),
        ("non_signing_apdu_identity_passed", True),
    ):
        require(public, key, value, "emulator_boot")
    apdu = public.get("apdu_report")
    ensure(type(apdu) is dict, "APDU report missing")
    require(apdu, "scope", "NON_SIGNING_APDU_EMULATOR_IDENTITY_ONLY", "apdu")
    require(apdu, "D8_hardware_status", "BLOCKED", "apdu")
    require(apdu, "doge_regtest_htlc_signing_verified", False, "apdu")
    require(apdu, "real_device_display_verified", False, "apdu")
    require(apdu, "funds_used", 0, "apdu")
    require(apdu, "broadcast_count", 0, "apdu")
    coin = apdu.get("coin")
    ensure(type(coin) is dict, "coin metadata missing")
    for key, value in (
        ("coin", "DOGE"), ("network_in_app", "dogecoin-mainnet"),
        ("p2pkh_prefix", 30), ("p2sh_prefix", 22),
    ):
        require(coin, key, value, "coin")
    pub_probe = apdu.get("public_wallet_probe")
    ensure(type(pub_probe) is dict, "public key report missing")
    require(pub_probe, "pubkey_matches_address", True, "public_wallet_probe")
    require(pub_probe, "ownership_verified", False, "public_wallet_probe")
    for name, document, scope, successful_key, blocked_key, money_key in (
        ("classic", classic, "SYNTHETIC_LEDGER_DOGE_MAINNET_P2PKH_EMULATOR_ONLY",
         "signature_on_synthetic_transaction_verified", "D8", "real_DOGE_used"),
        ("htlc", htlc, "SYNTHETIC_HTLC_REFUND_DIGEST_SIGNED_IN_MAINNET_DOGE_APP_ONLY",
         "signature_on_synthetic_htlc_refund_digest_verified", "D8_status", "real_doge_used"),
    ):
        for key, value in (
            ("scope", scope), (successful_key, True), (blocked_key, "BLOCKED"),
            (money_key, 0), ("broadcasts", 0),
        ):
            require(document, key, value, name)
        screen = document.get("simulated_screen_review" if name == "classic" else "emulator_screen")
        ensure(type(screen) is dict, name + ": simulated screen report missing")
        for key in (
            "emulator_approval_automated", "screen_amount_observed",
            "screen_exact_destination_verified", "screen_fee_observed",
        ):
            require(screen, key, True, name + " simulated screen")
    require(classic, "mutated_transaction_signature_rejected", True, "classic")
    for key in DIGEST_NEGATIVE_CHECKS:
        require(htlc, key, True, "htlc")
    for key, val in (
        ("redeem_matches_gpubnb_d2_shape", True),
        ("contract_lock_height", 1351),
        ("contract_sequence", 4294967294),
        ("ledger_app_network", "DOGE_MAINNET_PARAMETERS"),
        ("independent_on_device_htlc_terms_displayed", False),
        ("dogecoin_regtest_network_authenticated", False),
        ("native_consensus_cltv_verified_for_this_signature", False),
        ("hardware_device_present", False),
    ):
        require(htlc, key, val, "htlc")
    display = htlc.get("screen_htlc_terms_observed")
    missing = htlc.get("missing_htlc_fields")
    ensure(type(display) is dict and set(display) == set(SCREEN_FIELDS),
           "exact HTLC term inventory required")
    ensure(type(missing) is list and all(type(v) is str for v in missing),
           "missing HTLC fields must be strings")
    ensure(all(type(display[key]) is bool for key in SCREEN_FIELDS),
           "HTLC screen observations must be booleans")
    found_missing = [field for field in SCREEN_FIELDS if not display[field]]
    ensure(found_missing and missing == found_missing, "inconsistent or falsely complete on-device review")
    return {
        "schemaVersion": 1,
        "stage": "BEFORE_PHYSICAL_D8",
        "classification": "EMULATOR_DIAGNOSTIC_PASS_HARDWARE_BLOCKED",
        "signaturesReportedByEmulator": 2,
        "publicIdentityAndDigestMutationChecksPassed": True,
        "incompleteTerms": found_missing,
        "physicalDevicePresent": False,
        "physicalQualificationPassed": False,
        "deviceApprovedToSignGPUbnbContracts": False,
        "dogecoinRegtestProfileQualified": False,
        "automaticMainnetActivationAllowed": False,
        "broadcasts": 0,
        "fundsUsed": 0,
        "h8TestCasesCompleted": [],
        "h8BlockingReasons": list(BLOCKERS),
    }


def read_report(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024:
        raise EvidenceError("expected regular bounded JSON evidence file")
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    ap = argparse.ArgumentParser(description="Bounded D8 prephysical experiment gate")
    ap.add_argument("source")
    ap.add_argument("emulator")
    ap.add_argument("classic")
    ap.add_argument("htlc")
    ap.add_argument("result")
    args = ap.parse_args()
    report = evaluate(*(read_report(path) for path in
                        (args.source, args.emulator, args.classic, args.htlc)))
    Path(args.result).write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print("PREPHYSICAL_GATE_REFUSED: " + str(error), file=sys.stderr)
        raise SystemExit(1)
