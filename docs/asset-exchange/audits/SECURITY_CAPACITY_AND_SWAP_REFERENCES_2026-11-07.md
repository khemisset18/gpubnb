# Exchange security-capacity follow-up and native swap evidence — 2026-11-07

## Scope and provenance

- Base: draft PR #337, head `b7d7b44c07ee59e9f43ce4632e2a120f699e2253`.
- New isolated branch: `asset-exchange/security-capacity-20261107`.
- Changes restricted to `asset-exchange/api/**` and this Exchange-only note.
- No main/dev merge, real-fund operation, Mainnet settlement, cryptocurrency wallet, native binary, shared dependency or workflow change.
- All five priority assets (DOGE/BTC/ZEC/XMR/PEARL) remain `MARKETPLACE_ONLY` for real-world operations; **20 financial directions are BLOCKED**.

## Security fixes prepared

### Rate limiter: bounded memory without quota reset

The original memory fixed-window limiter retained every distinct caller key indefinitely. The new fallback caps its per-process key map at 4,096 (configurable downward) and refuses unseen keys when active capacity is exhausted.

- Expired entries are removed from oldest-expiry order, not active entries.
- Existing live quota counters remain intact; capacity pressure cannot reset them.
- Expiry order is valid because every new window uses the same `windowMs` and a non-decreasing clock.
- Invalid, out-of-range or backward-moving clocks fail closed without mutating counters.
- Each request consumes O(1) ordinary work; cleanup only traverses expired entries. No repeat full-map scan of 4,096 active entries is required at saturation.
- **Limits:** fallback is process-local, not a distributed/global rate limiter. Production requires a separately reviewed cross-instance store and capacity plan. Global synchronization, distributed brute-force resistance and IP trust boundaries are **NOT_TESTED**.

### Memory session store: bounded capacity

The fallback formerly retained arbitrary new session IDs until explicit deletion, allowing unbounded growth. Default maximum is now 4,096; callers may configure a smaller cap. New inserts when full fail closed; updates to existing IDs, deletes and subject revocations still work. Copy-in/copy-out isolation is unchanged.

- A saturated SSO exchange returns generic HTTP 503 rather than reporting a client input error, without exposing the internal failure text.
- **Limits:** this store does not automatically sweep expired sessions; capacity can remain occupied by expired records until explicit deletion. Persistent Exchange PostgreSQL session storage should be used for real deployments. Do not treat the fallback as a production session service.

### Strict JSON: preserve #337 limits and reject additional malformed input

The parser retains the 1 MiB direct input limit and 32-container recursion cap from #337, with added protections:

- Reject invalid UTF-8 bytes instead of silently replacing them.
- Reject finite-range overflow such as `1e100000` before materializing a JSON number.
- Cap parsed JSON value nodes at 16,384.
- Scan scalar tokens with a sticky regex (no repeated allocation of the remaining input suffix).
- Accept only RFC 8259 structural whitespace.
- Do not change the default HTTP request body limit of 64 KiB.

## Validation

Local isolated Node 22.16.0 (no package installations; no blockchain execution):
- Fixed-window rate-limiter tests: 7 PASS / 0 FAIL.
- Memory session store capacity tests: 6 PASS / 0 FAIL.
- Parser and router changes require repository-wide CI confirmation on the published head. Until CI runs, they are **NOT_TESTED on the complete tree**.

The current PR #337 Foundation results (269 Node, D0 31, D1 11, D2 74) are historical and **must not be relabeled** as successful checks of this new revision.

## Lessons from existing atomic-swap implementations

1. **BasicSwap DEX** (https://github.com/basicswap/basicswap ; https://docs.basicswapdex.com/docs/intro/) already supports BTC, DOGE and XMR with distinct script/hash-lock and adaptor-signature approaches. Treat its code as a reference for operational state machines, order exchange, refund preconditions and recovery tests, **not** as proof that any GPUbnb direction is secure or that DOGE↔XMR direct transfers are supported by this particular implementation.
2. **eigenwallet** (https://docs.eigenwallet.org/) is a concrete BTC↔XMR atomic-swap reference. Review current code, licensing, maintenance and *exact* audit scope before choosing cross-curve/adaptor primitives. Do not invent cryptography.
3. **Dogecoin** upstream policy interfaces expose `IsStandardTx`, `AreInputsStandard`, and chain-specific dust/fee constraints (https://github.com/dogecoin/dogecoin/blob/master/src/policy/policy.h ; https://github.com/dogecoin/dogecoin/blob/master/doc/fee-recommendation.md). Private Regtest acceptance is not sufficient if the node is configured to allow nonstandard transactions. Exact flags, real native signing of **two distinct test keys**, relevant UTXO context, mempool, post-crash recovery and reorg evidence are separately required.
4. **Zcash ZIP 244** (https://zips.z.cash/zip-0244) binds transparent signatures to transaction branch ID, prevout amounts, scripts, sequences and specific input context. BTC signature-hash routines cannot be reused as ZEC v5 without ZIP 244 comparison against public reference vectors.
5. **Pearl** source identities at `pearl-research-labs/pearl@0dbdb2ffd8b81193a5079bb67a59aecc10ad501c` show Regtest and Simnet genesis/HRP collisions. An address prefix or a genesis alone is insufficient chain authentication. The #337 source-pinned identity guard is not a native RPC adapter or custody/settlement proof.

## Open blockers — do not misstate them

- **DOGE D2 native BLOCKED:** full signed claim/refund, standardness & UTXO-backed `AreInputsStandard`, private mempool acceptance, chain evidence and recovery have not been proved. A test runner with namespace support exists in GitHub; that alone is *not* an executor or proof.
- **DOGE D3–D9:** NOT_TESTED in this increment.
- **BTC:** historical Regtest, no new native requalification on this revision; BTC↔DOGE atomicity BLOCKED.
- **ZEC:** ZIP 244 native comparison and settlement BLOCKED.
- **XMR:** independently audited adaptor/cross-curve implementation and recovery evidence missing.
- **PEARL:** read-only identity consistency is not a settlement protocol.
- **Rust:** `borsh`, `glib`, `rand` security advisories from shared lock tree remain open. `glib` >= 0.20 requires a compatible GTK/Wry/Tauri dependency chain; avoid an isolated lockfile edit that breaks Linux desktop builds. See https://github.com/advisories/GHSA-wrw7-89jp-8q8g.
- **MinIO integration:** CVE-2026-116591 must be addressed using an independently pinned/reviewed image and SBOM with no bypass of the required scan.

Keep `automaticSettlement=false` and all real-fund financial routes blocked until independent pair-specific proofs exist.
