# Dogecoin Adapter Specification V1

Status: SPECIFIED / UNVERIFIED / NO-TEST WINDOW / NO AUTOMATIC SETTLEMENT ACTIVATION

## 1. Scope

This document specifies the first candidate Dogecoin settlement adapter for gpu.k.p2p.

Candidate adapter/profile:

`DOGE_SCRIPT_SETTLEMENT_V1`

This specification is intentionally non-executable during the current no-test window.

It does NOT:
- enable Dogecoin settlement;
- enable Mainnet/testnet broadcast;
- promote any registry capability;
- modify fund-moving runtime paths;
- claim signer compatibility;
- claim recovery is proven.

Current state remains:
- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

## 2. Official baseline

Reviewed release baseline:

- Dogecoin Core v1.14.9;
- tagged commit: `e0a1c157791544e818c901bd9341896965afbf9d`.

The v1.14.9 release notes describe important bugfixes and recommend upgrade.

The official Dogecoin BIP document records:
- BIP65 / CHECKLOCKTIMEVERIFY;
- BIP125 opt-in full replace-by-fee;
- AuxPoW / merged mining;
- Scrypt proof of work;
- DigiShield difficulty adjustment lineage.

Important evidence-age caveat:
- `doc/bips.md` in the v1.14.9 tag states that its feature list is updated through v1.14.6;
- `doc/fee-recommendation.md` in the v1.14.9 tag states that it was last updated for v1.14.6.

Therefore these documents are official baseline evidence, but not executable qualification evidence for every v1.14.9 policy path.

## 3. Fee and dust baseline

The official fee recommendation documents these defaults/recommendations:

- wallet recommended fee: 0.01 DOGE/kB;
- wallet dust/discard threshold: 0.01 DOGE;
- wallet RBF increment recommendation: 0.001 DOGE;
- default minimum relay fee: 0.001 DOGE/kB;
- hard dust limit: 0.001 DOGE;
- soft dust limit: 0.01 DOGE;
- default mempool/RBF incremental relay step: 0.0001 DOGE.

These values MUST NOT be copied into runtime from documentation alone.

When execution resumes they must be revalidated against the exact pinned binary/configuration.

Bitcoin sat/vB assumptions are forbidden.

## 4. Architecture decision

Dogecoin MUST have a dedicated adapter.

The adapter MUST NOT inherit Bitcoin or Litecoin settlement behavior merely through ancestry.

Shared code is limited to chain-neutral primitives:
- canonical serialization;
- exact integer amount handling;
- signed-term envelopes;
- trade state machine;
- recovery envelope;
- watcher evidence envelope;
- idempotency.

Dogecoin-specific code owns:
- transaction format;
- script form;
- sighash behavior;
- timelocks;
- fee/dust policy;
- mempool/replacement policy;
- AuxPoW-aware chain evidence;
- reorg handling;
- signer behavior;
- RPC behavior;
- lock/redeem/refund construction.

## 5. Adapter identity

Proposed identity:

- adapterId: `dogecoin-script`;
- adapterVersion: `1`;
- chainId: `dogecoin`;
- protocolVersion: `DOGE_SCRIPT_SETTLEMENT_V1`;
- recoveryVersion: `DOGE-RECOVERY:v1`;
- supported asset type: native;
- canonical asset: DOGE on exact Dogecoin network;
- signed-term domain: MUST be Dogecoin-specific and distinct from Bitcoin/Litecoin.

The exact domain string MUST be frozen before implementation.

## 6. Capability declaration during no-test window

All executable capabilities remain false:

- ownershipProof = false;
- lock = false;
- redeem = false;
- refund = false;
- recovery = false;
- rebroadcast = false;
- feeBump = false;
- reorgAware = false;
- watcherConflictAware = false;
- externalSigner = false;
- hardwareSigner = false;
- partialFill = false;
- tokenSupport = false;
- privacySensitive = false;
- issuerControlled = false.

No capability may become true based only on Bitcoin/Litecoin similarity.

## 7. Settlement construction decision

No final Dogecoin script form is approved during the no-test window.

Qualification MUST compare at least:
- P2SH-based script construction;
- native script construction where applicable;
- CLTV-only refund logic;
- CLTV + CSV combinations if justified.

Before freezing a profile, prove:
- consensus validity;
- mempool standardness;
- wallet construction behavior;
- external signer compatibility;
- hardware signer compatibility;
- exact sighash semantics;
- malleability assumptions;
- recovery reliability;
- replacement compatibility.

The chosen construction MUST make refund independently recoverable.

## 8. Timelock semantics

The adapter MUST explicitly bind:

- absolute vs relative timelock;
- block height vs time semantics;
- median-time-past dependencies;
- nLockTime;
- nSequence;
- transaction version;
- earliest valid refund condition;
- confirmation budget;
- reorg budget;
- maximum safe broadcast delay.

No Bitcoin timeout constant may be reused.

BIP65 support is baseline evidence only; exact execution semantics remain PENDING EXECUTION.

CSV MUST NOT be depended on until independently verified on the pinned Dogecoin node.

## 9. Sighash and malleability

The final profile MUST specify:
- exact sighash byte/type;
- which inputs/outputs are committed;
- whether ANYONECANPAY is forbidden;
- whether replacement changes transaction identity;
- whether pre-signed refund artifacts remain valid after replacement;
- whether signer normalization can mutate transaction identity.

Unknown sighash behavior = reject.

No Bitcoin sighash assumption may be imported without direct Dogecoin evidence.

## 10. Fee policy

Dogecoin fee policy is chain-specific.

The executable adapter must eventually bind:
- fee unit;
- fee estimator source;
- minimum relay assumptions;
- miner inclusion assumptions;
- hard dust threshold;
- soft dust threshold;
- wallet discard behavior;
- replacement increment;
- maximum fee;
- emergency recovery fee;
- stuck-transaction detection;
- CPFP/RBF decision rules.

The documented distinction between:
- wallet recommendation;
- relay/mempool minimum;
- miner policy;
is security-relevant and MUST be preserved.

## 11. Replacement policy

Dogecoin documents opt-in full RBF support.

Qualification must independently prove on the pinned version:
- signaling conditions;
- replacement increment;
- conflict limits;
- descendant handling;
- eviction behavior;
- restart behavior;
- replacement propagation;
- effect on pre-built refund artifacts.

A replacement policy failure after lock MUST NOT remove refund/recovery options.

## 12. AuxPoW and chain evidence

Dogecoin supports AuxPoW/merged mining.

The adapter/watchers MUST account for Dogecoin-specific chain validation and not assume Bitcoin-only header/PoW semantics.

Qualification must verify:
- exact network identity;
- genesis identity;
- AuxPoW acceptance behavior;
- regtest/local-chain mining behavior;
- chainwork/fork selection behavior;
- reorg evidence handling.

Watcher code must consume node-validated chain evidence rather than reimplement AuxPoW cryptography casually.

## 13. Confirmation/reorg policy

Confirmation policy MUST be Dogecoin-specific.

It must define:
- amount bands;
- risk floors;
- confirmation thresholds;
- reorg downgrade;
- deep-reorg response;
- conflicting node evidence handling.

A previously confirmed lock that loses confirmations MUST become non-final.

Database state or UI labels alone never establish cryptographic lock.

## 14. Watcher model

Watchers remain evidence providers, not authorities.

Required future evidence states:
- mempool seen;
- confirmed;
- confirmation count;
- replaced/conflicted;
- reorged;
- redeem observed;
- refund observed;
- uncertain.

Disagreement affecting irreversible progression MUST fail closed.

Watcher outage MUST NOT block refund/recovery.

## 15. Signer boundary

gpu.k.p2p servers MUST never receive:
- seed phrase;
- raw private key;
- wallet password;
- arbitrary wallet file;
- unrestricted signing authority.

Future signing may use:
- hardware wallet;
- external wallet;
- local loopback signer;
- imported signed artifact.

Before enabling a signer, prove:
- exact network;
- exact amount;
- exact destination(s);
- exact fee;
- exact nLockTime/nSequence;
- exact script;
- exact sighash;
- no silent mutation;
- no unrelated signing authority.

Unknown signer behavior = reject.

## 16. Ownership proof

Ownership proof is separate from spend authority.

A future proof MUST bind:
- deployment;
- chain/network;
- address/script;
- actor;
- nonce;
- expiry;
- proof method/version.

Generic cross-chain message signing is not acceptable.

Ownership proof is not proof of unencumbered spendable balance.

## 17. Recovery-before-lock

Before any future lock broadcast, the user must possess a recovery bundle containing enough public/non-secret material for independent recovery.

Candidate contents:
- canonical signed final terms;
- adapter/protocol versions;
- chain/network identity;
- lock transaction/template;
- exact script;
- secretHash if used;
- redeem/refund public keys;
- timeout;
- refund destination;
- fee/replacement policy;
- signed or signable refund artifact where safe;
- independent verification instructions;
- toolchain provenance.

Forbidden:
- seed phrase;
- raw private key;
- wallet password;
- unrestricted signer token.

The bundle MUST remain useful without web/API/worker/DB/operator.

## 18. Crash/restart invariants

Future implementation must be idempotent across:
- crash before broadcast;
- crash after signing before broadcast;
- crash after broadcast before DB acknowledgement;
- duplicate broadcast;
- watcher restart;
- replacement;
- reorg;
- refund eligibility transition.

Reconciliation must rely on canonical chain evidence and transaction relationships, not a local sent flag.

## 19. RPC isolation

Dogecoin RPC configuration MUST be Asset-Exchange-specific.

Forbidden:
- GPUbnb Core RPC/services;
- Core PostgreSQL;
- Core Redis;
- arbitrary participant RPC URLs;
- metadata services;
- unrestricted localhost.

The adapter MUST verify chain/network identity before trusting responses.

Dogecoin Core documentation warns against exposing RPC publicly; production qualification must preserve private operator-controlled RPC boundaries.

## 20. Failure modes to test when execution resumes

Minimum adversarial matrix:

1. wrong network;
2. wrong genesis/chain identity;
3. malformed lock script;
4. non-standard script;
5. wrong secret;
6. wrong redeem key;
7. wrong refund key;
8. wrong sighash;
9. refund too early;
10. refund at exact boundary;
11. dust output below hard limit;
12. output in soft-dust range;
13. wallet discard-to-fee behavior;
14. low-fee relay rejection;
15. miner-policy mismatch;
16. insufficient RBF increment;
17. successful replacement;
18. descendant pinning;
19. conflicting replacement;
20. restart before broadcast;
21. restart after broadcast;
22. duplicate broadcast;
23. lock confirmed then reorged;
24. redeem confirmed then reorged;
25. refund confirmed then reorged;
26. two-node disagreement;
27. stale RPC;
28. AuxPoW fork/reorg behavior;
29. signer mutates outputs;
30. signer mutates fee;
31. signer mutates nSequence;
32. signer mutates nLockTime;
33. signer changes sighash;
34. signer refuses script;
35. fee estimator unavailable;
36. fee spike near refund;
37. backend unavailable;
38. watcher unavailable;
39. recovery-bundle-only refund;
40. corrupted recovery bundle;
41. transaction replacement changes txid;
42. malformed imported signing artifact;
43. integer/serialization boundary;
44. very large fee request;
45. participant-supplied RPC attempt.

## 21. Qualification gates

When tests resume:

### D0 — Toolchain integrity
- revalidate stable release;
- pin tag/commit;
- pin artifact hashes;
- verify provenance/signature material.

### D1 — Network identity
- isolated Dogecoin environment;
- verify genesis/network;
- no Mainnet credential fallback.

### D2 — Script selection
- compare candidate script forms;
- prove standardness;
- freeze exact bytes and protocol version.

### D3 — Timelock/sighash
- CLTV;
- CSV if used;
- transaction version;
- nSequence/nLockTime;
- sighash;
- malleability assumptions.

### D4 — Lock/redeem/refund
- deterministic construction;
- wrong-secret rejection;
- early-refund rejection;
- independent refund.

### D5 — Fees/dust/replacement
- hard/soft dust;
- relay/miner/wallet distinctions;
- RBF;
- pinning;
- fee-bump recovery.

### D6 — AuxPoW/reorg/watchers
- local/regtest behavior;
- fork/reorg matrix;
- conflicting evidence;
- uncertainty/reconvergence.

### D7 — Recovery
- recovery bundle before lock;
- backend-independent refund;
- crash/restart matrix.

### D8 — Signers
- external signer;
- candidate hardware wallets;
- exact WYSIWYS;
- no silent mutation.

### D9 — Audit/activation
- evidence package;
- threat-model delta;
- formal/state-machine review;
- registry activation only in separate reviewed commit.

Until D0-D9 pass:
- automaticSettlementSupported = false.

## 22. Current gaps

Explicit blockers:

- final script form not selected;
- exact signed-term domain not frozen;
- exact test network identity not frozen;
- CSV dependency not approved;
- exact sighash policy not frozen;
- fee/dust policy not executable-evidence pinned;
- replacement/pinning behavior unverified;
- AuxPoW local harness behavior unverified;
- signer compatibility unknown;
- hardware-wallet compatibility unknown;
- recovery artifact mutability under replacement unknown;
- ownership-proof method not selected;
- watcher diversity policy not qualified;
- confirmation thresholds unqualified.

These gaps block activation.

## 23. Activation invariant

Dogecoin may leave MARKETPLACE_ONLY only through a separate, reviewed activation commit after executable qualification and audit evidence exist.

No statement in this document activates Dogecoin settlement.
