# Asset Activation Matrix V1

Status: OPERATIONAL SECURITY MATRIX / NO TEST EXECUTION WINDOW

## Purpose

This matrix turns the executable registry into an activation checklist.

It does not change runtime behavior.

Every asset remains blocked from automatic settlement until all required evidence for its chain family exists and an explicit activation commit changes the executable registry.

## Status meanings

- SECURE: reviewed settlement family with production-grade evidence
- LIMITED: restricted environment/protocol only
- MARKETPLACE_ONLY: discovery/offers may exist, but no automatic settlement
- QUARANTINED: new exposure blocked

## Current automatic settlement

| Registry ID | Status | Automatic settlement | Route |
|---|---|---:|---|
| btc-regtest-native | LIMITED | yes | BITCOIN_P2WSH_HTLC_V1_REGTEST |

This is regtest only and does not authorize real funds.

---

## Bitcoin

### btc-mainnet-native

Current:
- MARKETPLACE_ONLY
- identity ready
- no automatic settlement

Before activation:
- Mainnet-specific confirmation policy;
- Mainnet fee/pinning qualification;
- hardware signer matrix;
- external review;
- release/provenance gates;
- owner approval;
- canary limits;
- real-funds kill switches with refund path never disabled.

---

## Litecoin

### ltc-mainnet-native

Current:
- MARKETPLACE_ONLY
- identity ready
- UTXO_LTC research family

Next evidence:
- Litecoin Core pinned release qualification;
- transparent base-chain-only protocol;
- explicit MWEB exclusion;
- script/timelock/sighash review;
- fee/RBF/dust policy;
- reorg matrix;
- recovery-before-lock;
- external signer qualification.

Activation remains blocked until all gates pass.

---

## Dogecoin

### doge-mainnet-native

Current:
- MARKETPLACE_ONLY
- identity ready
- UTXO_DOGE research family

Next evidence:
- Dogecoin Core tagged release pin;
- CLTV/script profile;
- fee/relay/dust qualification;
- replacement/fee-bump policy;
- AuxPoW-aware test design;
- reorg matrix;
- standalone recovery;
- external signer qualification.

No Bitcoin adapter reuse by substitution.

---

## Bitcoin Cash

### bch-mainnet-native

Current:
- MARKETPLACE_ONLY
- identity ready
- UTXO_BCH research family

Next evidence:
- BCHN release pin;
- post-2026 consensus/script review;
- Schnorr/ECDSA signer policy;
- BCH-specific sighash;
- timelock/refund construction;
- fee/mempool/dust behavior;
- reorg matrix;
- recovery;
- external signer qualification.

No Bitcoin P2WSH profile reuse.

---

## Monero

### xmr-mainnet-native

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- privacy-sensitive

Next evidence:
- Monero 0.18.5.x pinned qualification;
- ownership-proof model;
- wallet/node boundary;
- spend/view-key separation;
- noncustodial local signer design;
- fairness/recovery protocol;
- cryptographic specialist review.

No custom cryptography may be invented to accelerate activation.

---

## Zcash

### zec-mainnet-transparent

Current:
- MARKETPLACE_ONLY
- RESTRICTED

Next evidence:
- Zebra pinned node profile;
- transparent-only transaction profile;
- transaction-version/consensus-branch pinning;
- transparent script/sighash review;
- recovery and reorg qualification.

### zec-mainnet-sapling

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- identity not ready

Next evidence:
- pool-specific canonical identity;
- shielded signer/recovery model;
- privacy leakage analysis;
- cryptographic review.

### zec-mainnet-orchard

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- identity not ready

Next evidence:
- current post-NU6.2 Orchard profile;
- pool-specific identity;
- circuit/security review;
- signer/recovery design;
- independent cryptographic review.

No shielded pool inherits transparent qualification.

---

## Ethereum / EVM

### eth-mainnet-native

Current:
- MARKETPLACE_ONLY

Next evidence:
- minimal non-upgradeable escrow contract;
- reproducible compiler/build;
- immutable bytecode hash;
- chainId binding;
- refund path independent of backend;
- reentrancy/gas/reorg analysis;
- contract audit;
- external signer/hardware wallet profile.

### bnb-mainnet-native

Current:
- MARKETPLACE_ONLY

Requires a distinct deployment/profile even if EVM-compatible:
- exact chainId;
- exact deployed contract;
- chain-specific reorg/finality policy;
- RPC/watchers;
- fees.

### avax-c-mainnet-native

Current:
- MARKETPLACE_ONLY

Requires:
- Avalanche C-chain finality/reorg model;
- exact EVM deployment identity;
- independent chain watchers;
- chain-specific fee behavior.

EVM compatibility does not mean shared deployment trust.

---

## Stablecoins on EVM

### usdt-ethereum-mainnet

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- issuer controlled

Required:
- exact contract code/proxy state review;
- blacklist/freeze behavior;
- transfer return semantics;
- fee-on-transfer check;
- issuer risk policy;
- pre-trade revalidation;
- settlement contract compatibility.

### usdc-ethereum-mainnet

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- issuer controlled

Required:
- exact contract implementation/proxy state;
- blacklist/freeze behavior;
- native Circle asset verification;
- bridged forms prohibited unless separately registered;
- pre-trade code/issuer revalidation.

---

## Solana

### sol-mainnet-native

Current:
- MARKETPLACE_ONLY

Required:
- native SOL settlement program/profile;
- program id and upgrade authority policy;
- durable recovery;
- blockhash/nonce strategy;
- fee/retry behavior;
- hardware signer compatibility;
- independent RPC/watchers.

### usdt-solana-mainnet

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- issuer controlled

Required:
- exact mint;
- token program identity;
- mint/freeze authorities;
- extension inspection;
- issuer risk;
- settlement program compatibility.

### usdc-solana-mainnet

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- issuer controlled

Required:
- exact native Circle mint;
- token program identity;
- authority/extension inspection;
- bridged forms separate;
- settlement/recovery qualification.

Any Token-2022 asset additionally requires explicit extension policy for:
- transfer fees;
- permanent delegate;
- transfer hooks;
- confidential balances;
- non-transferable state;
- default account state.

---

## Tron

### usdt-tron-mainnet

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- issuer controlled

Required:
- exact TRC-20 contract review;
- Tron resource/fee model;
- freeze/blacklist behavior;
- noncustodial signer profile;
- recovery protocol;
- watcher finality policy.

No EVM assumptions may be reused automatically.

---

## XRPL

### xrp-mainnet-native

Current:
- MARKETPLACE_ONLY

Candidate future route:
`XRPL_XRP_ESCROW_PREIMAGE_V1`

Required:
- EscrowCreate/Finish/Cancel profile;
- PREIMAGE-SHA-256 condition binding;
- mandatory CancelAfter;
- Ripple Epoch conversion;
- validated-ledger timing;
- reserve requirements;
- sequence/ticket handling;
- destination tag policy;
- finish/cancel race qualification;
- backend-independent cancellation/recovery.

Issued tokens require separate profiles.

---

## Cardano

### ada-mainnet-native

Current:
- MARKETPLACE_ONLY

Required:
- exact UTXO/eUTXO settlement design;
- script language/version selection;
- datum/redeemer semantics;
- fee/min-UTXO behavior;
- signer/hardware support;
- refund/recovery proof;
- chain finality/reorg assumptions.

No Bitcoin UTXO adapter reuse.

---

## Kaspa

### kas-mainnet-native

Current:
- MARKETPLACE_ONLY

Required:
- DAG-specific confirmation/finality model;
- transaction/script capability review;
- fee/replacement model;
- recovery semantics;
- node/watcher qualification.

Do not model Kaspa as a linear Bitcoin chain.

---

## Firo

### firo-mainnet-native

Current:
- QUARANTINED
- identity not ready
- new offers blocked
- new trades blocked

Unquarantine requires:
- dedicated security review;
- current protocol/consensus audit;
- exact asset identity;
- wallet/signer review;
- settlement and recovery design;
- explicit owner decision after review.

---

## Qubic

### qubic-mainnet-native

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- identity not ready

Required:
- QPI/tick architecture research;
- canonical network/asset identity;
- signer model;
- settlement primitive;
- recovery semantics.

Do not treat Qubic as EVM.

---

## Pearl

### pearl-mainnet-native

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- identity not ready

Required:
- canonical project/network verification;
- consensus/security review;
- transaction model;
- signer/recovery model.

No activation until provenance and protocol identity are clear.

---

## Aleo

### aleo-mainnet-native

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- identity not ready

Required:
- canonical credits identity;
- private/public record model;
- program execution model;
- signer and key separation;
- recovery semantics;
- privacy leakage review.

---

## Tari

### tari-mainnet-native

Current:
- MARKETPLACE_ONLY
- RESTRICTED
- privacy-sensitive
- identity not ready

Required:
- canonical network identity;
- confidential transaction model;
- wallet/signing architecture;
- recovery/fairness model;
- cryptographic review.

---

## Activation procedure

No asset changes status merely because implementation code exists.

Promotion requires:
1. research complete;
2. identity pinned;
3. protocol spec complete;
4. implementation isolated;
5. tests executable and green;
6. recovery proven;
7. watcher conflict behavior proven;
8. reorg/fee/pinning behavior proven;
9. signer profile proven;
10. audit evidence recorded;
11. registry change reviewed;
12. explicit activation commit.

During the current no-test window, no promotion may occur.
