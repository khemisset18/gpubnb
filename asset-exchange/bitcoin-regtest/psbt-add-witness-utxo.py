#!/usr/bin/env python3
import argparse
import base64
import sys

MAGIC = b"psbt\xff"
PSBT_IN_WITNESS_UTXO = 0x01
MAX_MONEY_SATS = 2_100_000_000_000_000

def read_compact(data, pos):
    if pos >= len(data):
        raise ValueError("unexpected end of PSBT")
    first = data[pos]
    pos += 1
    if first < 0xFD:
        return first, pos
    if first == 0xFD:
        if pos + 2 > len(data): raise ValueError("truncated compact size")
        n = int.from_bytes(data[pos:pos+2], "little")
        if n < 0xFD: raise ValueError("non-canonical compact size")
        return n, pos + 2
    if first == 0xFE:
        if pos + 4 > len(data): raise ValueError("truncated compact size")
        n = int.from_bytes(data[pos:pos+4], "little")
        if n <= 0xFFFF: raise ValueError("non-canonical compact size")
        return n, pos + 4
    if pos + 8 > len(data): raise ValueError("truncated compact size")
    n = int.from_bytes(data[pos:pos+8], "little")
    if n <= 0xFFFFFFFF: raise ValueError("non-canonical compact size")
    return n, pos + 8

def write_compact(n):
    if n < 0xFD: return bytes([n])
    if n <= 0xFFFF: return b"\xfd" + n.to_bytes(2, "little")
    if n <= 0xFFFFFFFF: return b"\xfe" + n.to_bytes(4, "little")
    return b"\xff" + n.to_bytes(8, "little")

def skip_map(data, pos):
    while True:
        key_len, after_len = read_compact(data, pos)
        if key_len == 0:
            if data[pos:after_len] != b"\x00":
                raise ValueError("non-canonical map separator")
            return after_len
        pos = after_len + key_len
        if pos > len(data): raise ValueError("truncated key")
        value_len, pos = read_compact(data, pos)
        pos += value_len
        if pos > len(data): raise ValueError("truncated value")

def input_separator(data, pos):
    seen = set()
    while True:
        entry_start = pos
        key_len, after_len = read_compact(data, pos)
        if key_len == 0:
            if data[pos:after_len] != b"\x00":
                raise ValueError("non-canonical input separator")
            return entry_start, seen
        pos = after_len
        if pos + key_len > len(data): raise ValueError("truncated input key")
        key = data[pos:pos+key_len]
        pos += key_len
        if key in seen: raise ValueError("duplicate input key")
        seen.add(key)
        value_len, pos = read_compact(data, pos)
        pos += value_len
        if pos > len(data): raise ValueError("truncated input value")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("psbt_base64")
    p.add_argument("amount_sats", type=int)
    p.add_argument("script_pubkey_hex")
    args = p.parse_args()

    if not 0 <= args.amount_sats <= MAX_MONEY_SATS:
        raise SystemExit("amount_sats outside Bitcoin money range")
    try:
        script = bytes.fromhex(args.script_pubkey_hex)
    except ValueError:
        raise SystemExit("scriptPubKey is not hex")
    if not 1 <= len(script) <= 10_000:
        raise SystemExit("invalid scriptPubKey length")

    try:
        data = base64.b64decode(args.psbt_base64, validate=True)
    except Exception as exc:
        raise SystemExit(f"invalid base64 PSBT: {exc}")
    if not data.startswith(MAGIC):
        raise SystemExit("invalid PSBT magic")

    first_input = skip_map(data, len(MAGIC))
    separator, seen = input_separator(data, first_input)
    key = bytes([PSBT_IN_WITNESS_UTXO])
    if key in seen:
        raise SystemExit("PSBT input already contains witness_utxo")

    # CTxOut = int64 amount (little endian) + serialized script vector.
    value = args.amount_sats.to_bytes(8, "little", signed=True) + write_compact(len(script)) + script
    entry = write_compact(1) + key + write_compact(len(value)) + value
    updated = data[:separator] + entry + data[separator:]
    sys.stdout.write(base64.b64encode(updated).decode("ascii"))

if __name__ == "__main__":
    main()
