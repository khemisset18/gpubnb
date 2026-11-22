"""GPUbnb D2-style HTLC REFUND script experiment on synthetic Ledger DOGE firmware.

A P2SH funding output exists only as a local byte fixture; the hardware emulator
runs the upstream MAINNET DOGE app. A successful ECDSA signature does NOT
qualify DOGE Regtest, HTLC script execution, terms display, actual D8 or D9.
"""
import hashlib
import json
import sys

import ledger_tx_sign_probe as tx
import ledger_emulator_probe as identity

LOCK_HEIGHT = 1351
SEQUENCE = 0xFFFFFFFE
# Existing GPUbnb D2 fixture commit/preimage and claim pubkey, with refund
# pubkey replaced by the disposable Speculos-derived DOGE BIP44 public key.
# Fixed matching prefix from asset-exchange/qualification/dogecoin/d2/fixtures/htlc_codec_v1.json
D2_HTLC_PREFIX = bytes.fromhex(
    "6382012088a8203e9410adf673df2f471ff0936fbcf18af1b44fde695915e2b70c27f4eb6a54eb88"
    "21038479a0fa998cd35259a2ef0a7a5c68662c1474f88ccb6d08a7677bbec7f22041"
    "ac67024705b17521")
TAIL = bytes.fromhex("ac68")
EXPECTED_LOCK_BYTES = bytes.fromhex("024705b175")


def synthetic_refund_redeem(refund_pub):
    if not isinstance(refund_pub, bytes) or len(refund_pub) != 33 or refund_pub[0] not in (2, 3):
        raise ValueError("compressed public key required")
    redeem = D2_HTLC_PREFIX + refund_pub + TAIL
    if not (redeem.startswith(bytes.fromhex("6382012088a820")) and
            EXPECTED_LOCK_BYTES in redeem and redeem.endswith(TAIL) and
            100 <= len(redeem) <= 150):
        raise ValueError("non-canonical D2 refund template")
    return redeem


def contract_script_pubkey(redeem):
    h = tx.hash160(redeem)
    return bytes.fromhex("a914") + h + bytes.fromhex("87")


def spend_digest(funding, redeem, paid_outputs, *, lock=LOCK_HEIGHT, sequence=SEQUENCE,
                 sighash_type=1, negative_only=False):
    """Model legacy transaction digest. Wrong sequence/type is permitted ONLY
    when explicitly deriving a negative verification digest, never to sign."""
    if not 100 <= len(redeem) <= 150 or not 0 < lock < 500_000_000:
        raise ValueError("outside synthetic HTLC refund profile")
    if type(sequence) is not int or not 0 <= sequence <= 0xffffffff:
        raise ValueError("invalid sequence")
    if type(sighash_type) is not int or sighash_type not in (1, 2):
        raise ValueError("invalid experimental sighash")
    if (sequence != SEQUENCE or sighash_type != 1) and negative_only is not True:
        raise ValueError("wrong sequence or sighash cannot be a positive refund")
    prevhash = tx.sha256d(funding)
    preimage = (bytes.fromhex("01000000") + b"\x01" + prevhash + bytes(4) +
                bytes([len(redeem)]) + redeem + sequence.to_bytes(4, "little") +
                paid_outputs + lock.to_bytes(4, "little"))
    # When sighash_type=2 this is only a changed 4-byte hash trailer to prove
    # signature separation, NOT a SIGHASH_NONE consensus digest/approval path.
    return tx.sha256d(preimage + sighash_type.to_bytes(4, "little"))


def synthetic_scriptsig(sig, redeem):
    if not 9 <= len(sig) <= 73 or not sig.endswith(b"\x01") or not 75 < len(redeem) <= 252:
        raise ValueError("invalid refund signature/redeemScript length")
    script = bytes([len(sig)]) + sig + b"\x00" + b"\x4c" + bytes([len(redeem)]) + redeem
    if script[-len(redeem):] != redeem or len(script) > 520:
        raise ValueError("invalid canonical refund scriptSig")
    return script


def probe():
    public, sw = identity.send_apdu(identity.DOGE_PUBKEY_APDU)
    if sw != "9000":
        raise ValueError("offline DOGE public key unavailable")
    pub = public[1:66]
    compressed = bytes([2 + (pub[-1] & 1)]) + pub[1:33]
    redeem = synthetic_refund_redeem(compressed)
    p2sh = contract_script_pubkey(redeem)
    print("DOGE_HTLC_DIAG: build synthetic P2SH funding from D2 template", file=sys.stderr, flush=True)
    funding, trusted = tx.get_trusted_input(p2sh)
    outputs = b"\x01" + tx.output(tx.PAYMENT_KOINU, tx.p2pkh_script(tx.DUMMY_DESTINATION_HASH))
    sequence = SEQUENCE.to_bytes(4, "little")
    sign_payload = tx.BIP44_DOGE_PATH + b"\x00" + LOCK_HEIGHT.to_bytes(4, "big") + b"\x01"
    print("DOGE_HTLC_DIAG: streaming HTLC redeemScript with nonfinal sequence", file=sys.stderr, flush=True)
    tx.send_ok(0x44, 0, 0, bytes.fromhex("01000000") + b"\x01")
    tx.send_ok(0x44, 0x80, 0, b"\x01" + bytes([len(trusted)]) + trusted + bytes([len(redeem)]))
    tx.send_ok(0x44, 0x80, 0, redeem + sequence)
    print("DOGE_HTLC_DIAG: awaiting on-screen synthetic transaction review", file=sys.stderr, flush=True)
    review = tx.review_synthetic_finalize(outputs)
    print("DOGE_HTLC_DIAG: requesting simulated refund signature", file=sys.stderr, flush=True)
    result = tx.send_ok(0x48, 0, 0, sign_payload)
    if not 65 <= len(result) <= 80 or result[-1] != 1:
        raise ValueError("invalid simulated refund signature response")
    der = bytes([0x30]) + result[1:-1]
    digest = spend_digest(funding, redeem, outputs)
    if not tx.check_signature(der, digest, pub):
        raise ValueError("Ledger signature not valid for synthetic HTLC refund preimage")
    mutated_value = b"\x01" + tx.output(tx.PAYMENT_KOINU - 1, tx.p2pkh_script(tx.DUMMY_DESTINATION_HASH))
    if tx.check_signature(der, spend_digest(funding, redeem, mutated_value), pub):
        raise ValueError("mutated refund output signature unexpectedly valid")
    mutated_lock = LOCK_HEIGHT + 1
    if tx.check_signature(der, spend_digest(funding, redeem, outputs, lock=mutated_lock), pub):
        raise ValueError("mutated locktime signature unexpectedly valid")
    mutated_redeem = redeem[:-35] + bytes([redeem[-35] ^ 1]) + redeem[-34:]
    if tx.check_signature(der, spend_digest(funding, mutated_redeem, outputs), pub):
        raise ValueError("mutated contract redeemScript signature unexpectedly valid")
    altered_destination = bytes([0x43]) + tx.DUMMY_DESTINATION_HASH[1:]
    different_outputs = b"\x01" + tx.output(tx.PAYMENT_KOINU, tx.p2pkh_script(altered_destination))
    if tx.check_signature(der, spend_digest(funding, redeem, different_outputs), pub):
        raise ValueError("mutated destination signature unexpectedly valid")
    different_funding = funding[:7] + bytes([funding[7] ^ 1]) + funding[8:]
    if tx.check_signature(der, spend_digest(different_funding, redeem, outputs), pub):
        raise ValueError("mutated funding outpoint signature unexpectedly valid")
    if tx.check_signature(der, spend_digest(funding, redeem, outputs,
            sequence=SEQUENCE-1, negative_only=True), pub):
        raise ValueError("mutated sequence signature unexpectedly valid")
    if tx.check_signature(der, spend_digest(funding, redeem, outputs,
            sighash_type=2, negative_only=True), pub):
        raise ValueError("mutated sighash trailer signature unexpectedly valid")
    scriptsig = synthetic_scriptsig(der + b"\x01", redeem)
    visible = " ".join(review["simulated_screen_sequence"]).lower()
    terms = {
        "regtest_network": "regtest" in visible,
        "refund_role": "refund" in visible,
        "cltv_lock_1351": "1351" in visible or "cltv" in visible,
        "nonfinal_sequence": str(SEQUENCE) in visible,
        "funding_outpoint": tx.sha256d(funding)[::-1].hex() in visible,
        "contract_redeem": redeem.hex() in visible,
    }
    # Observe the actual UI: normal Ledger DOGE mainnet signing screen
    # cannot supply authenticated GPUbnb D2/H8 contract terms.
    assert not all(terms.values()), "Unexpected complete H8 data; audit UI manually"
    # Mainnet DOGE firmware UI does not prove network/genesis, refund role,
    # CLTV height, sequence, commitment, claim/refund keys or funding outpoint.
    return {
        "scope": "SYNTHETIC_HTLC_REFUND_DIGEST_SIGNED_IN_MAINNET_DOGE_APP_ONLY",
        "redeem_matches_gpubnb_d2_shape": True,
        "contract_lock_height": LOCK_HEIGHT,
        "contract_sequence": SEQUENCE,
        "contract_redeem_sha256": hashlib.sha256(redeem).hexdigest(),
        "contract_p2sh_sha256": hashlib.sha256(p2sh).hexdigest(),
        "synthetic_refund_scriptSig_sha256": hashlib.sha256(scriptsig).hexdigest(),
        "signature_on_synthetic_htlc_refund_digest_verified": True,
        "mutated_refund_value_rejected": True,
        "mutated_refund_lock_rejected": True,
        "mutated_redeem_rejected": True,
        "mutated_destination_signature_invalid": True,
        "mutated_funding_outpoint_signature_invalid": True,
        "mutated_sequence_signature_invalid": True,
        "mutated_sighash_trailer_signature_invalid": True,
        "emulator_screen": review,
        "screen_htlc_terms_observed": terms,
        "missing_htlc_fields": [field for field, seen in terms.items() if not seen],
        "ledger_app_network": "DOGE_MAINNET_PARAMETERS",
        "independent_on_device_htlc_terms_displayed": False,
        "dogecoin_regtest_network_authenticated": False,
        "native_consensus_cltv_verified_for_this_signature": False,
        "hardware_device_present": False,
        "D8_status": "BLOCKED",
        "real_doge_used": 0,
        "broadcasts": 0,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(probe(), sort_keys=True))
    except Exception as error:
        print(json.dumps({"status": "NOT_QUALIFIED", "stage": "synthetic_htlc_refund",
                          "reason": str(error)[:900], "D8_status": "BLOCKED",
                          "real_doge_used": 0, "broadcasts": 0}, sort_keys=True))
        sys.exit(1)
