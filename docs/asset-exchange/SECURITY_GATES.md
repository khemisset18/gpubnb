# GPUbnb Asset Exchange — Security Gates v0

Status: ENFORCEMENT SPEC / PRE-DEVELOPMENT

No gate may be bypassed to accelerate launch. A blocked gate may only be cleared by evidence.

## G0 — Isolation

Required:
- dedicated Asset Exchange database design;
- dedicated Redis/cache design;
- dedicated secrets namespace;
- dedicated deployable services;
- no runtime dependency from core GPUbnb rental/mining into Asset Exchange;
- outage/deletion test plan proving core GPUbnb remains functional.

Result:
- PASS -> G1
- FAIL -> STOP

## G1 — Threat model

Required:
- data-flow diagrams and trust boundaries;
- per-component threat register;
- STRIDE/abuse/failure cases;
- explicit privacy threats;
- supply-chain threats;
- administrative threats;
- chain-specific threats.

## G2 — Protocol specification

Required:
- versioned canonical messages;
- asset/network identity rules;
- integer amount rules;
- signatures/domain separation/replay protection;
- exact settlement state machine;
- idempotency requirements;
- fee, confirmation and timeout policy;
- protocol upgrade rules.

## G3 — Recovery specification

Required:
- crash before/after every fund-critical action;
- backend unavailable recovery;
- encrypted recovery bundle design;
- redeem/refund independence from feature flags;
- chain halt and reorg recovery.

## G4 — Formal state analysis

Required:
- model critical state transitions in TLA+ or equivalent;
- verify no double fill;
- verify no completed+refunded contradiction;
- verify signed terms cannot mutate;
- verify mode transition cannot disable refund/recovery;
- document assumptions and uncovered state-space limits.

## G5 — Implementation without real funds

Required:
- marketplace/order flow;
- signed offers;
- asset registry;
- mode engine and epoch/fencing;
- isolated infrastructure;
- zero capability to move Mainnet funds.

## G6 — Local/regtest settlement

Required:
- one protocol family only;
- deterministic test vectors;
- crash/fault injection;
- duplicate/out-of-order messages;
- fee and mempool failure cases;
- reorg tests;
- restore/recovery drills.

## G7 — Public testnet

Required:
- independent nodes;
- multiple wallet implementations when practical;
- real network latency/outages;
- malicious peer tests;
- rate/DoS limits;
- long-running recovery scenarios.

## G8 — Independent security review

Required as applicable:
- protocol review;
- cryptographic review;
- smart-contract review;
- wallet-agent review;
- application/API review;
- supply-chain/build review.

An audit report is evidence, not proof of safety.

## G9 — Mainnet canary

Required:
- strict value cap;
- strict concurrent-trade cap;
- minimal pair count;
- chain quarantine ready;
- incident runbooks exercised;
- monitoring/on-call ready;
- refunds/recovery exercised on production-like infrastructure.

## G10 — Progressive production

Limits may increase only from observed evidence.
Any critical chain/security incident can move a chain or protocol back to a previous gate.

## Permanent blockers

Regardless of gate number, real funds remain forbidden when:
- user private keys/seeds can reach server infrastructure;
- no independent recovery path exists;
- fund-critical parameters are not signed/immutable;
- one untrusted data source can cause irreversible fund loss;
- chain adapter security assumptions are undocumented;
- a critical dependency/license is unresolved;
- a known critical vulnerability is open;
- refund/recovery can be disabled by configuration or mode switching.
