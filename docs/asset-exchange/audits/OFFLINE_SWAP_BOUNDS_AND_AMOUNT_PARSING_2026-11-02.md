# Offline swap model bounds and atomic amount parsing

Status: **PASS for the two software corrections below**, verified on the local
Windows host. **NOT_TESTED** for every POSIX-only component. **BLOCKED** for any
financial, native or Mainnet claim. No merge, no deployment, no settlement
activation.

Branch: `asset-exchange/doge-offline-hardening-20261102`.
Base: `asset-exchange/doge-offline-protocol-20261030` (PR #320), head
`35a71062748c4ed9cbebc04cf445581c6898adff`.

## Scope

Only `asset-exchange/core` and `asset-exchange/research` were touched. No GPUbnb
Core, site, marketplace, rental, account, billing, agent, shared infrastructure,
global configuration, dependency or CI file changed. `main` and `dev` were not
modified and no merge occurred.

## Defect 1 — unbounded decimal digits reached `BigInt()`

`asset-exchange/core/src/amount.mjs` validated the canonical decimal form with
`/^(0|[1-9][0-9]*)$/`, which has no length bound, and only compared against the
u128 maximum **after** `BigInt(value)`.

Measured on the pre-fix module:

| Input digits | Result | Time |
| --- | --- | --- |
| 1,000 | `AMOUNT_RANGE` | 0.2 ms |
| 100,000 | `AMOUNT_RANGE` | 3.4 ms |
| 1,000,000 | `AMOUNT_RANGE` | 62.5 ms |

Cost is superlinear in the digit count, so rejection happens only after the
expensive conversion. `parseAtomicAmount` is the entry point used by
`offer.mjs#normalizeOfferInput`, therefore by `parseSignedOffer` and the API offer
path, and by `fee-policy.mjs` for `minimumAtomic` and `maximumAtomic`. Transport
body limits bound the current HTTP path, but the function is the shared library
boundary and must not rely on a caller's limit.

Correction: the length is bounded to `MAX_ATOMIC_DIGITS` (39, the canonical u128
decimal length) **before** `BigInt()`. The accepted language is unchanged and the
error code stays `AMOUNT_FORMAT`; the fix is observable because `AMOUNT_RANGE` is
only reachable after a successful conversion.

| Input digits | Result after fix | Time |
| --- | --- | --- |
| 1,000 | `AMOUNT_FORMAT` | 0.1 ms |
| 100,000 | `AMOUNT_FORMAT` | 0.0 ms |
| 1,000,000 | `AMOUNT_FORMAT` | 0.0 ms |

## Defect 2 — unbounded durable replay history

`asset-exchange/research/src/swap-safety-model.mjs` accepted chain-alert events
(`REORG`, `UNCERTAIN`) in every non-terminal state and appended every new event id
to `state.seen`, with no bound. Each event also `structuredClone`s the whole
state, so cost is quadratic.

Measured on the pre-fix module: 5,001 repeated `UNCERTAIN` events were all
accepted and retained, taking **16,054 ms**, with `seen` growing without limit. A
durable state model must not grow its replay journal from ordinary peer input.

Correction: `MAX_RECORDED_EVENTS = 4096` with an explicit fail-closed error
`recorded event history exceeds bound; explicit checkpoint required`. A legitimate
trade uses fewer than twenty lifecycle events, so the bound is unreachable in
normal operation. The bound never forgets a recorded digest: replaying an already
recorded id still returns the unchanged state, and the next new id is refused.

After the fix the same probe stops at 4,096 stored events with a model error
instead of growing indefinitely. The quadratic `structuredClone` cost per event is
unchanged; the bound now makes the worst case finite rather than unbounded. That
residual cost is recorded below as **NOT TESTED / known limitation**, not as
qualified behaviour.

## Defect 3 — cyclic and deeply nested payloads overflowed the call stack

The module kept a private canonicalizer with no depth, node, key or text bound and
no plain-object restriction. A cyclic event payload, a cyclic `networks` graph, or
a deeply nested payload produced a raw
`RangeError: Maximum call stack size exceeded` instead of a fail-closed model
error. A cyclic `networks` graph also made the returned state unjournalable.

Correction: the private canonicalizer, digest and freeze helpers are replaced with
the already bounded primitives of `asset-exchange/research/src/offline-data.mjs`
(`canonical`, `dataHash`, `freeze`, `requireThat`). That module rejects cyclic
graphs, non-plain prototypes, sparse arrays, unsafe object keys, unsafe numbers,
and enforces global node/depth/key/text bounds. `createOfflineTrade` now validates
`networks` before `structuredClone`.

Digest compatibility is preserved and proven by regression: `dataHash` is
byte-identical to the previous private digest for plain JSON data, so replay
digests persisted under the previous code stay valid. The regression test asserts
the recorded digest against an independently written legacy oracle.

## Related hardening — prototype-shadowing event identifiers

The replay lookup was a truthiness read (`current.seen[event.id]`), so any id that
is an inherited member of `Object.prototype` (`constructor`, `toString`,
`hasOwnProperty`, ...) was misreported as `conflicting replay`. Such an id also
shadows the replay map when persisted. Identifiers are now rejected explicitly
(`event identity must not shadow an object prototype member`) and the lookup uses
`Object.hasOwn`. Existing rejection behaviour is unchanged; only the diagnosis is.

## Tests

`asset-exchange` Node suite in this worktree:

| Run | Pass | Fail | Failures explained |
| --- | --- | --- | --- |
| Before | 227 | 24 | all `journal requires POSIX file semantics; Windows NOT TESTED` |
| After | 233 | 24 | identical 24 POSIX-guard failures, no new failure |

The 24 failures are the deliberate fail-closed POSIX guard in
`offline-journal.mjs` reached from `offline-journal`, `offline-protocol-store`,
`offline-review-regressions`, `recovery/cli` and `recovery/security-hardening`.
They are **NOT_TESTED** on this Windows host and remain covered by the Linux
`Asset Exchange G5 Foundation` job. No control was skipped, relaxed or hidden.

Six new regression tests were added:

- `atomic amounts bound the decimal length before BigInt conversion`
- `cyclic and deeply nested payloads fail closed instead of overflowing the call stack`
- `event payload text, key count and node budget are bounded before hashing`
- `event identities cannot shadow Object.prototype members`
- `durable replay history is bounded and never forgets a recorded digest`
- `bounded canonicalization keeps the previously persisted replay digest byte-identical`

Additional local results:

- `npm run check --prefix asset-exchange`: `Syntax PASS: 50 source files checked independently`.
- DOGE D2 Python suite: 59 tests, 2 failures + 5 errors, all pre-existing
  platform guards (`artifact reader requires POSIX no-follow semantics`,
  `os.mkfifo`, `resource` module). Unchanged by this work.
- DOGE D1 Python suite: 11 tests, 1 pre-existing platform failure
  (exit `127` instead of `2` because `/bin/bash` is absent on Windows).
- DOGE D0 Python suite: 31 tests, 9 failures + 1 error, all pre-existing
  `/bin/bash` path handling on Windows.

Every non-POSIX result above is reproducible offline and executes no Dogecoin
binary, generates no key, signs nothing and contacts no blockchain.

## CI result on this branch

Run [41452403525](https://github.com/khemisset18/gpubnb/actions/runs/41452403525)
and [41452335133](https://github.com/khemisset18/gpubnb/actions/runs/41452335133):

| Job | Result |
| --- | --- |
| Zero-dependency foundation safety tests | PASS |
| api | PASS |
| agent | PASS |
| contract | PASS |
| desktop-security | PASS |
| production-gates | PASS |
| dependency-audit | FAIL — shared trees only |
| security-static-analysis | FAIL — shared trees only |

`Zero-dependency foundation safety tests` PASS covers `npm run check`, the full
`asset-exchange` Node suite, the DOGE D0/D1/D2 Python suites and the Linux
network-isolation preflight, i.e. exactly the suite that could not be executed
completely on this Windows host.

## Remaining boundaries

- **BLOCKED**: D2 native claim/refund, exact native script flags, standardness and
  admission outcomes, UTXO/finality context. No new native proof was produced.
- **BLOCKED**: `security-static-analysis`, `blockingCount: 7`, on dependency files
  this branch does not touch:

  | Target | Package | Installed | Advisory | Severity | Fixed |
  | --- | --- | --- | --- | --- | --- |
  | `Cargo.lock` | borsh | 0.10.4 | GHSA-fjx5-qpf4-xjf2 | MEDIUM | 1.0.0-alpha.1 |
  | `Cargo.lock` | glib | 0.18.5 | GHSA-wrw7-89jp-8q8g | MEDIUM | 0.20.0 |
  | `Cargo.lock` | rand | 0.7.3 | GHSA-cq8v-f236-94qc | LOW | 0.9.3 / 0.10.1 / 0.8.6 |
  | `package-lock.json` | glob | 13.0.6 | CVE-2026-118773 | MEDIUM | 14.0.2 |
  | `package-lock.json` | minimatch | 10.2.5 | CVE-2026-118764 | MEDIUM | 11.0.1 |
  | `apps/api/package-lock.json` | glob | 13.0.6 | CVE-2026-118773 | MEDIUM | 14.0.2 |
  | `apps/api/package-lock.json` | minimatch | 10.2.5 | CVE-2026-118764 | MEDIUM | 11.0.1 |

- **BLOCKED**: `dependency-audit` now reports `moderate: 3` in both the root and
  `apps/api` npm trees (`@fastify/static` → `glob` → `minimatch`), reproduced
  locally with `npm audit --json`. This is new since the #320 run and is caused by
  the two `CVE-2026-1187xx` publications above, not by this branch: `git diff` to
  the base touches no dependency or lockfile. `asset-exchange/package.json`
  declares no dependencies, so no exchange package is affected.
- Both gate failures are in shared configuration and shared dependency graphs that
  this mission forbids modifying without explicit authorization. They are recorded
  here and in the PR body, **not** waived, suppressed, downgraded or excluded, and
  no severity threshold was lowered.
- **NOT TESTED**: the POSIX journal, recovery and crash-recovery paths on this
  host. Linux CI remains the only authority for them.
- **NOT TESTED**: the quadratic `structuredClone` cost inside the new event bound.
- No phase, financial route, other chain or production readiness is declared
  complete. `MARKETPLACE_ONLY`, `automaticSettlement=false`, no Mainnet, no real
  funds and no Dogecoin execution remain in force.
