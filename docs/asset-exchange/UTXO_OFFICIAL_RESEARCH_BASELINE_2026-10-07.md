# UTXO Official Research Baseline — 2026-10-07

Status: RESEARCHED / SPECIFIED / NO-TEST WINDOW / NO AUTOMATIC SETTLEMENT ACTIVATION

## Purpose

This document records the official-source research baseline for the next UTXO-family qualification sequence:

1. Litecoin
2. Dogecoin
3. Bitcoin Cash

It is intentionally non-executable.

No registry status is promoted by this document.
No Mainnet settlement is enabled.
No real-funds path is enabled.

The current executable rule remains:

- Bitcoin regtest is the only automatic settlement route;
- Litecoin, Dogecoin and Bitcoin Cash remain MARKETPLACE_ONLY.

## Architecture verdict

Keep the current architecture.

Do not create per-symbol HTTP endpoints such as /btc, /doge or /ltc.

Use:

- one canonical asset registry;
- generic offer / accept / cancel APIs;
- chain-specific settlement adapters;
- chain-specific watchers;
- chain-specific signer policy;
- chain-neutral trade state machine;
- chain-neutral recovery envelope with chain-specific payload;
- fail-closed activation through registry capability flags.

No UTXO-family chain inherits Bitcoin settlement eligibility merely because it shares transaction or script ancestry.

---

# Litecoin

## Official reviewed baseline

Reviewed stable release:

- Litecoin Core v0.21.5.8
- release tag commit shown by the official repository: ec1b648
- release date observed in official repository: September 2026

Primary official sources reviewed:

- litecoin-project/litecoin releases
- litecoin-project/litecoin doc/release-notes-litecoin.md
- litecoin-project/litecoin doc/bips.md
- litecoin-project/litecoin src/consensus/params.h
- litecoin-project/litecoin src/script/interpreter.h

## Confirmed protocol facts

Litecoin Core documents support for:

- BIP65 / CHECKLOCKTIMEVERIFY;
- BIP68 sequence locks;
- BIP112 / CHECKSEQUENCEVERIFY;
- BIP113 median-time-past lock-time semantics;
- BIP125 opt-in full RBF;
- SegWit / BIP141-era witness validation.

The current release line also contains active MWEB consensus, relay, mining, mempool and wallet behavior.

Litecoin Core v0.21.5.8 specifically includes MWEB validation, relay, mining and resource-management hardening.

## Security decision

The first future Litecoin settlement profile MUST be transparent base-chain only.

Candidate profile name:

LTC_BASECHAIN_TRANSPARENT_V1

It MUST NOT silently consume:

- MWEB inputs;
- MWEB outputs;
- MWEB peg-ins;
- MWEB peg-outs;
- MWEB wallet/accounting semantics;
- MWEB recovery assumptions.

MWEB requires a separate protocol profile and separate review.

## What cannot be assumed from Bitcoin

Do not assume without test evidence that Litecoin shares Bitcoin's:

- exact mempool replacement policy;
- exact relay policy;
- exact dust policy;
- exact fee estimator behavior;
- exact signer behavior;
- exact PSBT/hardware-wallet behavior;
- exact reorg/rebroadcast behavior;
- exact package/pinning behavior.

Even where script opcodes exist, the full transaction and recovery profile must be qualified independently.

## Future executable qualification gates

When tests resume:

1. pin exact v0.21.5.8 artifact;
2. record exact official SHA-256;
3. verify release signature/provenance;
4. start isolated regtest/test chain;
5. prove transparent-only chain path;
6. explicitly reject MWEB path;
7. verify CLTV;
8. verify CSV;
9. verify sighash behavior;
10. verify RBF policy;
11. verify dust and relay policy;
12. verify fee-bump recovery;
13. verify reorg behavior;
14. verify crash/rebroadcast idempotency;
15. verify recovery-before-lock;
16. verify backend-independent refund;
17. verify external signer/hardware-wallet compatibility;
18. verify watcher disagreement fails closed.

Until all required gates pass:

- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

---

# Dogecoin

## Official reviewed baseline

Reviewed stable release:

- Dogecoin Core v1.14.9
- official release commit shown by the repository: e0a1c15
- release is marked Latest in the official dogecoin/dogecoin releases page

Primary official sources reviewed:

- dogecoin/dogecoin releases
- dogecoin/dogecoin doc/bips.md
- dogecoin/dogecoin doc/fee-recommendation.md
- dogecoin/dogecoin share/dogecoin.conf
- dogecoin/dogecoin src/policy/policy.h

## Confirmed protocol facts

Dogecoin Core documents:

- BIP65 / CHECKLOCKTIMEVERIFY support;
- BIP125 opt-in full replace-by-fee support;
- CHECKSEQUENCEVERIFY as a standard verification flag in current policy code;
- AuxPoW / merged-mining behavior;
- chain-specific fee and dust policy.

Dogecoin's official fee recommendation document distinguishes wallet recommendations from node relay/mempool policy.

Observed official defaults/recommendations include:

- recommended wallet transaction fee: 0.01 DOGE/kB;
- wallet dust/discard recommendation: 0.01 DOGE;
- recommended wallet RBF increment: 0.001 DOGE;
- minimum relay fee default: 0.001 DOGE/kB;
- hard dust limit: 0.001 DOGE;
- soft dust limit: 0.01 DOGE;
- mempool replacement / limiting increment default described as 0.0001 DOGE.

These values are chain-specific operational policy, not Bitcoin defaults.

## Security decision

Dogecoin MUST have a dedicated adapter.

Candidate profile name remains intentionally provisional:

DOGE_SCRIPT_SETTLEMENT_V1

The exact script form is NOT approved during the no-test window.

Before selecting P2SH, native script, CLTV-only or CLTV+CSV construction, qualification must establish:

- standardness;
- wallet compatibility;
- external signer compatibility;
- recovery reliability;
- replacement policy;
- malleability assumptions;
- relay behavior.

## What cannot be assumed from Bitcoin

Do not reuse Bitcoin defaults for:

- sat/vB-style fee intuition;
- dust thresholds;
- replacement increments;
- mempool eviction behavior;
- test harness mining behavior;
- reorg timing assumptions;
- signer compatibility.

Dogecoin regtest and merged-mining / AuxPoW behavior must be accounted for in the future harness.

## Future executable qualification gates

When tests resume:

1. pin v1.14.9 artifact and commit;
2. verify official release integrity;
3. verify CLTV on the pinned node;
4. verify CSV before depending on it;
5. verify sighash behavior;
6. verify opt-in RBF behavior;
7. verify fee and dust rules from the pinned binary;
8. verify stuck-transaction detection/rebroadcast behavior;
9. verify AuxPoW-aware regtest behavior;
10. verify lock/redeem/refund script standardness;
11. verify recovery-before-lock;
12. verify standalone refund recovery;
13. verify reorg matrix;
14. verify signer/hardware-wallet compatibility;
15. verify watcher disagreement fails closed.

Until then:

- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

---

# Bitcoin Cash

## Official reviewed baseline

Reviewed stable release:

- Bitcoin Cash Node v29.2.0
- latest release observed from the official BCHN site/release pages on 2026-10-02
- official GitHub mirror release commit shown as 0757601

Primary official sources reviewed:

- bitcoincashnode.org release announcement for v29.2.0
- BCHN v29.2.0 release notes
- BCHN v29.0.0 May 2026 network-upgrade notes
- BCHN BIPs documentation
- BCHN policy/script documentation

## Confirmed protocol facts

BCHN v29.0.0 implements the May 15, 2026 network upgrade including:

- Pay to Script;
- bounded looping operations;
- function definition/invocation;
- bitwise operations.

BCHN v29.2.0 changed default transaction signing behavior:

- transactions are now signed with Schnorr signatures by default;
- operators depending on prior behavior can disable this with signschnorr=0.

BCHN documentation also confirms active support for:

- CHECKLOCKTIMEVERIFY;
- CHECKSEQUENCEVERIFY;
- sequence locks;
- median-time-past lock semantics;
- SIGHASH_FORKID replay-protection semantics.

## Security decision

Bitcoin Cash MUST have an independent settlement family.

Candidate profile name:

BCH_NATIVE_SCRIPT_SETTLEMENT_V1

Do NOT reuse:

- Bitcoin P2WSH settlement profile;
- Bitcoin SegWit assumptions;
- Bitcoin sighash assumptions;
- Bitcoin signer assumptions;
- Bitcoin mempool/package assumptions.

The final BCH locking script and signature scheme are intentionally not fixed during the no-test window.

## Specific BCH review requirements

Before choosing a final protocol:

- decide Schnorr vs ECDSA signing policy;
- define exact SIGHASH_FORKID handling;
- bind transaction version and script form;
- verify post-2026 script standardness;
- verify CLTV/CSV semantics on the pinned implementation;
- verify dust and fee rules;
- verify mempool/package behavior;
- verify refund reliability;
- verify hardware/external signer support;
- verify reorg/rebroadcast behavior;
- verify backend-independent recovery.

## Future executable qualification gates

When tests resume:

1. pin BCHN v29.2.0 or later separately reviewed stable release;
2. record official artifact SHA-256 and signing keys;
3. verify chain/network identity;
4. verify current script standardness;
5. verify CLTV;
6. verify CSV;
7. verify SIGHASH_FORKID;
8. verify Schnorr/ECDSA behavior;
9. verify malleability assumptions;
10. verify fee/dust policy;
11. verify replacement/package behavior;
12. verify lock/redeem/refund construction;
13. verify recovery-before-lock;
14. verify standalone recovery;
15. verify reorg matrix;
16. verify external signer/hardware-wallet compatibility;
17. verify watcher disagreement fails closed.

Until then:

- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

---

# Cross-chain invariant

Shared code may include only chain-neutral primitives:

- canonical serialization;
- exact integer amount handling;
- canonical asset identity;
- signed offer/accept/cancel/final-term domains;
- trade state machine;
- recovery envelope container;
- watcher evidence envelope;
- idempotency primitives.

Chain-specific code must own:

- transaction format;
- script construction;
- signature hashing;
- timelocks;
- fee calculation;
- mempool policy;
- replacement policy;
- dust rules;
- confirmation policy;
- reorg handling;
- signer behavior;
- RPC behavior;
- lock/redeem/refund transaction generation.

No chain-specific assumption may be imported through a shared helper merely for code reuse.

---

# No-test-window enforcement

While executable tests are unavailable:

Allowed:
- research;
- protocol specifications;
- architecture;
- threat-model updates;
- qualification matrices;
- release/toolchain pin research;
- disabled-by-default designs.

Not allowed:
- activating LTC/DOGE/BCH automatic settlement;
- modifying a fund-moving runtime path;
- enabling broadcast;
- enabling new financial DB transitions;
- weakening recovery;
- claiming a chain gate passed.

Required language remains:

- RESEARCHED;
- SPECIFIED;
- UNVERIFIED;
- PENDING EXECUTION.

## Next sequence when tests return

Resume in this exact order:

1. Litecoin transparent base-chain profile;
2. Dogecoin dedicated script profile;
3. Bitcoin Cash dedicated script/sighash profile;
4. Zcash transparent research;
5. Monero research with cryptographic specialist review;
6. EVM;
7. Solana;
8. XRPL;
9. remaining chains.

No shortcut from taxonomy to settlement activation.
