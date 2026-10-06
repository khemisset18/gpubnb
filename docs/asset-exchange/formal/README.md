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
Latest accepted integrated run: 37531780257 at commit 5f80ef3e11baa9867f3a84058ff342fcaa6b30f4.

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

The integrated run explicitly verifies UncertainChainStopsAdvance for both chain legs.

Additional terms-immutability model evidence:
- terms immutability: 156 generated / 32 distinct / depth 4 / queue 0;
- TermsImmutable: PASS within bounded model;
- FeeTermsImmutable: PASS within bounded model;
- LockUsesSignedTerms: PASS within bounded model;
- post-sign mutation attempts cannot change the signed snapshots: PASS;
- evidence artifact ID: 11444467368;
- evidence ZIP SHA-256: de674e7fa53768c0733bd682e20bcd44aa570efa81a86971540e0b8b2fb0838c.

Recovery-composition evidence at commit 6feac6056dc01afd04c831b96029d9d11001a054:
- composed recovery safety: 282 generated / 96 distinct / depth 8 / queue 0;
- composed outage liveness: 4 generated / 4 distinct / depth 4 / queue 0;
- Exchange unavailable + fee collector unavailable + KYC unavailable + mode TRANSITION still preserves recovery under explicit assumptions;
- HonestRecoveryPath: PASS within bounded model;
- RecoveryDuringMarketplaceStop: PASS within bounded model;
- evidence artifact ID: 11444128908;
- evidence ZIP SHA-256: cb8ab3cb4304a3eb231144099ebc1d775b467f76d959dfa44879215919ff4acd.

Expanded safety-bound evidence at commit bef36cb9f45bb130b0533d9aea39f6573d894255:
- MaxEpoch increased from 2 to 3 without weakening invariants;
- 521132 states generated / 46160 distinct / depth 24 / queue 0;
- no TLC error;
- evidence artifact ID: 11444334024;
- evidence ZIP SHA-256: e3218b721301ee67886b2b4677ccd99c3e298827d79cdaad3293bb37e6f835dc.

G4 PASS: NO — model-to-code traceability, broader composed fault bounds, further liveness assumptions review and independent formal review remain required.


## Initial liveness scenarios

The runner checks three bounded liveness properties with explicit weak-fairness assumptions:

- cooperative settlement eventually reaches COMPLETED;
- an already-funded refundable leg eventually reaches REFUNDED while the Asset Exchange is unavailable, once chain time matures;
- an unblocked TRANSITION eventually activates its target mode.

These scenarios are deliberately separate from the unrestricted safety model. They do not assume progress under permanent chain halt, permanent network failure, or a user who never performs an action required by the scenario.

`AdvanceRefundTime` makes chain-time progress explicit. The recovery scenario starts with `exchangeAvailable = FALSE`, so refund liveness cannot depend on the marketplace API/frontend/workers.
