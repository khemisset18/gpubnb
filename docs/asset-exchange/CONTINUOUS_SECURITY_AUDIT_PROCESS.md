# gpu.k.p2p — Continuous Security Audit Process v0

Status: ACTIVE PROCESS / PRE-IMPLEMENTATION / NO REAL FUNDS

## 1. Purpose

This document defines how gpu.k.p2p is reviewed continuously during development.

Security review is not deferred to the end of the project.

Every security-sensitive change must pass:
design review -> implementation review -> adversarial review -> regression evidence -> gate decision.

The final external audit remains mandatory before meaningful Mainnet exposure.

## 2. Security priorities

Priority order remains:
1. funds security;
2. funds recovery;
3. cryptographic correctness;
4. isolation from GPUbnb Core;
5. fault resistance;
6. privacy;
7. maintainability;
8. UX simplicity;
9. performance;
10. number of supported chains.

No review may trade a higher-priority property for a lower-priority convenience without explicit owner decision and documented rationale.

## 3. Scope

Continuous audit covers:
- protocol design;
- signed terms;
- settlement scripts/contracts/programs;
- recovery;
- fee logic;
- wallet integrations;
- watchers;
- chain adapters;
- API/auth/session;
- WebSocket;
- admin plane;
- KYC/compliance isolation;
- privacy;
- database constraints;
- Redis usage;
- RPC gateways;
- SSRF;
- frontend;
- CSP/XSS/CSRF/clickjacking;
- supply chain;
- CI/CD;
- container hardening;
- Windows Wallet Agent;
- secrets;
- observability/logging;
- incident controls.

## 4. Change risk classes

R0 — Documentation-only
No executable or security-semantic change.

R1 — Low
Refactor with no externally visible security behavior change.

R2 — Moderate
Changes authentication, API behavior, database constraints, policy or UI signing intent.

R3 — High
Changes settlement, recovery, fee collection, chain adapter, watcher, wallet signing, mode transition, treasury or admin security.

R4 — Critical
Changes cryptographic protocol, lock/redeem/refund semantics, private-key boundary, production Mainnet configuration, recovery invariant, signing domain, or protocol serialization.

R3/R4 require explicit adversarial review and evidence before merge.

## 5. Stop-ship findings

The following are STOP-SHIP for any affected gate/release:

- possible loss of principal;
- possible loss of refund/recovery path;
- double fill;
- double spend caused by application logic;
- unsigned or mutated terms reaching settlement;
- private key/seed exposure;
- server-side custody introduced accidentally;
- stale policy epoch creating a new lock;
- recovery disabled by kill switch/KYC/mode transition;
- admin able to redirect existing signed funds;
- unauthenticated fee-recipient substitution;
- critical SSRF to internal control plane;
- authentication bypass;
- BOLA/IDOR affecting funds/identity;
- supply-chain artifact with unverifiable provenance in fund-critical path;
- formal invariant violation without understood resolution.

## 6. Severity model

CRITICAL:
direct or credible path to user fund loss, key compromise, arbitrary settlement authorization, or catastrophic isolation failure.

HIGH:
serious recovery, authorization, protocol, privacy, admin, RPC or supply-chain weakness with significant impact.

MEDIUM:
meaningful weakness requiring correction before broader rollout but not directly exploitable for catastrophic loss under current assumptions.

LOW:
hardening, defense-in-depth, diagnostics, maintainability or low-impact issue.

INFO:
observation/recommendation without current exploit path.

Severity never replaces gate logic. A formally required invariant failure is blocking regardless of label.

## 7. Review stages

Stage A — Design review
Before code:
- threat scenario;
- trust boundaries;
- invariants;
- failure modes;
- recovery implications;
- compatibility;
- observability;
- rollback/disable behavior.

Stage B — Implementation review
Check:
- exact diff;
- privilege changes;
- dependency changes;
- unsafe defaults;
- error handling;
- integer/serialization correctness;
- idempotency;
- concurrency;
- secret handling.

Stage C — Adversarial review
Attempt to break:
- authorization;
- replay;
- recovery;
- reorg handling;
- duplicate delivery;
- stale worker;
- fee logic;
- mode transition;
- RPC/network assumptions.

Stage D — Evidence
Required evidence depends on class:
- unit tests;
- integration tests;
- property tests;
- fuzzing;
- formal verification;
- regtest;
- chaos/crash tests;
- static/dependency scans.

Stage E — Gate decision
PASS / PASS-WITH-LIMITS / BLOCKED / QUARANTINED.

## 8. Mandatory review questions

For every R2+ change:

1. Can this cause a user to lose principal?
2. Can this remove or delay recovery?
3. Can a server compromise redirect funds?
4. Can stale/replayed input authorize a new action?
5. Can duplicate execution create another irreversible effect?
6. What happens after crash at every durable boundary?
7. What happens after reorg?
8. Does the change affect Core isolation?
9. Does the change alter KYC/compliance scope?
10. Does it introduce new secrets?
11. Does it add an outbound network destination?
12. Does it change fee or treasury authority?
13. Can a compromised frontend trick the signer?
14. Is signed intent independently reconstructed?
15. What evidence proves the change?

## 9. Code review requirements

Fund-critical code requires:
- smallest practical diff;
- no drive-by refactors;
- explicit invariant mapping;
- tests in same change or prior approved dependency;
- no TODO that weakens recovery/safety;
- no ignored error on fund-critical path;
- no float for financial amounts;
- bounded parsing;
- deterministic serialization;
- explicit network/chain identifiers.

## 10. Dependency review

New dependency in R2+ path requires:
- purpose;
- maintainer/activity review;
- license;
- pinned version;
- vulnerability scan;
- transitive dependency awareness;
- minimal feature set;
- replacement/removal strategy.

Cryptography dependencies require additional review.

## 11. Secret review

Audit verifies:
- no seed/private key/raw spend key server-side;
- no secrets in Git;
- no secrets in logs;
- no secrets in URLs;
- no secrets in browser analytics;
- CI secrets unavailable to untrusted PR;
- environment separation;
- rotation procedures.

## 12. Database review

Financial/security state requires:
- PostgreSQL durability;
- transactions;
- unique constraints where race safety depends on uniqueness;
- compare-and-set/expected-state semantics;
- immutable/auditable events where required.

Redis may not become financial source of truth.

## 13. API review

Must test:
- authentication;
- authorization per object;
- mass assignment;
- replay;
- idempotency;
- rate limiting by business flow;
- schema/version rejection;
- error information leakage;
- BOLA/IDOR.

## 14. Frontend review

Must test:
- XSS;
- CSP;
- clickjacking;
- CSRF;
- malicious token/NFT metadata;
- SVG;
- clipboard substitution;
- service workers;
- wallet-origin binding;
- WYSIWYS mismatch.

## 15. RPC and watcher review

Must test:
- SSRF;
- DNS rebinding;
- redirects;
- loopback/private/link-local/cloud metadata blocking;
- network/genesis mismatch;
- stale data;
- contradictory sources;
- malicious RPC responses;
- reorg;
- mempool vs consensus assumptions.

## 16. Recovery review

For every settlement change:
- recovery bundle remains sufficient;
- recovery path works without frontend/API/Redis/Core;
- refund is never disabled;
- bundle version compatibility preserved;
- fee logic cannot block principal recovery.

## 17. Fee review

Changing fee code/policy requires:
- signed fee terms;
- exact integer math;
- immutable accepted fee policy;
- recipient integrity;
- failed-trade behavior;
- dust/economic safety;
- recovery interaction;
- treasury-key isolation.

## 18. Formal verification review

Any protocol/state-machine change must evaluate whether TLA+ model changes are required.

If implementation semantics exceed model semantics:
G4 evidence is stale until model updated and rerun.

Green TLC on an outdated model is not valid evidence.

## 19. Regtest review

Before testnet:
- happy path;
- crash before broadcast;
- crash after broadcast;
- duplicate jobs;
- reorg;
- conflicting transaction;
- fee spike;
- mempool eviction;
- stale watcher;
- mode transition;
- quarantine;
- recovery-only path.

## 20. Fuzzing review

Mandatory targets include:
- signed-term parser;
- deterministic serialization;
- recovery bundle parser;
- PSBT/transaction parser;
- RPC response parser;
- state transition command;
- NFT/token metadata parser where applicable.

Crashes, hangs, uncontrolled allocations and semantic invariant failures are blocking until understood.

## 21. Supply-chain review

CI:
- minimal permissions;
- actions pinned by commit SHA;
- no secret exposure to untrusted contribution;
- artifact digests;
- SBOM/provenance where applicable;
- build once / promote immutable artifact.

Fund-critical binaries/tools:
- version pinned;
- digest checked;
- origin documented.

## 22. Continuous audit record

Every material review should record:

AuditRecord {
  review_id
  timestamp
  git_commit
  files
  risk_class
  reviewer
  threat_scenarios
  invariants
  findings
  severity
  evidence
  disposition
  gate_status
}

Records must be append-only/auditable.

## 23. Finding lifecycle

OPEN
ACKNOWLEDGED
FIX_IN_PROGRESS
FIXED_PENDING_VERIFICATION
VERIFIED
ACCEPTED_RISK
WONT_FIX
INVALID

CRITICAL/HIGH in fund-critical path cannot be ACCEPTED_RISK casually.
Explicit owner/security rationale required.

## 24. Regression requirement

Every confirmed security bug must produce at least one of:
- unit regression test;
- integration regression test;
- property invariant;
- fuzz corpus case;
- TLA+ counterexample regression;
- chaos test.

Fixing code without preserving regression evidence is incomplete.

## 25. Independent final audit

Continuous internal/AI-assisted auditing does not replace final independent review.

Before G9 Mainnet canary:
- fresh review from clean perspective;
- external security reviewer/company;
- protocol/settlement specialist;
- additional cryptography specialist when needed;
- unresolved findings documented;
- retest of fixes.

## 26. Mainnet rule

No single green signal authorizes Mainnet.

Required evidence is cumulative across:
G0 isolation
G1 application security
G2 protocol
G3 recovery
G4 formal
G5 implementation
G6 regtest
G7 testnet
G8 independent review
G9 canary

## 27. Audit cadence

Audit is event-driven, not calendar-only.

Trigger review when:
- R2+ code changes;
- new dependency;
- new chain;
- fee-policy mechanism changes;
- wallet integration changes;
- KYC provider changes;
- node version changes;
- incident/advisory appears;
- formal model changes;
- release candidate is cut.

Periodic dependency/advisory review is additional.

## 28. Current status

Continuous security audit process: DEFINED.
Automated implementation: PARTIAL.
Formal CI: ACTIVE/IN PROGRESS.
Final external audit: NOT STARTED.
Real funds: FORBIDDEN.
Mainnet: FORBIDDEN.
