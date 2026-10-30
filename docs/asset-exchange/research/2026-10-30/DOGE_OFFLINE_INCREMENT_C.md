# Offline protocol replay and durable recovery model

Implementation status: IMPLEMENTED — NOT QUALIFIED. Native and financial
qualification: BLOCKED / NOT TESTED. This increment does not execute a chain.

## Concrete changes

`asset-exchange/research/src/offline-protocol.mjs` implements deterministic replay
of public, bounded, exactly validated events. It constructs state only from a
frozen configuration and events, never from a caller-supplied trusted snapshot.
Roles, terms, both network identities, branch plans, recovery receipts and timing
measurements are bound separately. Different amounts, outpoints, scripts,
destinations or fees must change the previously frozen plan digest.

The successful **model** path distinguishes offer, validated terms, frozen roles,
prepared recovery, observed A lock, confirmed A lock, observed B lock, confirmed B
lock, model claim eligibility, observed B claim, public commitment/spend receipt,
observed A claim, and two-leg reconciliation. No preimage is admitted. A receipt
is a digest of an assumed external review, not proof that the review happened.
No transaction, key, signature, signer request, wallet or executable operation is
returned in any state, including model closure. Every result stays qualified=false,
nativeEvidenceVerified=false and qualificationStatus=BLOCKED.

The reducer retains possible exposure after stale, contradictory, wrong-plan or
unexpected observations, and after an RPC error classified MAY_HAVE_MUTATED.
Cancellation/failure cannot discard this obligation. In particular it implements
the increment-B source finding that an RPC error can follow mempool admission;
an error is not evidence of absence of effect. This is a model of that hazard,
not a new submission experiment.

Reorganizations increment an exact epoch, invalidate both-leg combined decisions,
reopen model closure and require fresh two-leg observations. Fresh reconciliation
of unresolved locks yields RECOVERY_ONLY, never automatic resumption. Minority
conflicts, old epochs, shallow confirmations and stale observations cannot be
erased by a quorum. A mixed claim/refund remains an incident.

Expiry before exposure closes only the model offer. After possible exposure it
requires chain recovery and executes no refund. Refund observations require a
digest-only chain-time receipt plus matching branch reports and later two-leg
reconciliation. This does not implement or verify a native timeout proof.

## Durable implementation and actual process tests

`offline-protocol-store.mjs` uses the existing private POSIX journal with one new
strict digest-only OFFLINE_PROTOCOL_EVENT type. A hash-bound immutable config and
canonical public event archives are written exclusively with mode0600 in owned
mode0700 nonsymlink directories. Files and directories are fsynced. Each archive
is durable before a journal compare-and-swap commits its digest. A lost CAS can
leave an ignored orphan, not a committed state transition. Missing, partial,
modified, linked or broadly readable files fail closed; no repair/truncation or
stale-lock stealing is automatic. Event IDs bind exact content for idempotence.

Readers require an independent nonempty checkpoint and replay every referenced
event from the hash-bound config. Config replacement, journal rollback, a torn
tail or missing archive is rejected. Retain checkpoints **outside** this store;
hash chaining is not authentication. Same-account hostile filesystem mutation,
hardware power-loss/fsync guarantees, Windows and a production storage backend
remain NOT TESTED. No cryptographic authenticity or real recovery is asserted.
Opaque digests cannot provide a general secret-detection guarantee; the schema
merely excludes raw secret/signature/transaction fields. All test input is public.

There are no universal chain timeouts in this code: only an explicitly synthetic
common-seconds domain, caller-bound positive budgets and a strictly greater
remaining margin. Fixture timings and confirmation depths are fictitious model
values, unusable as operational recommendations. Both model claims are kept
within this conservative common safe window; this is not the full set of legal
chain spends. BCH ForkID, Monero adaptor recovery and Solana programs cannot be
substituted into this BTC/DOGE/LTC script-family model.

## Validation at this increment

- Node22:34 targeted journal/protocol/store tests PASS,0FAIL/skip.
- Full Foundation:220 tests PASS,0FAIL/skip (196 existing +24 new).
- 49 JavaScript source files pass individual syntax checks.
- Real child writer exit/reopen reproduces fsynced model state; two real child
  writers cannot both commit from a shared head. These are actual filesystem and
  process tests, not simulated blockchain or power-failure evidence.
- Tests cover duplicate/conflicting events, monotonic time, roles/plans/network,
  missing participant, refusing signer, unusable fees, lost network, premature
  secret receipt, expiry, insufficient margins, stale/conflicting evidence,
  uncertain RPC effects, reorgs, mixed spends, archive/config corruption, torn
  writes, rollback, permissions, symlinks/hardlinks and forbidden payload fields.

Development trials found invalid test IDs and an incorrectly ordered/boundary
test clock. Fixtures were corrected without weakening validation. Captured failed
attempts are retained alongside final passing logs in evidence/increment-c/;
they are failures, not qualification evidence. SHA256.json binds the final code,
tests and logs. No D0/D1 file, trust parameter, Rust/#319 file, active financial
handler, route, dependency or security gate is changed. D3–D9 were not executed.

Next independent increment: strict chain-specific offline interface boundaries
for all six assets, retaining zero qualified financial routes.
