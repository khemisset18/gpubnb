"""Offline synthetic legacy DOGE transaction SIGNING experiment in Ledger Speculos.

Only isolated Speculos default test seed, fixed fake UTXO, no wallet/account
integration, no Dogecoin node, no RPC, no real chain funding or broadcast.
This is NOT a DOGE Regtest HTLC signer or H8 physical verification.
"""
from concurrent.futures import Future
import hashlib
import json
import sys
import threading
import time
import urllib.request

import ledger_emulator_probe as identity

API = "http://127.0.0.1:5000"
BIP44_DOGE_PATH = bytes.fromhex("058000002c80000003800000000000000000000000")
FUNDING_KOINU = 500_000_000
PAYMENT_KOINU = 499_000_000
FEE_KOINU = FUNDING_KOINU - PAYMENT_KOINU
DUMMY_PREVOUT = b"\x11" * 32 + b"\x00" * 4
DUMMY_DESTINATION_HASH = b"\x42" * 20
SEQUENCE = b"\xff" * 4
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def sha256d(value):
    return hashlib.sha256(hashlib.sha256(value).digest()).digest()


def hash160(pub):
    return hashlib.new("ripemd160", hashlib.sha256(pub).digest()).digest()


def add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        m = (3 * a[0] * a[0] * pow(2 * a[1], -1, P)) % P
    else:
        m = ((b[1] - a[1]) * pow((b[0] - a[0]) % P, -1, P)) % P
    x = (m * m - a[0] - b[0]) % P
    return (x, (m * (a[0] - x) - a[1]) % P)


def multiply(value, point):
    acc = None
    while value:
        if value & 1:
            acc = add(acc, point)
        point = add(point, point)
        value >>= 1
    return acc


def parse_der_signature(raw):
    if len(raw) < 8 or raw[0] != 0x30 or raw[1] != len(raw) - 2:
        raise ValueError("noncanonical DER signature")
    at = 2
    ints = []
    for _ in range(2):
        if raw[at] != 2:
            raise ValueError("DER integer missing")
        size = raw[at + 1]
        segment = raw[at + 2:at + 2 + size]
        if size == 0 or len(segment) != size or (segment[0] & 0x80):
            raise ValueError("DER bad integer")
        if size > 1 and segment[0] == 0 and not segment[1] & 0x80:
            raise ValueError("DER nonminimal integer")
        ints.append(int.from_bytes(segment, "big"))
        at += 2 + size
    if at != len(raw) or any(not 1 <= x < N for x in ints):
        raise ValueError("DER trailing bytes or out-of-range integer")
    return ints


def check_signature(sig, digest, uncompressed_pubkey):
    if len(digest) != 32 or len(uncompressed_pubkey) != 65 or uncompressed_pubkey[0] != 4:
        return False
    q = (int.from_bytes(uncompressed_pubkey[1:33], "big"),
         int.from_bytes(uncompressed_pubkey[33:], "big"))
    if not 0 <= q[0] < P or not 0 <= q[1] < P or (q[1] * q[1] - q[0]**3 - 7) % P:
        return False
    r, s = parse_der_signature(sig)
    inverse = pow(s, -1, N)
    z = int.from_bytes(digest, "big")
    point = add(multiply(z * inverse % N, G), multiply(r * inverse % N, q))
    return point is not None and point[0] % N == r


def p2pkh_script(pubkey_hash):
    if len(pubkey_hash) != 20:
        raise ValueError("invalid 20-byte synthetic hash")
    return bytes.fromhex("76a914") + pubkey_hash + bytes.fromhex("88ac")


def output(amount, script):
    if not 1_000_000 <= amount <= FUNDING_KOINU or len(script) != 25:
        raise ValueError("non-fixed synthetic amount/script")
    return amount.to_bytes(8, "little") + bytes([len(script)]) + script


def make_apdu(ins, p1, p2, payload):
    if ins not in (0x42, 0x44, 0x4a, 0x48) or len(payload) > 255:
        raise ValueError("signing APDU out of allowed synthetic scope")
    return (bytes([0xe0, ins, p1, p2, len(payload)]) + payload).hex()


def send(ins, p1, p2, payload):
    apdu = make_apdu(ins, p1, p2, payload)
    req = urllib.request.Request(
        API + "/apdu", data=json.dumps({"data": apdu}).encode("ascii"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=75) as response:
        data = json.loads(response.read(4096))["data"]
    return identity.parse_apdu(data)


def send_ok(ins, p1, p2, payload):
    data, sw = send(ins, p1, p2, payload)
    if sw != "9000":
        raise ValueError(f"Ledger APDU {ins:02x} rejected with {sw}")
    return data


def current_screen():
    req = urllib.request.Request(API + "/events?currentscreenonly=true")
    with urllib.request.urlopen(req, timeout=3) as response:
        obj = json.loads(response.read(4096))
    events = obj.get("events", [])
    if not isinstance(events, list):
        raise ValueError("Speculos events not a list")
    return [str(event.get("text", ""))[:80] for event in events if isinstance(event, dict)
            and isinstance(event.get("text"), str)][:24]


def click(which):
    if which not in ("right", "both"):
        raise ValueError("unsafe emulator button")
    req = urllib.request.Request(API + "/button/" + which,
                                 data=b'{"action":"press-and-release"}',
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=3) as response:
        response.read(512)


def synth_funding(signer_script):
    prev = bytes.fromhex("01000000") + b"\x01" + DUMMY_PREVOUT + b"\x00" + SEQUENCE
    result = prev + b"\x01" + output(FUNDING_KOINU, signer_script) + bytes(4)
    return result


def make_digest(funding_transaction, signer_script, paid_outputs):
    prevtxid_le = sha256d(funding_transaction)
    # Serialize exactly one legacy input, one output, nLockTime=0 and SIGHASH_ALL.
    unsigned = (bytes.fromhex("01000000") + b"\x01" + prevtxid_le + bytes(4) +
                bytes([len(signer_script)]) + signer_script + SEQUENCE +
                paid_outputs + bytes(4))
    return sha256d(unsigned + bytes.fromhex("01000000"))


def get_trusted_input(signer_script):
    funding = synth_funding(signer_script)
    # Mirror public btchip-python v1 getTrustedInput streaming; no chain access.
    send_ok(0x42, 0, 0, bytes(4) + funding[:5])
    send_ok(0x42, 0x80, 0, DUMMY_PREVOUT + b"\x00")
    send_ok(0x42, 0x80, 0, SEQUENCE)
    send_ok(0x42, 0x80, 0, b"\x01")
    send_ok(0x42, 0x80, 0, FUNDING_KOINU.to_bytes(8, "little") + b"\x19")
    send_ok(0x42, 0x80, 0, signer_script)
    trusted = send_ok(0x42, 0x80, 0, bytes(4))
    if not 48 <= len(trusted) <= 128:
        raise ValueError("invalid trusted input size")
    if sha256d(funding) not in trusted:
        raise ValueError("trusted input cannot be linked to exact synthetic funding transaction")
    return funding, trusted


def review_synthetic_finalize(paid_outputs):
    """Approval is permitted ONLY for a fixed synthetic output and after observing
    its amount and fee on the simulator, never for real funds or an unknown UI."""
    result = {}
    def request():
        try:
            result["data"] = send_ok(0x4a, 0x80, 0, paid_outputs)
        except Exception as error:
            result["error"] = str(error)
    thread = threading.Thread(target=request, daemon=True)
    thread.start()
    history = []
    saw_amount = False
    saw_address = False
    saw_fee = False
    approved_output = False
    approved_fee = False
    deadline = time.monotonic() + 50
    last_screen = None
    while thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.35)
        screen = current_screen()
        text = " ".join(screen).strip()
        if not text or text == last_screen:
            continue
        last_screen = text
        history.append(text[:250])
        if len(history) > 70:
            raise ValueError("too many unexpected emulator screens")
        lower = text.lower()
        if "amount" in lower or "4.99" in text:
            saw_amount |= "4.99" in text
        if "address" in lower:
            saw_address = True
        if "fees" in lower or "0.01" in text:
            saw_fee |= "0.01" in text
        if "reject" in lower and "accept" not in lower:
            raise ValueError("emulator presented rejection, no approval performed")
        if "accept" in lower and ("and send" in lower or "send" in lower):
            if not (saw_amount and saw_address and saw_fee and approved_output):
                raise ValueError("fee acceptance blocked: missing synthetic review terms")
            click("both")
            approved_fee = True
        elif "accept" in lower:
            if not (saw_amount and saw_address):
                raise ValueError("output acceptance blocked: missing synthetic review terms")
            click("both")
            approved_output = True
        else:
            click("right")
    if thread.is_alive():
        raise ValueError("synthetic approval timed out; screen path not qualified: " + str(history[-8:]))
    if "error" in result:
        raise ValueError(result["error"] + " screen_history=" + str(history[-8:]))
    if not (approved_output and approved_fee):
        raise ValueError("emulator transaction returned without complete reviewed approval")
    return {"emulator_approval_automated": True,
            "screen_amount_observed": saw_amount, "screen_address_title_observed": saw_address,
            "screen_fee_observed": saw_fee, "simulated_screen_sequence": history[-25:]}


def probe():
    # Refuse any signing without a verified transaction session.
    premature, sw = send(0x48, 0, 0, BIP44_DOGE_PATH + b"\x00" + bytes(4) + b"\x01")
    if sw != "6985":
        raise ValueError("unexpected signing outside transaction state: " + sw)
    public, sw = identity.send_apdu(identity.DOGE_PUBKEY_APDU)
    if sw != "9000":
        raise ValueError("public key retrieval failed: " + sw)
    signer_pub = public[1:66]
    signer_compressed = bytes([2 + (signer_pub[-1] & 1)]) + signer_pub[1:33]
    signer_script = p2pkh_script(hash160(signer_compressed))
    funding, trusted = get_trusted_input(signer_script)
    # Fixed one-input, one-output, simple P2PKH transaction, NO HTLC.
    paid_outputs = b"\x01" + output(PAYMENT_KOINU, p2pkh_script(DUMMY_DESTINATION_HASH))
    send_ok(0x44, 0, 0, bytes.fromhex("01000000") + b"\x01")
    send_ok(0x44, 0x80, 0, b"\x01" + bytes([len(trusted)]) + trusted +
            bytes([len(signer_script)]) + signer_script)
    send_ok(0x44, 0x80, 0, SEQUENCE)
    review = review_synthetic_finalize(paid_outputs)
    signature_raw = send_ok(0x48, 0, 0, BIP44_DOGE_PATH + b"\x00" + bytes(4) + b"\x01")
    if not 65 <= len(signature_raw) <= 80 or signature_raw[-1] != 1:
        raise ValueError("invalid native signing response")
    # Historical Ledger btchip changes the first marker byte from 0x31 to DER 0x30.
    normalized = bytes([0x30]) + signature_raw[1:-1]
    digest = make_digest(funding, signer_script, paid_outputs)
    if not check_signature(normalized, digest, signer_pub):
        raise ValueError("actual signature not cryptographically valid for synthetic DOGE transaction")
    mutated = b"\x01" + output(PAYMENT_KOINU - 1, p2pkh_script(DUMMY_DESTINATION_HASH))
    if check_signature(normalized, make_digest(funding, signer_script, mutated), signer_pub):
        raise ValueError("post-signature output mutation was accepted")
    return {
        "scope": "SYNTHETIC_LEDGER_DOGE_MAINNET_P2PKH_EMULATOR_ONLY",
        "app": "Ledger Legacy DOGE",
        "funding_is_fictional": True,
        "simulated_screen_review": review,
        "real_transaction_signed_and_broadcast": False,
        "signature_on_synthetic_transaction_verified": True,
        "mutated_transaction_signature_rejected": True,
        "signature_sha256": hashlib.sha256(normalized).hexdigest(),
        "signed_digest_sha256": hashlib.sha256(digest).hexdigest(),
        "funding_txid": sha256d(funding)[::-1].hex(),
        "DOGE_regtest_HTLC_CLTV_supported": False,
        "H8_1_to_H8_5_complete": False,
        "D8": "BLOCKED",
        "real_DOGE_used": 0,
        "broadcasts": 0,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(probe(), ensure_ascii=True, sort_keys=True))
    except Exception as error:
        print(json.dumps({"status": "NOT_QUALIFIED", "stage": "synthetic_ledger_transaction",
                          "reason": str(error)[:1000], "D8": "BLOCKED",
                          "real_DOGE_used": 0, "broadcasts": 0}, sort_keys=True))
        sys.exit(1)
