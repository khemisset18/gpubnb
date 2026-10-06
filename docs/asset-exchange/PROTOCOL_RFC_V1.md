# gpu.k.p2p — PROTOCOL_RFC_V1: UTXO HTLC Settlement Reference

Status: G2 DRAFT / REGTEST ONLY / NO REAL FUNDS / NOT PRODUCTION AUTHORIZED

## 1. Purpose

This RFC defines the first reference settlement protocol for gpu.k.p2p.

It is intentionally conservative.

The protocol name is:

GPUBNB-ASSET-EXCHANGE-UTXO-HTLC-V1

This RFC defines:
- canonical signed trade terms;
- chain capability requirements;
- a reference P2WSH HTLC construction for Bitcoin regtest;
- lock/redeem/refund roles;
- state-machine transitions;
- timeout ordering requirements;
- fee and replacement rules;
- watcher evidence;
- crash recovery;
- replay protection;
- safety invariants;
- required tests.

This RFC does NOT authorize:
- Mainnet;
- real funds;
- DOGE/LTC/BCH production support;
- XMR;
- EVM;
- partial fills;
- custodial keys.

## 2. Security goals

The protocol must ensure, under explicitly stated network and timing assumptions:

1. signed trade terms cannot be mutated;
2. one whole-fill offer cannot settle twice;
3. no server private key is required;
4. each party has a deterministic recovery path;
5. service crashes do not duplicate irreversible actions;
6. a trade cannot be declared complete from UI/chat/database state alone;
7. stale/replayed signatures cannot authorize another trade;
8. chain uncertainty blocks new irreversible actions;
9. recovery remains available during quarantine/mode transition;
10. Core GPUbnb availability is independent.

## 3. Non-goals

V1 does not attempt:
- universal atomicity across arbitrary chains;
- perfect fairness under arbitrary network partition;
- hidden transaction graph;
- privacy equal to Monero;
- instant settlement;
- zero-confirmation settlement;
- cross-chain smart-contract abstraction;
- liquidity-pool behavior;
- partial fills.

## 4. Chain profile requirement

A UTXO chain is eligible only if a reviewed ChainProfile proves the capabilities required by the protocol.

Minimum fields:

ChainProfile {
  profile_version
  chain_id
  network_id
  reference_node
  reference_node_version_range
  genesis_hash
  script_capabilities
  locktime_semantics
  sequence_semantics
  transaction_id_semantics
  witness_or_equivalent_support
  sighash_rules
  standardness_policy
  replacement_policy
  package_policy
  relay_fee_policy
  dust_policy
  rpc_profile
  confirmation_policy_id
  reorg_policy_id
  fee_policy_id
  security_status
}

No chain is accepted based on name or symbol.

## 5. Initial chain status

BITCOIN REGTEST:
- reference implementation target for protocol mechanics;
- eligible for G5 implementation testing after this RFC is reviewed.

BITCOIN TESTNET/SIGNET:
- blocked until regtest test suite passes.

BITCOIN MAINNET:
- forbidden until G9.

DOGE/LTC/BCH:
- registry/research only until separate ChainProfiles pass review.

XMR:
- outside this RFC.

## 6. Canonical trade identity

Trade identifiers are globally unique random identifiers.

Required fields:

TradeIdentity {
  protocol_domain
  protocol_version
  trade_id
  offer_id
  maker_subject
  taker_subject
  created_at
  expires_at
  policy_epoch
  deployment_id
}

trade_id MUST NOT be derived only from mutable public data.

## 7. Canonical asset identity

Each asset leg must bind:

AssetIdentity {
  chain_id
  network_id
  asset_type
  asset_id
  decimals
}

For native BTC:
- asset_type = NATIVE
- asset_id = BTC_NATIVE

Symbols and logos are display metadata only.

## 8. Atomic integer amounts

Amounts are integer atomic units.

Forbidden:
- floating point;
- locale-dependent decimal parsing;
- scientific notation in signed payloads;
- implicit rounding.

Display conversion occurs only at UI boundary.

## 9. Canonical serialization

Security-sensitive signed structures require deterministic serialization.

Properties:
- field order defined;
- exact UTF-8;
- integer-only numeric representation;
- no duplicate keys;
- no NaN/Infinity;
- no insignificant-field ambiguity;
- unknown critical fields rejected;
- explicit protocol version.

The implementation format may be deterministic CBOR, canonical JSON profile, or another reviewed deterministic encoding.

Final choice must be frozen before implementation.

## 10. Signature domains

Separate domains:

GPUBNB:ASSET-EXCHANGE:OFFER:v1
GPUBNB:ASSET-EXCHANGE:ACCEPT:v1
GPUBNB:ASSET-EXCHANGE:CANCEL:v1
GPUBNB:ASSET-EXCHANGE:TERMS:v1
GPUBNB:ASSET-EXCHANGE:OWNERSHIP:v1
GPUBNB:ASSET-EXCHANGE:RECOVERY:v1

A signature from one domain is invalid in every other domain.

## 11. Signed offer

SignedOfferV1 {
  domain
  protocol_version
  offer_id
  maker
  give_asset
  give_amount_atomic
  want_asset
  want_amount_atomic
  expiry
  nonce
  allowed_settlement_protocols
  confirmation_policy_constraints
  fee_policy_constraints
  policy_epoch
}

Maker signs canonical bytes.

Server verifies before persistence.

## 12. Acceptance

SignedAcceptV1 {
  domain
  protocol_version
  offer_id
  trade_id
  taker
  offer_hash
  accepted_at
  expiry
  nonce
  policy_epoch
}

Acceptance succeeds only inside one PostgreSQL transaction that:
- verifies offer OPEN;
- verifies not expired;
- verifies policy still permits trade;
- atomically reserves/consumes the offer;
- stores immutable offer_hash;
- stores accept signature.

## 13. Final signed terms

Before any lock:

SignedTermsV1 {
  domain
  protocol_version
  trade_id
  offer_hash
  maker
  taker
  leg_a
  leg_b
  settlement_protocol_id
  settlement_protocol_version
  confirmation_policy_a
  confirmation_policy_b
  fee_policy_a
  fee_policy_b
  timeout_policy_id
  recovery_policy_id
  policy_epoch
  created_at
  expires_at
}

Both parties sign identical canonical bytes.

Any difference invalidates terms.

## 14. No mutable settlement fields

After both signatures, the following cannot change:
- asset;
- network;
- amount;
- counterparty;
- lock script parameters;
- destination keys;
- confirmation policy;
- timeout policy;
- settlement protocol;
- fee-policy constraints.

A change requires a new trade/versioned renegotiation before lock.

## 15. Reference HTLC primitive

Bitcoin-regtest reference output uses P2WSH with a script conceptually equivalent to:

OP_IF
  OP_SHA256 <secret_hash> OP_EQUALVERIFY
  <redeem_pubkey> OP_CHECKSIG
OP_ELSE
  <refund_locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
  <refund_pubkey> OP_CHECKSIG
OP_ENDIF

This is a reference construction, not yet production-approved script bytecode.

Final byte-level script must be specified with test vectors and reviewed independently.

## 16. Secret

The initiating protocol side creates a uniformly random 32-byte secret S.

H = SHA256(S)

Requirements:
- cryptographically secure RNG;
- exactly specified length;
- never logged;
- never placed in URLs;
- encrypted at rest if local persistence is required;
- recovery design specifies who must possess S and when.

No server-generated secret is accepted if doing so would make the server custodial or a unilateral fund authority.

## 17. Key roles

For each HTLC leg:

redeem_pubkey:
- key controlled by the counterparty that may redeem with S.

refund_pubkey:
- key controlled by the original funder.

gpu.k.p2p server owns neither private key.

## 18. Lock transaction

The lock transaction creates the exact reviewed HTLC output.

Before user signature:
- inputs known;
- output script independently reconstructed;
- amount exact;
- fee checked;
- change checked;
- network checked;
- locktime/sequence checked;
- no unrelated outputs;
- terms hash checked.

User signs locally.

## 19. Lock transaction txid stability

If a pre-signed refund depends on the lock transaction txid before lock confirmation, txid malleability must be excluded by construction.

For Bitcoin reference implementation:
- funding inputs used for this flow must satisfy the reviewed non-malleability policy;
- legacy/malleable funding paths are rejected unless the protocol has another safe refund construction.

Do not assume txid stability merely because a wallet produced a transaction.

## 20. Refund transaction

Where the chosen construction requires pre-signing, the refund transaction MUST be prepared and validated before broadcasting the corresponding lock.

Refund validation:
- spends exact expected HTLC output;
- refund path selected;
- correct nLockTime;
- compatible input nSequence;
- correct refund destination;
- acceptable fee strategy;
- no unrelated outputs;
- user holds all signatures/material needed for later recovery.

No lock broadcast before refund readiness condition is satisfied.

## 21. Redeem transaction

Redeem spends the HTLC using:
- valid signature for redeem_pubkey;
- S such that SHA256(S)=H;
- redeem script branch.

Before signing:
- exact outpoint;
- exact destination;
- fee policy;
- secret hash;
- network;
- trade ID mapping
must be verified.

## 22. Secret disclosure

The protocol must define exactly which confirmed/on-chain event reveals S.

Watchers must extract S only from a transaction that:
- spends the expected outpoint;
- satisfies the expected script path;
- is on the expected chain/network;
- has required evidence state.

Never accept a secret from:
- chat;
- WebSocket message;
- counterparty API field;
- unauthenticated external service.

## 23. Two-leg settlement abstraction

Leg A and Leg B each have:
- lock;
- confirmation;
- redeem;
- refund.

Timeout ordering must ensure the party who learns S later retains enough time to redeem safely before the corresponding refund becomes valid.

No equal-timeout shortcut.

## 24. Timeout policy

TimeoutPolicyV1 defines:

- chain profile A;
- chain profile B;
- lock A confirmation threshold;
- lock B confirmation threshold;
- redeem confirmation/reaction assumptions;
- watcher delay bound;
- user reaction bound;
- fee-bump delay budget;
- reorg margin;
- safety margin;
- refund deadline semantics.

Timeout numbers are NOT hard-coded in this RFC.

They must be produced by a separate reviewed policy with empirical/regtest evidence.

## 25. Timeout ordering invariant

Let T_long be the refund deadline for the first-funded leg.
Let T_short be the refund deadline for the second-funded leg.

Required qualitative invariant:

T_long > T_short + worst_case_safe_reaction_margin

The reaction margin must include:
- observation delay;
- confirmation policy;
- reorg buffer;
- transaction construction;
- signer interaction where needed;
- broadcast;
- fee bump;
- expected block variability.

## 26. No wall-clock-only safety

UI may display estimated time.

Protocol validity must derive from actual chain semantics:
- height;
- median time past;
- relative sequence age;
- chain-specific rules.

Local browser clock is never authoritative.

## 27. Fee policy

FeePolicyV1 must define:
- estimator sources;
- minimum/maximum bounds;
- target confirmation urgency;
- replacement capability;
- CPFP/package assumptions;
- emergency refund policy;
- fee reserve strategy.

No fee policy = no SECURE status.

## 28. Fee reserve

The protocol must not lock the entire spendable balance if doing so makes refund/redeem unbroadcastable under foreseeable fee increase.

Implementation must define how sufficient fee budget remains available.

This may involve:
- dedicated fee inputs;
- fee-adjustable transaction construction;
- CPFP-capable output;
- other reviewed mechanism.

Exact mechanism remains BLOCKED pending dedicated design.

## 29. Replacement policy

Unconfirmed txids are not treated as immutable.

Watcher tracks:
- logical transaction role;
- known txid/wtxid candidates;
- conflicts/replacements;
- active mempool candidate;
- confirmed candidate.

Protocol state references logical operation + outpoint lineage, not a naive one-txid assumption.

## 30. Current Bitcoin policy awareness

The implementation must support a versioned policy adapter because Bitcoin Core mempool replacement rules evolve.

Current reference behavior includes broad replacement policy and cluster-aware constraints.

No permanent protocol invariant may depend on obsolete opt-in signaling assumptions.

## 31. Pinning threat

Before production, tests must show that a malicious counterparty cannot practically strand:
- refund;
- redeem;
- required fee bump
using mempool/package/pinning behavior within the protocol's assumptions.

If not proven:
SECURE status denied.

## 32. Preflight

Before broadcast, where supported:
- decode independently;
- verify script/outpoint/amount;
- verify fee;
- verify locktime/sequence;
- run local policy preflight such as testmempoolaccept;
- compare with signed intent.

Preflight success is not finality or propagation proof.

## 33. Broadcast

Broadcast through controlled chain adapter/RPC gateway.

Record:
- operation_id;
- exact raw transaction hash;
- expected txid/wtxid;
- source service;
- time;
- RPC source result.

Never log private signing secrets.

## 34. Broadcast idempotency

Every broadcast action has durable operation_id.

Re-running the same job:
- reuses exact transaction bytes where safe;
- checks network state first;
- does not construct a new conflicting transaction automatically.

## 35. Crash boundary

For every fund-critical broadcast:

A. persist PRE_BROADCAST_INTENT
B. fsync/commit durable state
C. broadcast
D. observe network
E. persist observed result

Crash at A/B/C/D/E must have deterministic recovery behavior.

## 36. Crash-after-broadcast recovery

On restart:
- load exact intended transaction bytes/hash;
- query multiple observations where required;
- check mempool/chain/conflicts;
- reconcile to SEEN/CONFIRMED/REPLACED/UNKNOWN;
- never blindly rebroadcast a different construction.

## 37. Chain evidence model

ChainEvidence {
  chain_id
  network_id
  source_id
  tip_hash
  tip_height
  observed_txid
  block_hash?
  block_height?
  confirmations
  mempool_status
  conflict_status
  observed_at
}

Evidence is append-only/auditable.

## 38. Watcher trust

No single watcher has unilateral financial authority.

Critical transitions require:
- configured evidence policy;
- source freshness;
- network/genesis match;
- conflict checks;
- confirmation threshold.

Where multiple sources disagree:
- state becomes uncertain;
- no new irreversible step;
- recovery paths remain monitored.

## 39. State machine

High-level states:

DRAFT
OFFER_OPEN
RESERVED
TERMS_PENDING
TERMS_SIGNED
PREPARING
A_REFUND_READY
A_LOCK_READY
A_LOCK_BROADCAST
A_LOCK_SEEN
A_LOCK_CONFIRMED
B_REFUND_READY
B_LOCK_READY
B_LOCK_BROADCAST
B_LOCK_SEEN
B_LOCK_CONFIRMED
REDEEM_PHASE
SECRET_REVEALED
A_REDEEM_BROADCAST
B_REDEEM_BROADCAST
SETTLEMENT_OBSERVING
COMPLETED
REFUND_PENDING
REFUND_ELIGIBLE
REFUND_BROADCAST
REFUNDED
REORG_HOLD
RECOVERY_REQUIRED
FAILED_SAFE

Exact transition table must be implemented from machine-readable specification later.

## 40. State authority

PostgreSQL durable event log is application truth about protocol orchestration.

Blockchain is truth about blockchain events.

Redis/WebSocket/browser are never authoritative.

## 41. State transition record

Every transition records:
- event_id;
- trade_id;
- previous_state;
- new_state;
- actor/service identity;
- protocol version;
- policy epoch;
- evidence references;
- idempotency key;
- timestamp;
- config hash.

## 42. Expected-state mutation

Every critical mutation includes expected prior state.

If actual state differs:
- fail;
- reload;
- reconcile.

Never "force state" in ordinary runtime.

## 43. Duplicate delivery

Workers are assumed at-least-once.

Every command must be idempotent.

Duplicate:
- prepare;
- broadcast;
- observe;
- refund
cannot duplicate unsafe effects.

## 44. Reorg handling

When supporting evidence is reorged:
- append REORG event;
- enter REORG_HOLD or a defined prior-safe state;
- recompute confirmations;
- stop dependent new irreversible action;
- continue observation;
- preserve refund/recovery.

Never silently decrement confirmations without state-machine consequence.

## 45. Completion

COMPLETED requires protocol-defined final evidence for both asset legs.

Not sufficient:
- DB flag;
- API callback;
- user click;
- chat;
- one explorer;
- mempool presence.

## 46. Refund

REFUND_ELIGIBLE derives from chain-enforced timeout semantics, not browser/server timer alone.

Before refund broadcast:
- verify lock output unspent;
- verify refund condition matured;
- verify exact script;
- verify fee strategy;
- verify no conflicting confirmed redeem.

## 47. Refund during outage

Recovery documentation/tooling must let user refund when:
- main frontend unavailable;
- API unavailable;
- normal workers disabled.

G3 will define encrypted recovery bundles and offline/alternate recovery procedure.

## 48. Quarantine behavior

If Bitcoin profile becomes QUARANTINED:
- no new offers optionally;
- no new accepts;
- no new lock commitments;
- existing observations continue;
- redeem continues where safe;
- refund continues where safe;
- recovery continues.

## 49. Mode transition behavior

CONFORMITE <-> SOUVERAIN transition:
- blocks new trading/locking;
- increments epoch;
- stale workers rejected;
- existing recovery rights unchanged.

KYC policy never changes script-level refund rights.

## 50. Wallet boundary

Signing occurs:
- browser wallet;
- hardware wallet;
- external wallet;
- local Wallet Agent.

Server never receives:
- seed;
- raw private key;
- wallet password.

## 51. Bitcoin ownership proof

For compatible Bitcoin address/script types, BIP322 is preferred for ownership proof.

Ownership proof is separate from:
- terms signature;
- transaction signature;
- proof of current balance.

## 52. WYSIWYS signing

Before any signature, user sees:
- trade ID;
- BTC regtest network;
- amount;
- role (lock/redeem/refund);
- destination/script meaning;
- fee;
- timeout/refund semantics;
- protocol version.

If parsed transaction differs from displayed intent:
reject.

## 53. Recovery material

G3 must define minimum material such as:
- signed terms;
- protocol version;
- chain profiles;
- HTLC script/redeem script;
- outpoints;
- refund transaction or reconstruction data;
- secret or encrypted secret only where required;
- key references, never server-held private keys;
- deadlines;
- verification hashes.

Bundle integrity and encryption are mandatory.

## 54. Privacy

Do not unnecessarily correlate:
- Core identity;
- IP;
- BTC addresses;
- trade history;
- KYC identity.

Broadcast source privacy must be evaluated.

No analytics SDK in settlement/recovery path without explicit review.

## 55. Regtest topology

Initial test environment:
- isolated bitcoind regtest nodes;
- independent watcher processes;
- controllable mining;
- ability to partition peers;
- ability to invalidate/reconsider blocks;
- controllable fee/mempool settings.

Regtest is for deterministic failure testing, not proof of Mainnet behavior.

## 56. Mandatory regtest scenarios

1. happy-path lock/redeem;
2. maker disappears before first lock;
3. maker disappears after first lock;
4. taker disappears before second lock;
5. taker disappears after second lock;
6. redeem just before refund eligibility;
7. refund immediately after maturity;
8. crash before lock broadcast;
9. crash after broadcast before DB update;
10. duplicate broadcast job;
11. Redis deleted;
12. API killed;
13. watcher killed;
14. stale watcher;
15. malicious RPC response;
16. conflicting transaction;
17. RBF replacement;
18. high-fee environment;
19. mempool eviction;
20. shallow reorg before dependent action;
21. reorg after apparent confirmation;
22. refund transaction initially rejected for fee;
23. restart from durable event log;
24. mode transition mid-trade;
25. asset quarantine mid-trade.

## 57. Forced reorg testing

Regtest suite must use node controls such as block invalidation/reconsideration to create deterministic reorg cases.

Assertions:
- dependent action pauses;
- confirmation evidence rolls back safely;
- no duplicate spend action;
- refund remains recoverable.

## 58. Property tests

Generate randomized:
- amounts;
- fee levels;
- block delays;
- worker duplicates;
- observation orderings;
- crash points.

Assert invariants remain true.

## 59. Fuzz targets

- canonical terms parser;
- PSBT parser;
- HTLC script parser;
- chain RPC response parser;
- state transition command;
- event replay;
- recovery bundle parser.

## 60. Formal model

TLA+ or equivalent model includes:
- two parties;
- two abstract UTXO chains;
- nondeterministic delays;
- crashes;
- duplicate messages;
- reorg observations;
- refunds;
- mode transition.

Safety invariants:

INV-01 no double fill.
INV-02 immutable signed terms.
INV-03 no lock from unsigned terms.
INV-04 no terminal COMPLETED and REFUNDED contradiction.
INV-05 crash does not duplicate irreversible action.
INV-06 stale epoch cannot create new lock.
INV-07 recovery not disabled by quarantine/mode transition.
INV-08 old signature cannot authorize new trade.
INV-09 chain uncertainty cannot advance irreversible dependency.
INV-10 honest participant preserves a recovery path under stated assumptions.

## 61. Threat review checklist

Before G2 PASS:
- HTLC bytecode independently reviewed;
- txid malleability reviewed;
- SIGHASH reviewed;
- refund presigning reviewed;
- RBF reviewed;
- pinning reviewed;
- CPFP/package behavior reviewed;
- timeout math reviewed;
- reorg model reviewed;
- wallet compatibility reviewed;
- secret lifecycle reviewed;
- crash boundaries reviewed;
- recovery feasibility reviewed.

## 62. Explicit BLOCKED items

The following remain BLOCKED:
- production timeout constants;
- production fee reserve design;
- final RBF/CPFP policy;
- production HTLC bytecode;
- exact signer compatibility matrix;
- second-chain adapter;
- real cross-chain pair;
- Mainnet.

This is intentional.

## 63. Implementation order

After review:

Phase A:
- pure canonical data types;
- deterministic serialization;
- signature verification test vectors;
- state-machine model;
- no chain broadcast.

Phase B:
- Bitcoin regtest transaction parser/builder;
- HTLC test vectors;
- refund/redeem builder;
- no web UI required.

Phase C:
- regtest watcher;
- evidence store;
- crash recovery;
- chaos tests.

Phase D:
- wallet signing integration;
- Security Center visibility;
- recovery tooling.

Only after all above:
- public test environment.

## 64. Release status taxonomy

RESEARCH:
design under study.

REGTEST:
works only in deterministic local test environment.

TESTNET:
public non-real-value chain testing.

REVIEWED:
internal security requirements passed but no Mainnet authorization.

CANARY:
limited real-value deployment after external review.

SECURE:
reserved for explicitly approved production chain/profile/protocol/version.

No marketing may collapse these states.

## 65. Compatibility versioning

Protocol version and ChainProfile version are independent.

A new Bitcoin Core policy profile does not automatically change old signed trade terms.

Active trades pin:
- protocol version;
- chain profile version;
- fee policy;
- confirmation policy;
- timeout policy.

## 66. Node-version policy

Each supported environment defines:
- minimum node version;
- maximum tested version or tested set;
- required RPCs;
- prohibited configuration;
- policy assumptions.

Unknown node version => not automatically trusted.

## 67. RPC authentication

Bitcoin node RPC:
- private network/loopback;
- authenticated;
- no public exposure;
- least-privilege deployment boundary;
- response limits.

RPC credentials belong only to RPC gateway/watcher components that require them.

## 68. No RPC wallet custody

Production Asset Exchange servers must not import user private keys into Bitcoin Core wallet.

Reference node is observer/broadcaster, not custodian.

## 69. Incident behavior

If a settlement vulnerability is discovered:
- disable new locks immediately;
- preserve observation;
- preserve redeem/refund/recovery;
- quarantine affected protocol version;
- publish operator guidance;
- do not silently migrate active trade semantics.

## 70. RFC acceptance criteria

This RFC may move from DRAFT to REVIEWED only when:
- independent internal review complete;
- byte-level script appendix added;
- deterministic test vectors added;
- timeout-policy methodology added;
- fee/pinning design added;
- formal model executed;
- regtest suite demonstrates required failures safely.

## 71. Current status

Protocol architecture: DRAFTED.
Bitcoin regtest adapter: NOT IMPLEMENTED.
HTLC bytecode appendix: NOT FINAL.
Formal model: NOT IMPLEMENTED.
Recovery bundle: NOT SPECIFIED.
Testnet: FORBIDDEN.
Mainnet: FORBIDDEN.
Real funds: FORBIDDEN.
