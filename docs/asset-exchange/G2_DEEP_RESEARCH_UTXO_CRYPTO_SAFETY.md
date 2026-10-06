# gpu.k.p2p — G2 Deep Research Memo: UTXO Settlement and Cryptographic Safety v0

Status: RESEARCH MEMO / PRE-PROTOCOL / NO REAL FUNDS

## 1. Purpose

This memo records the security research that must constrain G2 protocol design.

It is not a settlement specification.
It is not an implementation authorization.
It is not proof that any chain is production-ready.

Primary research targets:
- Bitcoin-family UTXO locks and refunds;
- signed ownership proofs;
- PSBT coordination;
- mempool and relay policy;
- fee-bumping and pinning;
- reorg/finality assumptions;
- crash/restart/rebroadcast behavior;
- Monero/XMR atomic-swap caution;
- recovery requirements;
- formal safety properties.

## 2. Research conclusion

The key primitives exist, but composing them safely is the hard problem.

A secure swap cannot be claimed merely because:
- a chain supports CHECKLOCKTIMEVERIFY;
- a chain supports CHECKSEQUENCEVERIFY;
- a wallet can sign a PSBT;
- a node says testmempoolaccept=true;
- a transaction is in one mempool;
- an explorer shows one confirmation.

Safety depends on the entire protocol state machine, timeout ordering, fee strategy, reorg policy,
signing intent, replay protection, crash recovery and availability of refund/redeem paths.

## 3. Bitcoin primitives verified

### BIP65 / CHECKLOCKTIMEVERIFY
Provides consensus-enforced absolute locktime conditions.

Security implication:
- useful for refund deadlines;
- height/time type must be handled exactly;
- input sequence semantics must be compatible with the locktime path;
- local wall-clock assumptions are insufficient.

### BIP68 / relative nSequence
Provides consensus-enforced relative locktime after the spent output confirms.

Security implication:
- can express delays relative to confirmation;
- semantics differ between block-based and time-based mode;
- time mode uses median-time-past semantics and fixed granularity;
- transaction version/sequence details are critical.

### BIP112 / CHECKSEQUENCEVERIFY
Makes relative sequence constraints available to script.

Security implication:
- useful for staged recovery paths;
- incorrect type/sequence construction can make a branch unspendable.

### BIP174 / PSBT
Provides a standardized partially signed transaction container.

Security implication:
- useful for offline/hardware/external signing;
- the signer must still validate complete transaction intent;
- PSBT extensibility means unknown fields/version behavior must be handled conservatively.

### BIP322 / generic signed messages
Provides a standard path for message ownership proofs using Bitcoin script semantics.

Security implication:
- preferred over ad-hoc "sign message" schemes for supported Bitcoin ownership proofs;
- ownership proof is not proof of solvency, future control, or agreement to settlement terms.

## 4. No custom cryptography

Do not invent:
- new hash functions;
- new signature schemes;
- custom adaptor-signature constructions;
- homegrown encryption modes;
- custom RNG;
- undocumented cross-curve proofs.

New cryptographic constructions require independent expert review and test vectors.

Protocol domain separation is application design, but cryptographic primitives themselves must be
standard and reviewed.

## 5. Canonical signed terms

Every signed offer/accept/settlement intent must bind at least:
- protocol identifier;
- protocol version;
- message type;
- unique offer/trade identifier;
- nonce;
- expiry;
- maker/taker identity reference;
- canonical give asset;
- canonical want asset;
- atomic integer amounts;
- exact networks;
- confirmation policy identifier;
- settlement protocol identifier/version;
- fee-policy identifier;
- mode/policy epoch where relevant.

No symbol-only identity.

No floating point.

## 6. Domain separation

Distinct signature domains are mandatory.

Examples:
- GPUBNB:ASSET-EXCHANGE:OFFER:v1
- GPUBNB:ASSET-EXCHANGE:ACCEPT:v1
- GPUBNB:ASSET-EXCHANGE:CANCEL:v1
- GPUBNB:ASSET-EXCHANGE:SETTLEMENT:v1
- GPUBNB:ASSET-EXCHANGE:OWNERSHIP:v1

A signature valid for one domain must never authorize another operation.

## 7. Replay resistance

Replay defense must combine:
- domain;
- protocol version;
- network;
- offer/trade ID;
- nonce;
- expiry;
- signer identity/key;
- consumption state.

Server-side consumption state is durable PostgreSQL truth.

A valid historical signature is not automatically a valid current authorization.

## 8. PSBT safety requirements

Before asking a signer to approve a PSBT, independently derive and validate:
- every input;
- every previous output;
- every output;
- destination;
- change;
- amount;
- fee;
- locktime;
- sequence;
- script type;
- sighash semantics;
- network;
- protocol role.

Reject signing requests containing unrelated outputs unless explicitly defined by the protocol.

Do not trust the web UI summary if it disagrees with parsed transaction data.

## 9. Mempool policy is not consensus

Bitcoin Core explicitly distinguishes relay/mempool policy from consensus.

Implication:
- a transaction accepted by one node may not propagate identically everywhere;
- local testmempoolaccept success is useful but not global finality;
- protocol safety cannot depend on one implementation's current policy.

G2 must separately model:
- consensus validity;
- local mempool acceptance;
- network propagation;
- mining inclusion.

## 10. Mempool policy changes over time

Current Bitcoin Core behavior includes evolving replacement and cluster-mempool policy.

Implication:
- settlement adapters need versioned chain-policy profiles;
- integration tests must run against supported node versions;
- protocol cannot bake old RBF assumptions into permanent safety logic.

Any supported chain fork needs its own independently verified policy profile.

## 11. RBF and replacement

Replacement can change the transaction that eventually confirms.

Protocol questions that must be answered explicitly:
- which transactions are intended to be replaceable;
- who controls replacement;
- whether txid mutation affects later protocol references;
- whether a pre-signed child/refund remains valid;
- how fee increase changes outputs;
- how watchers reconcile replacement.

Never assume an unconfirmed txid is immutable.

## 12. Fee-bumping safety

Fee spikes can strand recovery.

Every refund/redeem path requires a documented fee strategy.

Potential mechanisms depend on chain/protocol:
- adequate initial fee;
- RBF;
- CPFP;
- package relay;
- anchor-like constructions where appropriate;
- external fee input.

No mechanism is assumed safe without protocol-specific review.

A recovery transaction that cannot afford current relay/mining conditions is not a reliable recovery path.

## 13. Pinning

Transaction pinning and package/relay interactions can prevent or delay fee bumping.

G2 requires adversarial testing for:
- malicious low-fee descendants;
- conflicting replacements;
- package limits;
- dependency chains;
- counterparty-controlled outputs/inputs;
- refund transaction broadcast under mempool pressure.

Any protocol vulnerable to practical counterparty pinning cannot be marked SECURE.

## 14. Pre-broadcast validation

Before broadcast:
- fully parse transaction;
- validate expected txid/wtxid derivation;
- validate network;
- validate scripts;
- validate fees;
- validate locktime/sequence;
- test local consensus/policy acceptance where supported;
- compare with signed settlement intent.

testmempoolaccept is a preflight signal, not a security proof.

## 15. Broadcast privacy

Naive repeated sendrawtransaction calls can leak origin information.

Broadcast architecture should:
- avoid unnecessary manual rebroadcast;
- understand wallet/node native rebroadcast behavior;
- consider privacy-preserving broadcast capabilities where supported;
- separate availability from needless origin leakage.

Privacy improvements must not weaken reliable refund propagation.

## 16. Crash after broadcast

Mandatory failure case:

1. persist intent;
2. broadcast transaction;
3. process crashes before marking broadcast success.

On restart, system must:
- derive expected transaction identity;
- inspect chain/mempool using independent observations;
- detect already-broadcast transaction;
- reconcile state;
- never blindly construct a duplicate incompatible fund-critical transaction.

This scenario is mandatory for every fund-moving transition.

## 17. Crash before broadcast

Mandatory failure case:

1. transaction prepared;
2. durable intent recorded or not recorded depending on state;
3. crash before network broadcast.

Recovery must distinguish:
- never broadcast;
- broadcast unknown;
- broadcast and seen;
- replaced;
- confirmed;
- conflicted.

Ambiguity must fail safely.

## 18. Confirmation policy

"1 confirmation" is not a universal security property.

Confirmation policy depends on:
- chain;
- observed reorg behavior;
- amount/risk tier;
- transaction ancestry;
- counterparty stage;
- settlement protocol;
- current chain health.

Confirmation policy must be versioned and signed/referenced by trade terms.

## 19. Reorg safety

Model at least:
- shallow reorg;
- lock transaction disappears;
- redeem disappears;
- refund disappears;
- conflicting spend appears;
- observer sources disagree.

A state named CONFIRMED cannot mean irreversible.

Use chain-aware states such as:
- SEEN_MEMPOOL;
- CONFIRMED_N;
- FINALITY_THRESHOLD_MET;
- REORGED;
- CONFLICTED.

## 20. Watcher disagreement

Watchers are untrusted sensors.

For fund-critical observations:
- query independent sources where practical;
- record source and observation height/hash;
- compare network/genesis identity;
- detect stale source;
- detect divergent tips.

If evidence conflicts:
- stop new irreversible actions;
- continue safe observation and recovery.

## 21. Timeout ordering

Cross-chain timeouts must not be chosen by simple identical wall-clock durations.

G2 must derive margins from:
- block interval distributions;
- confirmation target;
- reorg margin;
- fee bump delay;
- watcher lag;
- user signing delay;
- counterparty reaction delay;
- node outage;
- clock/height semantics.

The party acting later must have a provable safe window after learning the prerequisite secret/event.

## 22. Absolute vs relative timelocks

Use only after explicit protocol reasoning.

Relative timelocks:
- can simplify reasoning from confirmation point;
- depend on exact nSequence/BIP68 semantics.

Absolute timelocks:
- depend on height/time thresholds;
- may require larger safety margins across chains.

Mixing height and time semantics requires special care.

## 23. Block-time distributions

Do not convert "N blocks" into a guaranteed wall-clock deadline.

Blocks are stochastic.

Operational UI may estimate time, but protocol safety uses conservative chain semantics.

## 24. Chain-family non-equivalence

BTC, DOGE, LTC and BCH must not share one adapter merely because they are UTXO chains.

For each chain independently verify:
- script opcodes;
- sighash rules;
- transaction format;
- malleability behavior;
- locktime semantics;
- sequence semantics;
- RBF/replacement behavior;
- mempool rules;
- relay policy;
- fee units;
- dust policy;
- standardness;
- address encodings;
- reorg assumptions;
- node RPC semantics.

Code reuse may occur only below clearly verified capability interfaces.

## 25. Litecoin observation

Current Litecoin source exposes CHECKLOCKTIMEVERIFY and CHECKSEQUENCEVERIFY validation flags.

This establishes primitive availability, not protocol equivalence with Bitcoin.

LTC requires a dedicated capability and policy matrix before settlement.

## 26. Dogecoin

Do not infer Dogecoin's current consensus/mempool behavior from Bitcoin.

Before G2 adapter approval:
- inspect current Dogecoin Core source;
- verify exact activated script features;
- verify fee/relay/replacement policy;
- run regtest/integration vectors.

Until verified:
DOGE settlement status remains research/test only.

## 27. Bitcoin Cash

Do not assume Bitcoin Cash preserves Bitcoin's modern mempool, sighash or script behavior.

Before G2 adapter approval:
- verify current BCH consensus docs/source;
- identify fork-specific sighash/script differences;
- verify transaction identifiers and malleability implications;
- verify locktime/refund behavior;
- test against supported node implementation.

## 28. Monero/XMR

Monero does not provide Bitcoin-style scripting/hashlocks.

Historical BTC-XMR atomic-swap protocols use substantially more specialized cryptography, including
cross-curve/adaptor-signature-style constructions.

Important current research finding:
- the historical COMIT xmr-btc-swap repository is explicitly unmaintained;
- it warns that cryptography was not formally audited;
- its maintainers point to a different successor implementation;
- network-level compatibility changed.

Therefore:
XMR MUST NOT inherit a protocol from old code without current cryptographic review.

## 29. Monero RPC

Official Monero documentation shows wallet RPC can expose wallet functionality and private-key-backed
operations.

For gpu.k.p2p:
- server must never host user's spend wallet;
- do not expose user monero-wallet-rpc over public network;
- localhost/native user wallet integration must authenticate RPC;
- use restricted/view-only capabilities whenever spending authority is unnecessary.

The Wallet Agent model remains the safer boundary for user-owned wallets where native integration is required.

## 30. Monero production gate

Before XMR real-fund support:
- current protocol selected;
- current implementation maintained;
- crypto construction documented;
- license reviewed;
- independent cryptographic audit;
- adversarial state-machine review;
- test vectors;
- testnet/stagenet;
- recovery path proven;
- cross-version compatibility policy;
- external audit.

Until then:
XMR can exist in registry/marketplace discovery without SECURE settlement.

## 31. Ownership proof vs settlement signing

Ownership proof answers:
"can this party currently demonstrate control associated with this address/script?"

It does not answer:
- whether balance is sufficient later;
- whether funds are unencumbered;
- whether transaction intent is approved;
- whether wallet will remain accessible.

Ownership proof and settlement signature are separate security events.

## 32. Secret handling

HTLC/preimage or adaptor material:
- classify as fund-critical secret;
- define creator;
- define storage boundary;
- define disclosure event;
- define crash recovery;
- define encrypted recovery representation;
- never log it.

Server possession of protocol secrets must be minimized.

## 33. Refund independence

If refund can be prepared before lock, prefer architectures allowing user to hold all information
needed to recover without trusting gpu.k.p2p availability.

Goal:
frontend/API/worker deletion must not eliminate refund ability.

Recovery bundles are a future G3 specification requirement.

## 34. Signing UI

User-facing signing confirmation must display:
- asset/network;
- amount;
- destination/contract/script role;
- fee or bounded fee policy;
- refund deadline semantics;
- protocol version;
- trade ID.

If any critical value changes, require a new confirmation/signature.

## 35. No chat authority

Addresses, amounts or secrets pasted in chat do not override signed terms.

If counterparty says:
"send to this new address"
the protocol must reject any resulting transaction inconsistent with signed canonical terms.

## 36. State-machine requirement

Settlement state must be event-sourced or equivalently durable and auditable.

Every transition defines:
- valid previous states;
- required evidence;
- signer/actor;
- idempotency rule;
- durable write point;
- network action;
- recovery on crash;
- possible chain reorg reaction.

## 37. Example high-level UTXO states

Research vocabulary only:
- TERMS_SIGNED
- PREPARED
- LOCK_A_BROADCAST
- LOCK_A_SEEN
- LOCK_A_CONFIRMED
- LOCK_B_BROADCAST
- LOCK_B_CONFIRMED
- REDEEM_PREPARED
- REDEEM_BROADCAST
- COMPLETED
- REFUND_ELIGIBLE
- REFUND_BROADCAST
- REFUNDED
- REORG_DETECTED
- RECOVERY_REQUIRED
- FAILED_SAFE

Actual protocol states require formal design.

## 38. Forbidden state shortcuts

Never mark COMPLETED because:
- user clicked done;
- counterparty said paid;
- explorer HTML says success;
- one RPC returned confirmations;
- Redis has "complete";
- WebSocket emitted completion.

Completion must follow protocol-defined chain evidence.

## 39. Formal safety properties

Before real settlement, formally specify and model at least:

S1. No trade reaches COMPLETED without both required asset-transfer conditions.

S2. A whole-fill offer cannot settle twice.

S3. Signed terms cannot mutate after acceptance.

S4. No unsigned settlement terms authorize lock.

S5. Recovery remains reachable under allowed failure assumptions.

S6. A mode transition cannot remove already-valid refund/redeem capability.

S7. Completed and Refunded are mutually exclusive terminal outcomes for the same asset leg unless
the protocol explicitly models a reorg-induced reversal before finality.

S8. Crash/restart does not duplicate irreversible effects.

S9. Replay of an old message cannot authorize a new trade.

S10. An honest party does not lose both its original asset and protocol recovery right under the
protocol's stated network/timing assumptions.

## 40. Liveness properties

Safety alone is insufficient.

Model:
- eventual progress when both parties cooperate;
- eventual refund after counterparty disappears;
- watcher/RPC failover;
- recovery after worker crash;
- recovery after service outage.

Liveness assumptions must be documented, not hidden.

## 41. TLA+ / model-checking plan

Model:
- offer acceptance;
- cancel race;
- two-chain settlement state;
- mode transition;
- crashes at every durable/network boundary;
- duplicate worker messages;
- delayed/reordered chain observations;
- reorg transitions;
- refund/redeem race.

Model environment nondeterministically.

Do not encode desired outcome as an assumption.

## 42. Differential testing

For serialized transactions/scripts:
- compare our parser/builder with chain reference node behavior;
- use independent libraries where reasonable;
- compare sighash and txid results;
- compare script execution test vectors.

Disagreement blocks release.

## 43. Fuzzing

Fuzz:
- canonical offer parser;
- signed message parser;
- PSBT parser;
- chain transaction parser;
- script descriptor parser;
- RPC response parser;
- state-transition input;
- recovery-bundle parser.

Targets:
- no panic/crash;
- no acceptance ambiguity;
- no duplicate-key ambiguity;
- bounded resource usage.

## 44. Chaos testing

Inject:
- node down;
- stale node;
- malicious RPC;
- DNS failure;
- high fees;
- zero peers;
- DB reconnect;
- Redis loss;
- worker duplicate;
- worker restart;
- API deletion;
- frontend deletion;
- delayed signer;
- chain reorg.

Observe recovery invariant.

## 45. Regtest before testnet

First executable settlement work:
Bitcoin-family regtest only.

Required before public testnet:
- deterministic scenarios;
- forced reorgs;
- fee spikes;
- mempool conflicts;
- RBF/replacement tests;
- refund under outage;
- crash after every broadcast point.

## 46. Testnet limitations

Public testnets differ from Mainnet:
- fee market;
- mining behavior;
- liquidity;
- adversarial conditions.

Testnet success is necessary but not sufficient.

## 47. Mainnet canary

Only after all security gates:
- very low value caps;
- single validated pair/protocol;
- explicit opt-in;
- enhanced monitoring;
- kill new-lock capability;
- recovery always enabled;
- rapid rollback of new activity, not recovery.

No broad 30-chain launch.

## 48. Chain adapter evidence package

Each chain adapter needs:
- exact node implementation/version;
- consensus primitives;
- mempool/relay behavior;
- RPC methods;
- address formats;
- fee model;
- lock/refund construction;
- reorg policy;
- confirmation policy;
- test vectors;
- known limitations;
- incident procedure.

## 49. Research-derived G2 blockers

Do not implement production settlement until resolved:

- exact first pair choice;
- exact lock script design;
- absolute vs relative timelock decision;
- fee-bump mechanism;
- pinning resistance analysis;
- replacement behavior;
- confirmation thresholds;
- reorg recovery;
- transaction malleability assumptions;
- wallet signer compatibility;
- recovery-bundle semantics;
- formal state machine;
- chain-specific policy profile;
- supported node versions.

## 50. Recommended first protocol target

Research recommendation:
start with BTC-family UTXO test architecture, but use Bitcoin regtest as the reference chain first.

Why:
- mature reference node;
- well-documented primitives;
- PSBT ecosystem;
- strong testing support;
- ability to force regtest scenarios.

Do not generalize to DOGE/LTC/BCH until capability matrices prove equivalence for each required property.

## 51. Explicit non-decisions

This memo intentionally does NOT yet choose:
- exact HTLC script;
- Taproot vs legacy/witness construction;
- exact timeout numbers;
- exact fee-bump scheme;
- exact first production pair;
- exact XMR protocol.

Those choices require the next G2 protocol RFC and threat analysis.

## 52. External research basis

Research revalidated against current sources including:
- Bitcoin BIPs for CLTV, relative locktime/CSV, PSBT and BIP322;
- current Bitcoin Core mempool replacement/policy documentation;
- current Bitcoin Core RPC documentation;
- Litecoin source for primitive support;
- Monero official RPC documentation;
- historical COMIT BTC-XMR atomic-swap implementation and paper;
- OWASP cryptographic-failure guidance.

All chain assumptions must be revalidated again immediately before implementation and release because
node policies and implementations evolve.

## 53. Current status

Research: FIRST DEEP PASS COMPLETE.
G2 protocol RFC: NOT YET WRITTEN.
Settlement implementation: NOT STARTED.
Real funds: FORBIDDEN.
Mainnet: FORBIDDEN.
