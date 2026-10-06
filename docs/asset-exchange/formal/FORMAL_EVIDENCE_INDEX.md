# Formal Verification Evidence Index

Status: BOUNDED FORMAL EVIDENCE / NOT PRODUCTION AUTHORIZATION

## Accepted run — 2026-10-06

- Workflow: Asset Exchange Formal Verification
- GitHub Actions run id: `37520577666`
- Source commit: `2746c6f890b6e0eba70c0e992a04d09e1a533dcf`
- TLA+ tools: `1.7.4`
- tla2tools SHA-256: `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`
- SANY: PASS
- TLC safety scenario: PASS
- TLC cooperative liveness scenario: PASS
- TLC recovery liveness scenario: PASS
- TLC transition liveness scenario: PASS

### Bounded exploration metrics

| Scenario | Generated states | Distinct states | Depth | Result |
|---|---:|---:|---:|---|
| Safety | 208484 | 19360 | 21 | PASS |
| Cooperative completion | 40 | 13 | 13 | PASS |
| Recovery while Exchange unavailable | 4 | 4 | 4 | PASS |
| Mode transition completion | 2 | 2 | 2 | PASS |

### Explicit liveness assumptions

The liveness configs apply weak fairness to the exact sub-actions needed for each bounded scenario.

The recovery scenario makes chain-time progress explicit with `AdvanceRefundTime` and begins with `exchangeAvailable = FALSE`. The resulting refund path therefore does not depend on marketplace frontend/API/workers being available.

The cooperative scenario assumes the modeled participant/chain progress actions remain continuously enabled when their predecessor state has been reached.

The transition scenario assumes an already-unblocked transition remains eligible for activation.

### Counterexample history

The first liveness CI run, `37520428170`, failed.

TLC exposed that `BroadcastALock` did not preserve the newly added `refundMatured` and `exchangeAvailable` variables, producing undefined values in the cooperative scenario.

This was treated as a model defect:
- evidence was preserved;
- the properties were not weakened;
- the action was corrected to preserve both variables;
- all safety and liveness configs were rerun.

Run `37520577666` then completed successfully.

### What this evidence does not prove

It does not yet prove:
- full implementation correctness;
- cryptographic correctness;
- Bitcoin Core correctness;
- arbitrary crash/restart liveness;
- arbitrary watcher disagreement/reorg liveness;
- refund/redeem race convergence under all modeled schedules;
- replay isolation across a richer multi-trade model;
- liveness under permanent chain/network failure;
- production readiness.

G4 therefore remains open.


## Accepted fault-model run — 2026-10-06

- Workflow: Asset Exchange Formal Verification
- GitHub Actions run id: `37521050532`
- Source commit: `38f5bc2665822cdf039703eb8c5f54f10f539916`
- TLA+ tools: `1.7.4`
- SANY main model: PASS
- SANY fault model: PASS
- fault-safety TLC: PASS
- crash-recovery liveness TLC: PASS

### Fault-model metrics

| Scenario | Generated states | Distinct states | Depth | Result |
|---|---:|---:|---:|---|
| Fault safety | 2017 | 256 | 10 | PASS |
| Crash-after-broadcast reconciliation | 3 | 3 | 3 | PASS |

### Fault properties checked

- durable broadcast intent precedes the modeled chain effect;
- duplicate delivery cannot create a second modeled economic effect;
- a result cannot be recorded before the chain effect exists;
- replay authorization cannot authorize the other modeled trade;
- only one trade is authorized by the modeled signed authorization;
- an irreversible advance records that its authorizing chain evidence was CONSISTENT;
- recovery remains enabled across modeled crash/replay/evidence faults;
- after a crash with a durable intent and one existing chain effect, weakly fair restart/reconciliation eventually records the result without creating another effect.

This is a small abstract fault model. It does not replace implementation crash/reorg tests or prove arbitrary multi-trade behavior.
