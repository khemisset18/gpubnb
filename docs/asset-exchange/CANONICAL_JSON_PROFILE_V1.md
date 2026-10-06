# Canonical JSON Profile V1

Status: SECURITY FOUNDATION / SIGNATURE-CRITICAL

Domain use:
- OFFER
- ACCEPT
- CANCEL
- SETTLEMENT
- recovery/admin digests where canonical JSON is used

## Goal

All implementations must hash the same semantic object into the same bytes.

The profile is intentionally a strict subset of RFC 8785 / JCS.

## Rules

1. UTF-8 output only.
2. No insignificant whitespace.
3. Object keys sorted recursively by raw UTF-16 code units.
4. Array order is preserved.
5. Strings are serialized with ECMAScript JSON string escaping.
6. Unicode normalization is NOT performed.
7. Lone UTF-16 surrogates are rejected.
8. JSON numeric values are restricted to safe integers.
9. Larger monetary values MUST be encoded as canonical decimal strings.
10. BigInt values are never serialized directly.
11. Unknown protocol fields are rejected by each schema before canonicalization.

## Why this is a subset of JCS

RFC 8785 permits the I-JSON number model based on IEEE-754 serialization.

gpu.k.p2p intentionally narrows this:
- financial atomic amounts are decimal strings;
- protocol counters/timestamps that remain JSON numbers must be safe integers;
- floating-point financial values are forbidden.

This avoids cross-language precision loss.

## Cross-language requirement

A non-JavaScript implementation MUST reproduce UTF-16 code-unit key ordering, not UTF-8 byte ordering.

Implementations in Rust, Go, Python or other languages must pass the canonical test vectors before they are allowed to sign or verify protocol objects.

## Security rule

Changing canonicalization rules requires a new protocol/canonicalization version.

Existing signed v1 payloads must never silently migrate to different serialization semantics.
