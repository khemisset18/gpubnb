# gpu.k.p2p — G5 Continuous Security Audit Record — 2026-10-06

Status: INTERNAL CONTINUOUS AUDIT / PRE-MAINNET / NO REAL FUNDS

## Scope

Reviewed:
- G4 bounded TLA+/TLC model and CI;
- G5 zero-dependency domain core;
- fee policy;
- offer/accept/cancel semantics;
- PostgreSQL schema;
- concurrent acceptance/cancellation;
- API health/readiness shell;
- watcher evidence boundary;
- recovery metadata boundary;
- deployment replay isolation;
- CI supply-chain controls.

## Evidence

Formal verification run:
- workflow: Asset Exchange Formal Verification;
- run id: 37407796915;
- commit: 8e821bb6bf1e1cf00ccab873af520e9504c3e326;
- TLA+ tool SHA-256: 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88;
- model states generated: 71,716;
- distinct states: 6,720;
- complete graph depth: 19;
- states left on queue: 0;
- TLC result: no invariant violation found within configured bounds.

PostgreSQL concurrency:
- PostgreSQL 16.13 Alpine pinned by multi-platform index digest;
- migrations applied from clean database;
- accept-vs-accept tested with independent sessions;
- accept-vs-cancel tested with independent sessions;
- idempotent retry tested;
- same idempotency key with changed request hash rejected;
- TRANSITION/stale epoch acceptance rejected.

G5 foundation:
- Node tests;
- syntax checks;
- Core-import isolation;
- custody-literal guard;
- financial SQL type guard.

## Findings found and corrected

### F-001 — Premature COMPLETED state
Severity: CRITICAL design issue if shipped.

Initial G5 state machine allowed completion after both locks were merely confirmed.

Fix:
- added explicit SECRET_REVEALED;
- added COUNTER_REDEEM_CONFIRMED;
- COMPLETED now requires expected principal spends;
- TLA+ updated with CompletedRequiresRedeems.

Regression:
- unit test prevents completion from lock confirmations alone.

Disposition: VERIFIED FIXED.

### F-002 — FAIL_SAFE could strand locked funds
Severity: CRITICAL design issue if used after funding.

Fix:
- FAIL_SAFE allowed only before lock;
- post-lock failures must remain recovery-capable.

Regression:
- unit test rejects FAIL_SAFE after A lock.

Disposition: VERIFIED FIXED.

### F-003 — Cross-deployment replay domain missing
Severity: HIGH.

A signed object with only protocol/network fields could theoretically be presented to another deployment using the same protocol domain.

Fix:
- deploymentId added to offer and acceptance signed material;
- service rejects deployment mismatch;
- persistence stores deployment_id;
- regression tests added;
- TLA+ extended with cross-deployment replay invariant.

Disposition: FIXED; formal rerun required after latest model update.

### F-004 — Formal state space accidentally unbounded
Severity: HIGH verification defect.

policyEpoch was Nat and mode transitions could increase it indefinitely.

Fix:
- MaxEpoch constant introduced;
- bounded TLC configuration;
- complete bounded search now terminates.

Disposition: VERIFIED FIXED.

### F-005 — Readiness dependency could hang
Severity: MEDIUM availability issue.

Fix:
- readiness probe bounded by timeout;
- errors remain generic;
- regression test added.

Disposition: VERIFIED FIXED.

### F-006 — FeePolicy null normalization bug
Severity: MEDIUM correctness issue.

Fix:
- normalized null min/max accepted safely;
- fee math tests remain exact integer arithmetic.

Disposition: VERIFIED FIXED.

### F-007 — PostgreSQL cancel PL/pgSQL identifier ambiguity
Severity: MEDIUM implementation issue.

Fix:
- table aliases qualify offer_id references.

Disposition: VERIFIED FIXED through migration/concurrency CI.

### F-008 — Concurrency test induced lock-order deadlock
Severity: TEST DEFECT, with architectural value.

The first test pre-locked offer then called code that locks operator then offer, creating an artificial lock inversion against another accept.

Fix:
- test now pre-locks operator for accept-vs-accept to match production lock order;
- accept-vs-cancel still locks offer first because cancel never waits for operator, so no cycle.

Lesson:
- future operations that need both operator_state and offers MUST acquire them in the documented order: operator_state -> offer.

Disposition: VERIFIED FIXED.

### F-009 — Financial SQL scanner false positive
Severity: LOW tooling issue.

The guard matched the word REAL inside a comment.

Fix:
- comments are stripped before checking column declarations;
- guard remains strict for REAL/FLOAT/DOUBLE PRECISION/MONEY declarations.

Disposition: VERIFIED FIXED.

## Current stop-ship conditions

Still STOP-SHIP for real funds/Mainnet:
- settlement implementation not approved;
- Bitcoin lock/redeem/refund byte-level templates not yet implemented/audited;
- recovery bundle encryption/export/import not complete;
- signing adapters/hardware-wallet compatibility not complete;
- no external independent audit;
- liveness/fairness formal checks incomplete;
- chain-specific fee/pinning/reorg qualification incomplete.

## Gate interpretation

G4 has a successful bounded safety run, but is not final because the model continues to evolve with G5 and liveness/replay detail remains under expansion.

G5 foundation has working isolated primitives and persistence/concurrency evidence, but does not authorize settlement.

No Mainnet authorization.
No real-funds authorization.
