"""Ephemeral REGTEST qualification signer/codec; never a wallet or production API.

OpenSSL supplies secp256k1 key generation and ECDSA. Only bounded DER encoding
and legacy SIGHASH_ALL transaction serialization are implemented here.
"""
import hashlib
import os
from pathlib import Path
import struct
import subprocess

ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
MAX_MONEY = 10_000_000_000 * 100_000_000


def require(ok, message):
    if not ok:
        raise ValueError(message)


def hash256(raw):
    return hashlib.sha256(hashlib.sha256(raw).digest()).digest()


def compact(n):
    require(type(n) is int and 0 <= n <= 10000, 'bounded compact length required')
    return bytes([n]) if n < 253 else b'\xfd' + struct.pack('<H', n)


def push(raw):
    require(type(raw) is bytes and len(raw) <= 520, 'bounded script push required')
    if len(raw) < 76:
        return bytes([len(raw)]) + raw
    if len(raw) <= 255:
        return b'\x4c' + bytes([len(raw)]) + raw
    return b'\x4d' + struct.pack('<H', len(raw)) + raw


def transaction(txid, vout, script, outputs, lock=0, sequence=0xfffffffe, *, max_outputs=8):
    require(type(txid) is str and len(txid) == 64 and all(c in '0123456789abcdef' for c in txid), 'canonical outpoint hash required')
    for value in (vout, lock, sequence):
        require(type(value) is int and 0 <= value <= 0xffffffff, 'uint32 required')
    require(type(script) is bytes and len(script) <= 1650, 'bounded scriptSig required')
    # The recovery profile keeps the default eight-output bound. Only the
    # private native pressure fixture opts into a larger, still finite bound.
    require(type(max_outputs) is int and 1 <= max_outputs <= 1601, 'bounded output limit required')
    require(type(outputs) is list and 1 <= len(outputs) <= max_outputs, 'bounded outputs required')
    raw = struct.pack('<I', 1) + b'\x01' + bytes.fromhex(txid)[::-1] + struct.pack('<I', vout)
    raw += compact(len(script)) + script + struct.pack('<I', sequence) + compact(len(outputs))
    total = 0
    for amount, output in outputs:
        require(type(amount) is int and 0 <= amount <= MAX_MONEY, 'bounded integer amount required')
        require(type(output) is bytes and len(output) <= 520, 'bounded output script required')
        total += amount
        require(total <= MAX_MONEY, 'aggregate amount bound exceeded')
        raw += struct.pack('<Q', amount) + compact(len(output)) + output
    return raw + struct.pack('<I', lock)


def sighash(txid, vout, script_code, outputs, lock=0, sequence=0xfffffffe, *, max_outputs=8):
    # Single-input, legacy SIGHASH_ALL only. Spent amount is NOT committed.
    return hash256(transaction(txid, vout, script_code, outputs, lock, sequence, max_outputs=max_outputs) + struct.pack('<I', 1))


def decode_der(sig):
    require(type(sig) is bytes and 8 <= len(sig) <= 72 and sig[:1] == b'\x30' and sig[1] == len(sig)-2, 'strict DER sequence required')
    pos, values = 2, []
    for _ in range(2):
        require(pos+2 <= len(sig) and sig[pos] == 2, 'DER integer required')
        n = sig[pos+1]; pos += 2
        require(1 <= n <= 33 and pos+n <= len(sig), 'bounded DER integer required')
        raw = sig[pos:pos+n]; pos += n
        require(not raw[0] & 0x80 and not (len(raw)>1 and raw[0]==0 and not raw[1]&0x80), 'canonical positive DER integer required')
        value = int.from_bytes(raw, 'big')
        require(0 < value < ORDER, 'ECDSA scalar outside curve order')
        values.append(value)
    require(pos == len(sig), 'DER trailing bytes')
    return tuple(values)


def encode_der(r, s):
    def integer(v):
        require(type(v) is int and 0 < v < ORDER, 'ECDSA scalar outside curve order')
        raw = v.to_bytes((v.bit_length()+7)//8, 'big')
        if raw[0] & 0x80: raw = b'\0' + raw
        return b'\x02' + bytes([len(raw)]) + raw
    raw = integer(r) + integer(s)
    return b'\x30' + bytes([len(raw)]) + raw


class EphemeralSigner:
    def __init__(self, directory, label):
        require(label in ('miner', 'claim', 'refund'), 'fixed test signer role required')
        self.path = Path(directory) / (label + '.pem')
        require(not self.path.exists(), 'fresh test key required')
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        self._run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:secp256k1', '-out', str(self.path)])
        pub = self._run(['ec', '-in', str(self.path), '-pubout', '-conv_form', 'compressed', '-outform', 'DER'])
        prefix = bytes.fromhex('3036301006072a8648ce3d020106052b8104000a032200')
        require(pub.startswith(prefix) and len(pub) == len(prefix)+33, 'exact secp256k1 SPKI required')
        self.public = pub[len(prefix):]

    def _run(self, args, data=None):
        result = subprocess.run(['/usr/bin/openssl', *args], input=data, capture_output=True, timeout=10,
                                env={'PATH':'/usr/bin:/bin', 'LANG':'C.UTF-8'})
        require(result.returncode == 0, 'OpenSSL test primitive failed')
        return result.stdout

    def sign(self, digest):
        require(type(digest) is bytes and len(digest)==32, '32-byte prehashed digest required')
        sig = self._run(['pkeyutl', '-sign', '-inkey', str(self.path), '-pkeyopt', 'digest:sha256'], digest)
        r, s = decode_der(sig)
        return encode_der(r, min(s, ORDER-s)) + b'\x01'

    def destroy(self):
        # Unlink is not a physical secure-erasure claim. Runner and data are disposable.
        self.path.unlink(missing_ok=True)
