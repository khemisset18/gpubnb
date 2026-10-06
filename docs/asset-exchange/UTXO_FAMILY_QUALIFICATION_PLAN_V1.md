# UTXO Family Qualification Plan V1

Status: ARCHITECTURE / RESEARCH / NO TEST EXECUTION WINDOW

## Purpose

This document fixes the qualification order and safety boundaries for Litecoin, Dogecoin and Bitcoin Cash after Bitcoin.

The goal is not to maximize coin count. The goal is to prevent Bitcoin assumptions from silently leaking into other UTXO-family chains.

No chain may inherit Bitcoin settlement eligibility merely because its transaction model looks similar.

## Global rule

For every chain family, qualification must independently establish:

1. canonical chain/network identity;
2. pinned node implementation and release;
3. deterministic release hash/signature verification;
4. supported script primitives;
5. sighash semantics;
6. transaction malleability assumptions;
7. timelock semantics;
8. mempool and relay policy;
9. replace-by-fee or alternate fee-bump behavior;
10. dust policy;
11. confirmation and reorg policy;
12. wallet/external-signer behavior;
13. lock transaction construction;
14. redeem transaction construction;
15. refund transaction construction;
16. recovery bundle compatibility;
17. crash/restart/rebroadcast behavior;
18. independent watcher evidence;
19. adversarial reorg/fee/pinning behavior;
20. formal/state-machine compatibility.

Until every required item is proven, the asset remains MARKETPLACE_ONLY.

## Qualification order

1. Litecoin
2. Dogecoin
3. Bitcoin Cash
4. Monero / Zcash transparent research after UTXO transparent chains
5. EVM
6. Solana
7. XRPL
8. remaining mining / experimental chains

This order follows recovery and cryptographic-risk priority, not market popularity.

---

# Litecoin

## Pinned research baseline

Research baseline:
- Litecoin Core release family: 0.21.5.8
- current public release documentation indicates MWEB validation and relay hardening in this release

Production qualification MUST pin:
- exact release tag;
- exact source commit;
- official archive hash;
- release signature/provenance where available.

No use of an unpinned master branch.

## Architecture decision

Litecoin MUST NOT reuse the Bitcoin settlement adapter by substitution.

The first Litecoin settlement profile, if qualified, will be:

`LTC_BASECHAIN_TRANSPARENT_V1`

and MUST explicitly exclude MWEB inputs, outputs and settlement semantics.

MWEB requires a separate protocol profile and security review.

## Required Litecoin gates

Before any automatic settlement:
- base-chain transparent outputs only;
- explicit rejection of MWEB transaction paths;
- CLTV/CSV semantics independently verified;
- sighash behavior independently verified;
- fee estimation and mempool policy independently verified;
- RBF behavior independently verified;
- dust policy independently verified;
- confirmation/reorg matrix independently verified;
- wallet and hardware-signer compatibility independently verified;
- recovery-before-lock invariant reproduced;
- standalone refund recovery reproduced;
- no dependency on Litecoin Core wallet state for final recovery.

## Registry policy

Until those gates are evidenced:
- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

---

# Dogecoin

## Pinned research baseline

Research baseline:
- Dogecoin Core 1.14.9 is the latest stable public release observed during this review;
- project documentation explicitly states that the master branch is unstable and production builds should use a tagged release;
- Dogecoin has BIP65 / OP_CHECKLOCKTIMEVERIFY support;
- Dogecoin relay, fee, dust and replacement behavior is chain-specific;
- Dogecoin regtest also has AuxPoW-related behavior that must not be ignored.

Production qualification MUST pin:
- exact 1.14.9 release artifacts unless a later reviewed stable release supersedes it;
- source commit;
- artifact hashes;
- release signing/provenance.

## Architecture decision

Dogecoin MUST have a dedicated adapter:

`DOGE_P2SH_OR_NATIVE_SCRIPT_PROFILE_V1`

The exact locking construction is intentionally NOT fixed by this document.

It must be selected only after script standardness, signer compatibility, refund reliability and transaction malleability are reviewed against the pinned Dogecoin release.

## Required Dogecoin gates

Before automatic settlement:
- verify exact standard script forms accepted by Dogecoin Core;
- verify CLTV behavior;
- verify whether CSV is usable for the selected protocol;
- verify sighash behavior;
- verify transaction malleability assumptions;
- verify recommended fee and relay policy;
- verify dust rules;
- verify replacement / fee-bump behavior;
- verify stuck-transaction and rebroadcast behavior;
- verify AuxPoW/regtest effects on test harnesses;
- verify reorg and confirmation policy;
- verify external signer compatibility;
- reproduce recovery-before-lock and standalone refund recovery.

## Registry policy

Until qualification:
- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

---

# Bitcoin Cash

## Pinned research baseline

Research baseline:
- Bitcoin Cash Node 29.2.0 is the current reviewed release;
- BCHN 29.0.0 implemented the May 15, 2026 consensus upgrade;
- BCHN 29.2.0 signs transactions using Schnorr by default;
- BCH script, signature and policy behavior is not interchangeable with Bitcoin Core.

Production qualification MUST pin:
- BCHN 29.2.0 or a later separately reviewed release;
- exact release artifacts;
- official hashes/signatures;
- consensus-upgrade compatibility.

## Architecture decision

Bitcoin Cash MUST have a dedicated settlement family.

No Bitcoin P2WSH profile may be reused.

The candidate profile is:

`BCH_NATIVE_SCRIPT_SETTLEMENT_V1`

but the final script form and signature scheme remain unset until qualification.

## Required BCH gates

Before automatic settlement:
- verify current BCH script standardness after the 2025 and 2026 upgrades;
- verify timelock primitives;
- verify Schnorr vs ECDSA signer behavior;
- verify sighash semantics;
- verify malleability assumptions;
- verify fee and mempool rules;
- verify transaction package behavior;
- verify dust rules;
- verify refund transaction reliability;
- verify reorg and confirmation policy;
- verify external/hardware signer compatibility;
- reproduce standalone recovery with exact signed transaction artifacts.

## Registry policy

Until qualification:
- supportStatus = MARKETPLACE_ONLY;
- automaticSettlementSupported = false;
- settlement route = null.

---

# Shared architecture

Each chain gets its own module boundary:

`asset-exchange/settlement/<chain-family>/`

No chain adapter may import another chain adapter's protocol assumptions.

Shared code is limited to chain-neutral primitives:
- canonical serialization;
- exact integer amounts;
- asset identity;
- signed-term binding;
- state-machine interfaces;
- recovery envelope interfaces;
- watcher evidence interfaces.

Chain-specific logic includes:
- script construction;
- transaction serialization;
- sighash;
- fee calculation;
- lock/redeem/refund;
- timelock derivation;
- mempool policy;
- confirmation policy;
- signer behavior;
- RPC adapters.

## Activation rule

A registry entry may move from MARKETPLACE_ONLY to LIMITED/SECURE automatic settlement only after:

- chain research spec approved;
- pinned toolchain recorded;
- implementation reviewed;
- local/regtest or equivalent tests pass;
- crash/recovery tests pass;
- reorg tests pass;
- fee/pinning tests pass;
- external signer profile passes;
- independent review is recorded;
- owner explicitly approves activation.

No documentation statement alone activates settlement.

## Current decision

Bitcoin regtest remains the only automatic settlement route.

LTC, DOGE and BCH stay MARKETPLACE_ONLY until their individual qualification gates can be executed.
