# gpu.k.p2p Formal Model Runner

Status: PRE-IMPLEMENTATION / NO REAL FUNDS

## Purpose

This directory contains the initial TLA+ model and reproducible TLC runner for G4.

Files:
- AssetExchangeV1.tla — executable abstract safety model plus bounded liveness scenarios;
- AssetExchangeV1.cfg — unrestricted safety-model configuration;
- AssetExchangeV1.cooperative.cfg — cooperative-completion liveness scenario;
- AssetExchangeV1.recovery.cfg — refund/recovery liveness with Exchange unavailable;
- AssetExchangeV1.transition.cfg — mode-transition completion liveness scenario;
- AssetExchangeFaultsV1.tla — crash idempotency, replay isolation and uncertain-evidence fault model;
- AssetExchangeSpendRaceV1.tla — refund/redeem race and terminal convergence model;
- AssetExchangeTermsV1.tla — signed business/fee terms immutability model;
- run-tlc.sh plus dedicated fault/race/terms runners — reproducible bounded model checks;
- evidence/ — generated verification evidence, not committed by default unless explicitly reviewed.

## Trust rule

Do not use an unpinned "latest" tool artifact as release evidence.

For every recorded G4 run:
1. download TLA+ Tools from an approved source;
2. record the exact tool version;
3. compute and record SHA-256 of tla2tools.jar;
4. retain the model/config hashes;
5. retain complete TLC output.

The official TLA+ project documents command-line TLC usage with Java 11+.

## Run

Example:

    export TLA2TOOLS_JAR=/secure/tools/tla2tools.jar
    ./run-tlc.sh

The runner does not download tooling automatically.

This is intentional:
- avoids curl-pipe-execute patterns;
- avoids mutable download aliases;
- allows CI to verify the artifact before execution.

## Required invariants

The cfg currently asks TLC to check:
- TypeOK;
- NoDoubleFill;
- NoUnsignedLock;
- RecoveryBeforeLock;
- EpochFence;
- RecoveryNeverDisabled;
- CoreIndependent;
- CompletedNotRefunded;
- RefundedNotCompleted;
- KycCannotDisableRecovery;
- FeeDoesNotGateRecovery;
- CompletedRequiresRedeems;
- CrossDeploymentReplayBlocked;
- UncertainChainStopsAdvance.

Dedicated bounded models additionally check:
- CrashIdempotency;
- ReplayIsolation;
- crash-after-broadcast reconciliation;
- refund/redeem race exclusivity and convergence;
- TermsImmutable;
- FeeTermsImmutable.

G4 still requires richer composition/fault bounds and independent review; bounded model success is not production proof.

## Evidence acceptance

A run is not accepted merely because exit code is zero.

Review:
- tool hash;
- model hash;
- config hash;
- number of generated states;
- distinct states;
- search depth;
- invariant list;
- warnings;
- liveness configuration;
- whether state-space bounds were sufficient;
- whether any behavior was accidentally omitted.

## Counterexamples

If TLC reports a violation:
- preserve full log;
- do not weaken the invariant merely to pass;
- map the trace back to the protocol;
- fix the model/design;
- add regression coverage;
- rerun from clean evidence.

## Current status

Model present: YES.
Runner present: YES.
TLC executed in repository CI: YES.
Safety bounded model: PASS.
Initial liveness scenarios: PASS under explicit weak-fairness assumptions.
Latest accepted integrated run before terms-immutability extension: 37531026000 at commit f6aa4cc5d3882d7e74de1a52c527a9f8f988a50f.

Accepted evidence from that run:
- main safety: 296444 generated / 26560 distinct / depth 22 / queue 0;
- cooperative liveness: 40 / 13 / depth 13;
- recovery liveness: 4 / 4 / depth 4;
- transition liveness: 2 / 2 / depth 2;
- fault safety: 2017 / 256 / depth 10;
- crash reconciliation: 3 / 3 / depth 3;
- spend-race safety: 32 / 21 / depth 7;
- spend-race convergence: 7 / 7 / depth 4;
- all scenarios exit_status=0 with no TLC error;
- evidence artifact ID: 11444416474;
- evidence ZIP SHA-256: db3540e5eb88d02f537a5002c7d885cdd0406790764dcf466f0dc7ac5aa12407.

The same run explicitly verifies UncertainChainStopsAdvance for both chain legs.

G4 PASS: NO — terms immutability requires its new TLC run, and richer composed fault/replay bounds plus independent review remain required.


## Initial liveness scenarios

The runner checks three bounded liveness properties with explicit weak-fairness assumptions:

- cooperative settlement eventually reaches COMPLETED;
- an already-funded refundable leg eventually reaches REFUNDED while the Asset Exchange is unavailable, once chain time matures;
- an unblocked TRANSITION eventually activates its target mode.

These scenarios are deliberately separate from the unrestricted safety model. They do not assume progress under permanent chain halt, permanent network failure, or a user who never performs an action required by the scenario.

`AdvanceRefundTime` makes chain-time progress explicit. The recovery scenario starts with `exchangeAvailable = FALSE`, so refund liveness cannot depend on the marketplace API/frontend/workers.
