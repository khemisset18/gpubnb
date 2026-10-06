# gpu.k.p2p — G4 Formal Verification Plan and State-Machine Contract v0

Status: FORMAL DESIGN / PRE-IMPLEMENTATION / NO REAL FUNDS

## 1. Purpose

This document defines the formal verification scope for gpu.k.p2p before any real settlement is allowed.

The formal model is intended to catch design failures that normal unit tests may miss:
- race conditions;
- duplicate delivery;
- crash/restart;
- stale workers;
- reorgs;
- refund/redeem races;
- mode transitions;
- double fill;
- recovery loss;
- fee-policy mutation.

TLA+ with TLC is the initial reference tool.

## 2. What the model proves and does not prove

The model can provide evidence that the abstract protocol satisfies selected invariants under stated assumptions.

It does NOT prove:
- implementation has no bugs;
- cryptographic primitives are correct;
- Bitcoin Core is correct;
- hardware wallets are correct;
- operators never misconfigure production;
- legal/compliance correctness.

Formal verification complements implementation tests, fuzzing, audits and operational controls.

## 3. Model boundaries

The initial model includes:

Actors:
- Maker
- Taker
- Exchange
- Worker
- Watcher
- RecoveryTool
- Admin

Abstract external systems:
- ChainA
- ChainB
- PostgreSQL durable state
- Redis ephemeral state
- policy epoch / operating mode

Excluded initially:
- exact Bitcoin script bytecode;
- exact fee arithmetic;
- cryptographic algorithms;
- UI rendering;
- networking packet details.

Those are covered by separate test vectors and implementation review.

## 4. Abstract trade states

TradeState is one of:

DRAFT
OPEN
RESERVED
TERMS_SIGNED
A_REFUND_READY
A_LOCK_BROADCAST
A_LOCK_CONFIRMED
B_REFUND_READY
B_LOCK_BROADCAST
B_LOCK_CONFIRMED
SECRET_REVEALED
REDEEMING
COMPLETED
REFUND_ELIGIBLE
REFUNDING
REFUNDED
REORG_HOLD
RECOVERY_REQUIRED
FAILED_SAFE

The executable model may collapse some intermediate states to control state-space size, but no collapsed transition may hide a fund-safety invariant.

## 5. Offer states

OfferState:

OPEN
RESERVED
CANCELLED
CONSUMED
EXPIRED

Critical property:
an offer may have at most one successful whole-fill consumption.

## 6. Operating modes

Mode:

CONFORMITE
SOUVERAIN
TRANSITION

Each mode has an integer epoch.

A transition:
1. enters TRANSITION;
2. increments/fences epoch;
3. blocks new offers/accepts/locks;
4. preserves active settlement and recovery;
5. activates target mode only after drain/safety checks.

No stale command from an earlier epoch may create a new lock.

## 7. Chain evidence abstraction

Each chain leg tracks:

UNSEEN
MEMPOOL
CONFIRMED
REORGED
SPENT_REDEEM
SPENT_REFUND
CONFLICTED

CONFIRMED is not permanent.

A reorg may move evidence back to REORGED/UNSEEN according to modeled depth.

## 8. Crash abstraction

Each service can nondeterministically:
- run;
- crash;
- restart.

Durable PostgreSQL data survives.

Redis may be lost entirely.

In-flight messages may:
- duplicate;
- delay;
- reorder;
- disappear before durable acknowledgement.

No safety property may rely on exactly-once delivery.

## 9. Network abstraction

The environment may nondeterministically:
- delay observations;
- reorder watcher evidence;
- present stale evidence;
- cause watcher disagreement.

The model does not assume instantaneous network propagation.

## 10. Primary safety invariants

INV-01 — NoDoubleFill

One offer cannot produce two distinct accepted/consumed trades.

INV-02 — TermsImmutable

Once final terms are signed, asset/network/amount/counterparty/protocol/fee policy/timeout policy cannot mutate.

INV-03 — NoUnsignedLock

No chain lock can be initiated unless required final terms signatures exist and are valid in the model.

INV-04 — TerminalExclusivity

A leg/trade cannot be terminally both COMPLETED and REFUNDED.

INV-05 — CrashIdempotency

Re-executing a durable command after crash cannot create a second logically distinct irreversible effect.

INV-06 — EpochFence

A command created under stale policy epoch cannot initiate a new lock after transition fencing.

INV-07 — RecoveryNeverDisabled

Emergency stop, quarantine or mode transition cannot disable an already-valid refund/redeem/recovery path.

INV-08 — ReplayIsolation

A signed authorization consumed for Trade X cannot authorize Trade Y.

INV-09 — UncertainChainStopsAdvance

If required chain evidence is REORGED/CONFLICTED/insufficient, no new dependent irreversible step occurs.

INV-10 — HonestRecoveryPath

Under stated timing/network assumptions, an honest participant with required wallet key and recovery bundle never loses both the original asset and all valid recovery paths.

INV-11 — FeeTermsImmutable

Fee rate, payer and recipient for accepted trade cannot be changed after final signed terms.

INV-12 — FeeCannotBlockPrincipalRecovery

Platform fee collection failure cannot prevent user principal refund/redeem.

INV-13 — CoreIndependent

Any Asset Exchange state, outage or KYC state cannot alter modeled GPUbnb Core availability/entitlement.

INV-14 — KYCScoped

KYC/compliance eligibility gates only new Exchange activity; it cannot erase existing cryptographic recovery.

## 11. Liveness properties

LIVE-01 — CooperativeCompletion

If both parties cooperate, chains progress, fees are sufficient and observations eventually arrive, the trade eventually reaches COMPLETED.

LIVE-02 — AbandonedTradeRefund

If the counterparty abandons after a valid refundable lock and chain time progresses, an honest user with recovery material can eventually reach REFUNDED.

LIVE-03 — CrashRecovery

If crashed services restart or independent recovery tooling remains available, a crash does not permanently prevent a valid terminal outcome.

LIVE-04 — TransitionCompletes

If no blocking active condition remains, TRANSITION eventually resolves to the target mode.

LIVE-05 — RecoveryDuringMarketplaceStop

Stopping new marketplace activity does not prevent eventual recovery of already locked funds.

## 12. Fairness assumptions

Liveness requires explicit fairness assumptions.

Examples:
- chain eventually produces blocks;
- valid sufficiently-fee-paying transaction can eventually propagate/mine;
- user eventually signs required recovery transaction;
- at least one usable observation path eventually returns;
- recovery tool remains available.

These assumptions must not be silently embedded in the model.

## 13. Accept/cancel race

The model must explore:

Maker cancels while Taker accepts.

Only valid outcomes:
- CANCELLED with no accepted trade; or
- RESERVED/CONSUMED for exactly one trade.

Forbidden:
- cancelled and consumed simultaneously;
- two takers accepted;
- acceptance after authoritative expiry.

PostgreSQL transactional compare-and-set/unique constraints are the intended implementation mechanism.

## 14. Duplicate worker delivery

The model repeatedly delivers the same command.

Examples:
- broadcast lock twice;
- mark confirmation twice;
- generate refund twice;
- process secret reveal twice.

Expected:
same logical effect, no duplicated irreversible obligation.

## 15. Crash-after-broadcast

Model sequence:

1. persist operation intent;
2. broadcast;
3. crash before recording result;
4. restart;
5. observe chain/mempool;
6. reconcile exact intended transaction.

Invariant:
restart does not create a different unsafe transaction simply because local completion record is missing.

## 16. Reorg model

The environment can:
- confirm a lock;
- allow dependent protocol progress;
- later reorg evidence within modeled unsafe depth.

The protocol must:
- enter REORG_HOLD where required;
- stop new dependent irreversible action;
- recompute evidence;
- retain refund/recovery.

No transition may treat a modeled non-final confirmation as immutable.

## 17. Refund/redeem race

At timeout boundary, both redeem and refund attempts may exist.

The model must ensure:
- chain semantics choose at most one spend of the same output;
- application converges to the observed valid spend;
- database cannot mark contradictory terminal results;
- recovery tooling detects already-spent output.

## 18. Fee subsystem modeling

Fee state is abstracted separately from principal.

FeeState:

NOT_APPLICABLE
PENDING
CLAIMABLE
COLLECTED
REFUNDABLE
REFUNDED

Critical rule:
principal terminal progress must not require FeeState=COLLECTED.

If conditional fee mechanism fails:
- platform may lose fee revenue;
- user principal recovery remains safe.

## 19. KYC modeling

KycStatus:

NOT_REQUIRED
PENDING
APPROVED
REJECTED
UNAVAILABLE

For CONFORMITE, policy may require APPROVED for NEW acceptance/lock.

For SOUVERAIN, deployment policy may return NOT_REQUIRED.

In all cases:
- existing redeem/refund/recovery actions are not erased by KycStatus transition.

Core auth is not part of KycStatus.

## 20. Recovery bundle modeling

Boolean/abstract facts:
- bundleGenerated;
- bundleValidated;
- bundleExported;
- userHasSigningKey.

For protocols requiring recovery artifact before funds lock:

LockBroadcast => bundleGenerated / bundleValidated / bundleExported

This is a formal invariant.

## 21. Recovery independence

Model removes:
- frontend;
- API;
- workers;
- Redis;
- KYC provider;
- Core.

If bundle + user key + chain access remain and refund becomes valid, a recovery transition remains reachable.

## 22. Admin controls

Admin may:
- stopNewOffers;
- stopNewAccepts;
- stopNewLocks;
- quarantineChain;
- beginModeTransition;
- activateFeePolicy.

Admin may NOT:
- force COMPLETED;
- forge user signature;
- remove a matured refund right;
- rewrite signed terms;
- redirect an already-signed fee recipient.

## 23. Fault injection matrix

The formal exploration should include combinations of:

F1 worker crash
F2 watcher crash
F3 API crash
F4 Redis loss
F5 duplicate command
F6 stale command
F7 reordered evidence
F8 reorg
F9 chain conflict
F10 policy epoch change
F11 KYC outage
F12 fee collector outage
F13 admin stops new locks
F14 recovery tool only
F15 counterparty disappears

State-space bounds will keep initial model finite.

## 24. Initial TLC bounds

First model should use deliberately small finite sets:
- one offer;
- maximum two competing takers;
- one trade winner;
- two abstract chains;
- a few confirmation levels;
- two epochs;
- finite fault booleans.

This is enough to expose structural races without creating unmanageable state explosion.

## 25. Model evolution

Stage M1:
- offer accept/cancel;
- double fill;
- policy epoch.

Stage M2:
- two-leg settlement;
- crashes;
- duplicate delivery.

Stage M3:
- reorg;
- refund/redeem race;
- recovery bundle.

Stage M4:
- fee subsystem;
- KYC state;
- mode transition.

Stage M5:
- liveness/fairness analysis;
- larger bounds;
- symbolic model checking with an additional tool if useful.

## 26. TLC outputs as security evidence

CI artifacts should retain:
- exact .tla file;
- .cfg file;
- tool version;
- constants;
- invariant list;
- state count;
- distinct states;
- depth;
- runtime;
- result;
- counterexample trace when failure occurs.

A green status without configuration metadata is insufficient evidence.

## 27. Counterexample handling

Any invariant failure:
1. preserve exact trace;
2. map abstract action to architecture;
3. determine whether model or design is wrong;
4. update protocol/documentation;
5. add regression scenario;
6. rerun complete model.

Do not simply weaken the invariant to make TLC green.

## 28. Deadlocks

Unexpected deadlocks are failures unless explicitly modeled as safe terminal/quiescent states.

Safe waiting states must be documented.

## 29. Model-to-code traceability

Future implementation should map:
- TLA+ action -> command/handler;
- TLA+ variable -> durable data concept;
- invariant -> automated integration/property test;
- fault transition -> chaos test.

Formal spec and production code must not evolve independently.

## 30. Security review requirements

Before G4 pass:
- another reviewer reads model;
- assumptions reviewed;
- invariants reviewed against G2/G3;
- counterexample interpretation checked;
- no critical behavior hidden in uninterpreted helper action;
- liveness assumptions explicitly documented.

## 31. G4 PASS requirements

Required:
- executable TLA+ model;
- TLC configuration;
- all mandatory invariants encoded;
- representative crash/reorg/fault actions;
- no invariant violation within defined model bounds;
- liveness properties checked where tractable;
- counterexample regression process established;
- model checked into CI;
- formal results archived.

G4 remains BLOCKED until these are executed.

## 32. Current status

Formal contract: ACTIVE / PRE-PRODUCTION.
Executable model: PRESENT.
TLC safety run: PASS for current bounded model.
Initial liveness scenarios: PASS for cooperative completion, recovery while Exchange is unavailable, and unblocked mode transition under explicit weak-fairness assumptions.
Latest accepted formal run: GitHub Actions run 37520577666 at source commit 2746c6f890b6e0eba70c0e992a04d09e1a533dcf.
Latest bounded state counts:
- safety: 208484 generated / 19360 distinct / depth 21;
- cooperative completion: 40 generated / 13 distinct / depth 13;
- recovery: 4 generated / 4 distinct / depth 4;
- transition: 2 generated / 2 distinct / depth 2.

A counterexample/model defect was discovered in the first liveness attempt: BroadcastALock failed to preserve the newly introduced refundMatured/exchangeAvailable variables, causing TLC to expose undefined state. The model was corrected without weakening any invariant or liveness property and rerun from clean CI evidence.

G4 overall: STILL BLOCKED pending richer executable modeling of crash idempotency, replay isolation, uncertain-chain blocking, refund/redeem race, and larger/fault-combination liveness bounds plus independent review.
Real funds: FORBIDDEN.
Mainnet: FORBIDDEN.
