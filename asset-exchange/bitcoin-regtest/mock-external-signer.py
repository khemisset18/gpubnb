#!/usr/bin/env python3
import base64
import json
import sys

FINGERPRINT = "deadbeef"
MODEL = "gpubnb-ci-mock"
MAX_STDIN = 2_000_000

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))
    sys.stdout.write("\n")

def fail(message):
    emit({"error": message})
    raise SystemExit(0)

args = sys.argv[1:]
if args == ["enumerate"]:
    emit([{"fingerprint": FINGERPRINT, "model": MODEL}])
    raise SystemExit(0)

fingerprint = None
chain = None
stdin_mode = False
positionals = []
i = 0
while i < len(args):
    arg = args[i]
    if arg == "--stdin":
        stdin_mode = True
        i += 1
        continue
    if arg in {"--fingerprint", "--chain"}:
        if i + 1 >= len(args):
            fail(f"missing value for {arg}")
        if arg == "--fingerprint":
            fingerprint = args[i + 1]
        else:
            chain = args[i + 1]
        i += 2
        continue
    positionals.append(arg)
    i += 1

if fingerprint != FINGERPRINT:
    fail("unexpected signer fingerprint")
if chain != "regtest":
    fail("unexpected signer chain")
if not stdin_mode:
    fail("stdin signer mode required")

payload = sys.stdin.read(MAX_STDIN + 1)
if len(payload) > MAX_STDIN:
    fail("signer request too large")
if not payload.startswith("signtx "):
    fail("unsupported signer request")

encoded = payload[7:].strip()
try:
    raw = base64.b64decode(encoded, validate=True)
except Exception:
    fail("invalid psbt base64")

if len(raw) < 5 or raw[:5] != b"psbt\xff":
    fail("invalid psbt magic")

# CI mock is intentionally non-signing. A hardware signer adapter must return
# a modified PSBT only after device/user approval. There is no fallback key.
fail("mock signer intentionally refuses signing")
