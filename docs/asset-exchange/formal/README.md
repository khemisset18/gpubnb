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
- run-tlc.sh — runner that executes every config and records separate hashes/output;
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
- FeeDoesNotGateRecovery.

This list is only the first model slice. The G4 plan requires additional executable properties for:
- immutable terms;
- explicit replay isolation;
- crash idempotency;
- uncertain-chain blocking;
- principal recovery independent of fee collection;
- mode transition semantics;
- liveness/fairness.

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
TLC executed in repository CI: NOT YET.
G4 PASS: NO.


## Initial liveness scenarios

The runner checks three bounded liveness properties with explicit weak-fairness assumptions:

- cooperative settlement eventually reaches COMPLETED;
- an already-funded refundable leg eventually reaches REFUNDED while the Asset Exchange is unavailable, once chain time matures;
- an unblocked TRANSITION eventually activates its target mode.

These scenarios are deliberately separate from the unrestricted safety model. They do not assume progress under permanent chain halt, permanent network failure, or a user who never performs an action required by the scenario.

`AdvanceRefundTime` makes chain-time progress explicit. The recovery scenario starts with `exchangeAvailable = FALSE`, so refund liveness cannot depend on the marketplace API/frontend/workers.
