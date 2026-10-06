#!/usr/bin/env python3
import argparse
import base64
import hashlib
import sys

MAGIC = b"psbt\xff"
PSBT_IN_SHA256 = 0x0B

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
                raise ValueError("non-canonical PSBT map separator")
            return after_len
        pos = after_len
        if pos + key_len > len(data): raise ValueError("truncated PSBT key")
        pos += key_len
        value_len, pos = read_compact(data, pos)
        if pos + value_len > len(data): raise ValueError("truncated PSBT value")
        pos += value_len

def first_input_separator(data, pos):
    seen = set()
    while True:
        entry_start = pos
        key_len, after_len = read_compact(data, pos)
        if key_len == 0:
            if data[pos:after_len] != b"\x00":
                raise ValueError("non-canonical PSBT input separator")
            return entry_start, seen
        pos = after_len
        if pos + key_len > len(data): raise ValueError("truncated input key")
        key = data[pos:pos+key_len]
        pos += key_len
        if key in seen: raise ValueError("duplicate PSBT input key")
        seen.add(key)
        value_len, pos = read_compact(data, pos)
        if pos + value_len > len(data): raise ValueError("truncated input value")
        pos += value_len

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("psbt_base64")
    parser.add_argument("sha256_hex")
    parser.add_argument("preimage_hex")
    parser.add_argument("--allow-mismatch", action="store_true")
    args = parser.parse_args()

    h = bytes.fromhex(args.sha256_hex)
    preimage = bytes.fromhex(args.preimage_hex)
    if len(h) != 32:
        raise SystemExit("SHA256 key must be 32 bytes")
    if len(preimage) != 32:
        raise SystemExit("V1 preimage must be exactly 32 bytes")
    if not args.allow_mismatch and hashlib.sha256(preimage).digest() != h:
        raise SystemExit("preimage does not match SHA256 key")

    try:
        data = base64.b64decode(args.psbt_base64, validate=True)
    except Exception as exc:
        raise SystemExit(f"invalid base64 PSBT: {exc}")
    if not data.startswith(MAGIC):
        raise SystemExit("invalid PSBT magic")

    first_input = skip_map(data, len(MAGIC))
    separator, seen = first_input_separator(data, first_input)
    key = bytes([PSBT_IN_SHA256]) + h
    if key in seen:
        raise SystemExit("PSBT already contains this SHA256 preimage key")

    entry = write_compact(len(key)) + key + write_compact(len(preimage)) + preimage
    updated = data[:separator] + entry + data[separator:]
    sys.stdout.write(base64.b64encode(updated).decode("ascii"))

if __name__ == "__main__":
    main()
