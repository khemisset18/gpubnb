# Litecoin Adapter Specification V1

Status: SPECIFIED / UNVERIFIED / NO-TEST WINDOW / NO AUTOMATIC SETTLEMENT ACTIVATION

## 1. Scope

This document specifies the first candidate Litecoin settlement adapter for gpu.k.p2p.

Candidate adapter/profile:

`LTC_BASECHAIN_TRANSPARENT_V1`

This specification is intentionally non-executable during the current no-test window.

It does NOT:
- enable Litecoin settlement;
- enable Mainnet or testnet broadcast;
- promote any registry capability;
- change any fund-moving runtime path;
- claim signer compatibility;
- claim recovery is proven.

Current required state remains:
- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

## 2. Official baseline

Reviewed release baseline:

- Litecoin Core v0.21.5.8;
- release/tag commit: `ec1b648`;
- official project release line identifies v0.21.5.8 as the latest stable release at specification time.

Candidate x86_64 Linux artifact hash published by the official release:

`43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9  litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`

This hash is a documentation pin candidate only.
It MUST be revalidated from the official release source immediately before any future executable qualification.

The official Litecoin documentation records support for:
- BIP65 / CHECKLOCKTIMEVERIFY;
- BIP68 sequence locks;
- BIP112 / CHECKSEQUENCEVERIFY;
- BIP113 median-time-past semantics;
- BIP125 opt-in full replace-by-fee;
- SegWit-era witness validation.

Litecoin Core v0.21.5.8 also contains active MWEB validation, relay, mining, mempool and resource-management behavior.

## 3. Security boundary

The first Litecoin adapter MUST support transparent Litecoin base-chain settlement only.

The adapter MUST reject any operation whose funding, spending, accounting or recovery semantics depend on MWEB.

Forbidden for this profile:
- MWEB-only inputs;
- MWEB-only outputs;
- MWEB peg-ins;
- MWEB peg-outs;
- MWEB wallet accounting assumptions;
- MWEB recovery material;
- MWEB-specific signing paths;
- implicit conversion between transparent and MWEB value.

MWEB requires a separately versioned adapter/profile and an independent cryptographic, privacy, wallet and recovery review.

No fallback from transparent settlement to MWEB is permitted.

## 4. Adapter identity

Proposed identity:

- adapterId: `litecoin-basechain-transparent`;
- adapterVersion: `1`;
- chainId: `litecoin`;
- protocolVersion: `LTC_BASECHAIN_TRANSPARENT_V1`;
- supported networkIds: initially qualification-only local/regtest equivalent, exact identifier PENDING EXECUTION;
- supported asset type: native;
- canonical asset: LTC on the exact Litecoin network;
- recoveryVersion: `LTC-RECOVERY:v1`;
- protocol domain: MUST be distinct from Bitcoin and from all other chains.

The final signed-term domain string MUST be frozen before executable implementation.
It MUST NOT reuse the Bitcoin domain.

## 5. Capability declaration during no-test window

All execution capabilities remain false:

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
- privacySensitive = false for transparent profile only;
- issuerControlled = false.

These values describe executable qualification state, not protocol possibility.

No capability may become true merely because analogous Bitcoin code exists.

## 6. Candidate settlement construction

The first qualification target SHOULD evaluate a SegWit v0 transparent HTLC profile derived from first principles on Litecoin, not copied by assumption from Bitcoin.

Candidate cryptographic structure to test:

- SHA-256 secret condition;
- fixed 32-byte secret;
- redeem public key;
- refund public key;
- absolute CLTV refund path;
- explicit sighash policy;
- compressed public keys where supported by the selected signer path;
- no partial fills;
- no ANYONECANPAY;
- no Taproot assumption;
- no adaptor-signature assumption.

The exact script bytes, script container, transaction version, nSequence values, sighash behavior, witness stack and standardness are PENDING EXECUTION.

No script form is approved by this document.

## 7. Signed final terms

Litecoin final terms MUST bind at minimum:

- deploymentId;
- tradeId;
- offerHash;
- maker identity;
- taker identity;
- policyEpoch;
- chainId;
- networkId;
- adapterId;
- adapterVersion;
- protocolVersion;
- exact atomic LTC amount;
- secretHash;
- redeem public key;
- refund public key;
- timeout policy identifier and values;
- confirmation policy identifier and values;
- lock script/program hash;
- exact scriptPubKey once qualified;
- exact sighash mode;
- fee policy;
- recovery version;
- signer policy;
- toolchain baseline.

Both parties MUST sign byte-for-byte identical canonical terms before any future settlement action.

Unknown fields or non-canonical encoding MUST fail closed.

## 8. Timelock policy

The adapter MUST define explicitly:

- absolute vs relative timelock;
- height vs time semantics;
- median-time-past dependencies;
- required transaction version;
- required nLockTime;
- required nSequence values;
- earliest-valid refund condition;
- minimum safety margin;
- confirmation budget;
- reorg budget;
- broadcast-delay budget.

The Bitcoin timeout constants MUST NOT be reused.

The initial candidate SHOULD prefer an absolute block-height CLTV refund path because recovery UX can be made explicit, but this remains UNVERIFIED until Litecoin-specific execution proves the exact semantics.

## 9. Fee policy

Litecoin owns its fee policy.

The adapter MUST NOT import Bitcoin fee assumptions.

The executable profile must eventually bind:

- fee unit;
- estimator source;
- minimum relay assumptions;
- dust/min-output rules;
- replacement increment policy;
- RBF signaling policy;
- maximum permitted fee;
- stuck-transaction detection;
- fee-bump mechanism;
- emergency recovery fee strategy.

A refund transaction that cannot realistically be fee-bumped is not acceptable recovery.

The recovery path MUST remain usable when the original operator infrastructure is unavailable.

## 10. Replacement and pinning

The following must be independently qualified on the pinned Litecoin node:

- opt-in RBF signaling;
- replacement feerate rules;
- descendant interaction;
- package behavior;
- mempool conflict limits;
- eviction behavior;
- inherited unconfirmed ancestry;
- replacement after restart;
- exact rebroadcast semantics.

Bitcoin Core cluster/package results MUST NOT be treated as Litecoin evidence.

Unknown or changed policy MUST fail closed.

## 11. Malleability and transaction identity

The qualification must establish:

- transaction-id stability for the selected transparent SegWit path;
- which fields are covered by the selected sighash;
- whether external signer transformations can alter transaction identity;
- whether pre-signing a refund is safe under the chosen construction;
- what recovery artifacts remain valid if the lock transaction is fee-bumped or replaced.

The adapter MUST NOT bind recovery to an unstable transaction identifier unless the replacement relationship is explicitly represented and recoverable.

## 12. Signer boundary

The gpu.k.p2p server MUST never receive:

- seed phrase;
- raw private key;
- wallet password;
- arbitrary wallet file;
- unrestricted signing authority.

Future signing options may include:
- hardware wallet;
- external wallet;
- local loopback agent;
- imported signed transaction/PSBT-like artifact, if the exact Litecoin toolchain support is qualified.

Before enabling any signer type, qualification MUST prove:

- exact transaction bytes shown to the signer;
- exact chain/network identity;
- exact outputs;
- exact fee;
- exact lock/refund semantics;
- no hidden change-output ambiguity;
- no signer silently converts to MWEB;
- no signer normalizes script/sequence/sighash in a way that changes signed terms.

Unknown signer behavior = reject.

## 13. Ownership proof

Ownership proof is separate from settlement signing.

No generic "sign message" proof may be accepted without Litecoin-specific domain separation, replay resistance and address/script-type binding.

A future ownership-proof profile MUST bind:
- deployment;
- canonical asset/network;
- address or script identity;
- actor;
- nonce;
- expiry;
- proof method/version.

Ownership proof MUST NOT be treated as proof that funds are unencumbered or spendable.

## 14. Watcher model

Watchers provide evidence only.

The Litecoin adapter must eventually define:
- mempool seen;
- chain inclusion;
- confirmation count;
- conflict/replacement;
- reorg downgrade;
- invalidated lock;
- redeem observed;
- refund observed;
- uncertain state.

At least two independently configured evidence sources SHOULD be evaluated for production qualification.

Any disagreement that affects irreversible progression MUST produce an uncertainty state and stop automatic advancement.

Watcher evidence MUST NOT disable refund or recovery.

## 15. Reorg policy

Litecoin confirmation policy MUST be chain-specific.

It must define:
- amount bands;
- risk floors;
- reorg downgrade behavior;
- maximum tolerated fork disagreement before halting progression;
- deep-reorg recovery behavior.

A previously confirmed lock that loses confirmations MUST move to an explicitly non-final state.

The system MUST NOT preserve a stale "locked" label solely because PostgreSQL or a worker previously recorded it.

## 16. Recovery-before-lock

Before any future lock broadcast, the user must possess a versioned recovery bundle containing enough public/non-secret material to recover independently.

Required candidate contents:
- canonical signed final terms;
- adapter and protocol versions;
- exact chain/network identity;
- lock transaction/template;
- lock script/program;
- secretHash;
- redeem/refund public keys;
- timeout condition;
- refund destination;
- fee policy;
- signable or signed refund artifact as permitted by the final protocol;
- replacement/rebroadcast metadata;
- independent verification instructions;
- toolchain provenance.

Forbidden:
- seed phrase;
- raw private key;
- wallet password;
- unrestricted signer token.

The bundle MUST remain useful without gpu.k.p2p web/API/worker/DB/operator.

## 17. Crash and restart invariants

Future implementation must be idempotent across:

- crash before lock broadcast;
- crash after local signing but before broadcast;
- crash after broadcast before persistence acknowledgement;
- duplicate broadcast;
- watcher restart;
- fee-bump attempt;
- reorg;
- refund eligibility transition.

The system MUST reconcile using chain evidence and canonical transaction identity, not by trusting a local "sent" flag.

## 18. RPC isolation

Litecoin RPC configuration MUST be Asset-Exchange-specific.

Forbidden targets include:
- GPUbnb Core services;
- Core PostgreSQL;
- Core Redis;
- cloud metadata endpoints;
- arbitrary participant-provided RPC URLs;
- unrestricted localhost targets.

RPC endpoint, credentials and network identity MUST be operator-configured and allowlisted.

The adapter MUST verify network identity before accepting chain evidence.

## 19. Failure modes to test when execution resumes

Minimum adversarial matrix:

1. wrong network selected;
2. MWEB input presented to transparent adapter;
3. MWEB output/change introduced by wallet;
4. wrong secret;
5. secret length mismatch;
6. wrong redeem key;
7. wrong refund key;
8. wrong sighash;
9. non-standard script;
10. refund attempted too early;
11. boundary-height refund;
12. RBF replacement below policy threshold;
13. successful lock fee bump;
14. descendant pinning;
15. conflicting lock transaction;
16. restart before broadcast;
17. restart after broadcast;
18. duplicate broadcast;
19. lock confirmed then reorged out;
20. redeem confirmed then reorged out;
21. refund confirmed then reorged out;
22. two-node disagreement;
23. stale RPC response;
24. signer mutates outputs;
25. signer mutates change;
26. signer changes nSequence;
27. signer changes nLockTime;
28. signer selects MWEB;
29. fee estimator unavailable;
30. fee spike near refund window;
31. backend unavailable before refund;
32. watcher unavailable;
33. recovery bundle only available;
34. corrupted recovery bundle;
35. replacement changes txid;
36. hardware signer refuses script;
37. amount boundary/dust behavior;
38. integer overflow/serialization edge cases;
39. malformed PSBT-like artifact;
40. wrong chain magic/genesis identity.

No single passing happy-path test is sufficient.

## 20. Qualification gates

When tests resume, execute in this order:

### L0 — Toolchain integrity
- revalidate latest reviewed stable release;
- pin exact source/tag commit;
- pin artifact hashes;
- verify official provenance/signature material;
- archive immutable evidence.

### L1 — Network identity
- isolated Litecoin-only environment;
- verify genesis/network identity;
- no Mainnet credentials;
- no production RPC fallback.

### L2 — Transparent-only enforcement
- prove MWEB is rejected;
- prove wallet/change cannot silently enter MWEB;
- prove no MWEB recovery dependency.

### L3 — Script semantics
- validate exact script bytes;
- CLTV behavior;
- CSV behavior if used;
- witness semantics;
- sighash semantics;
- standardness.

### L4 — Lock/redeem/refund
- deterministic construction;
- wrong-secret rejection;
- early-refund rejection;
- successful independent refund;
- exact destination/amount preservation.

### L5 — Fee/replacement
- relay and dust policy;
- RBF;
- stuck transaction;
- descendant/pinning behavior;
- recovery fee bump.

### L6 — Recovery
- recovery bundle before lock;
- independent verification;
- backend-independent refund;
- crash/restart matrix.

### L7 — Reorg/watchers
- shallow/deep reorg matrix;
- conflicting RPC evidence;
- fail-closed uncertainty;
- reconvergence.

### L8 — Signers
- local external signer;
- candidate hardware wallets;
- exact WYSIWYS;
- no MWEB mutation;
- no unrestricted signing.

### L9 — Audit and activation review
- evidence package;
- threat-model delta;
- formal/state-machine review;
- registry activation in a separate reviewed commit.

Until L0-L9 are complete and independently reviewed:
- automaticSettlementSupported remains false.

## 21. Gaps remaining

Current gaps are intentionally explicit:

- exact Litecoin script container not frozen;
- exact final-term domain not frozen;
- exact local/regtest network identity not frozen;
- exact transaction version/nSequence policy not frozen;
- exact sighash policy not frozen;
- exact fee/dust/RBF values not pinned from executable evidence;
- exact PSBT/external-signer contract not qualified;
- hardware wallet compatibility unknown;
- replacement/pinning behavior unverified;
- reorg depth policy unverified;
- watcher source diversity policy unverified;
- recovery transaction mutability model unverified;
- MWEB rejection behavior unverified;
- ownership-proof method not selected.

These are blockers, not documentation omissions.

## 22. Activation invariant

Litecoin may be promoted from MARKETPLACE_ONLY only through a separate reviewed activation change after executable evidence exists.

That activation MUST verify all of:

- canonical asset identity;
- lock;
- redeem;
- refund;
- recovery;
- fee policy;
- confirmation policy;
- signer policy;
- watcher conflict handling;
- pinned toolchain;
- test evidence;
- audit evidence.

No change in this specification activates settlement.
