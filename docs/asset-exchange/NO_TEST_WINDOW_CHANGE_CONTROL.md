# No-Test Window Change Control

Status: TEMPORARY SECURITY OPERATING MODE

## Purpose

This document defines what development may continue while executable tests cannot currently be run.

The objective is to keep forward progress without accumulating unverified fund-path risk.

## Hard rule

During a no-test window, do NOT activate or materially alter any executable path that can:
- construct a funding transaction;
- broadcast a transaction;
- sign or request signing of financial transactions;
- change lock/redeem/refund semantics;
- change recovery cryptography;
- weaken authentication or authorization;
- change fee collection execution;
- enable a new asset for automatic settlement;
- change database financial-state transition semantics;
- change watcher evidence into an authoritative finality decision.

## Allowed work

Allowed without running tests:
- research using primary/official sources;
- architecture documents;
- threat-model updates;
- protocol specifications;
- chain qualification matrices;
- asset registry documentation;
- release/toolchain pin research;
- disabled-by-default design proposals;
- audit checklists;
- recovery runbooks;
- formal properties written but not claimed as verified;
- test plans and adversarial scenarios;
- license/provenance research.

## Conditionally allowed code

Only low-risk code may be staged without execution when ALL are true:
- fail-closed by construction;
- not imported by a current runtime path;
- disabled by default;
- cannot broadcast/sign/move funds;
- does not change financial database state;
- clearly marked UNVERIFIED;
- activation requires a later tested commit.

Prefer documentation over code when these conditions are not clearly met.

## Forbidden claims

While tests cannot run, do not claim:
- gate passed;
- chain qualified;
- settlement secure;
- recovery proven;
- signer compatible;
- production ready;
- Mainnet ready.

Use:
- DESIGNED;
- RESEARCHED;
- SPECIFIED;
- PENDING EXECUTION;
- UNVERIFIED.

## Resumption procedure

When test execution becomes available again:

1. freeze feature work;
2. record current branch SHA;
3. run syntax/static gates;
4. run G5 foundation;
5. run PostgreSQL gates;
6. run formal model;
7. run Bitcoin regtest;
8. run recovery artifact verification;
9. run chain-specific qualification gates;
10. review all commits created during the no-test window;
11. compare branch to main;
12. reopen implementation only after all required gates are green.

Any red gate blocks further settlement activation.

## Branch policy

All work remains on:

`asset-exchange/secure-foundation-v1`

No merge to main during the no-test window unless the owner explicitly overrides this policy after review.

## Funds policy

No real funds.
No Mainnet activation.
No hidden fallback to production RPCs.
No automatic chain enablement.

This policy remains in force until test execution is explicitly restored.
