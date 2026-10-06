# Account-Chain Research Baseline — 2026-10-07

Status: RESEARCHED / SPECIFIED / NO-TEST WINDOW / NO AUTOMATIC SETTLEMENT ACTIVATION

## Purpose

This document records the current architecture baseline for:

- EVM chains and ERC-20-like tokens;
- Solana native SOL, SPL Token and Token-2022;
- XRP Ledger native XRP and issued fungible tokens.

No executable settlement activation is authorized by this document.

---

# EVM

## Architecture decision

EVM compatibility is not a license to reuse one deployment across every chain.

Each network profile must bind:

- exact chainId;
- exact settlement contract address;
- exact bytecode hash;
- compiler/toolchain version;
- constructor parameters;
- fee/gas policy;
- finality/reorg policy;
- RPC/watchers;
- signer typed-data domain.

Candidate family:

EVM_MINIMAL_ESCROW_V1

The first production-oriented design should prefer a minimal, non-upgradeable contract unless a separately reviewed upgrade mechanism is proven safer for a specific deployment.

## Token rules

A token symbol is never sufficient identity.

Every ERC-20-like asset must bind:

- chainId/network;
- contract address;
- decimals;
- implementation/proxy state where applicable;
- code hash or reviewed implementation identity;
- issuer/control risks;
- transfer semantics.

Pre-trade revalidation must detect material changes.

## Token hazards to gate

At minimum:

- blacklist/freeze controls;
- pause controls;
- proxy upgrades;
- fee-on-transfer behavior;
- rebasing behavior;
- non-standard transfer return values;
- callback/reentrancy behavior;
- mint/burn authority;
- permit/signature domain behavior;
- transfer restrictions;
- sanctions/issuer control where applicable.

USDT and USDC entries remain distinct by network and contract.

Bridged variants are separate assets.

## Signing boundary

Use chain-bound typed data where appropriate.

Signing prompts must bind:

- chainId;
- contract;
- tradeId;
- termsHash;
- asset;
- amount;
- recipient;
- refund condition;
- fee policy;
- expiry.

No server custody of EVM private keys.

## Recovery

Contract recovery must remain callable without gpu.k.p2p backend.

If refund requires:
- a backend signature;
- operator approval;
- privileged role;
- upgradeability admin;
then the design fails the noncustodial recovery invariant.

---

# Solana

## Token-program identity

Official Solana documentation distinguishes two token programs:

Classic Token Program:
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

Token-2022:
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

The token program is part of asset/settlement semantics.

An ATA is derived using wallet + mint + token program, so a mint cannot be handled correctly without the program identity.

## Architecture profiles

Candidate profiles must remain separate:

- SOLANA_NATIVE_ESCROW_V1
- SOLANA_SPL_TOKEN_V1
- SOLANA_TOKEN_2022_V1

No Token-2022 asset may silently fall back to classic SPL handling.

## Token-2022 extension gate

Every Token-2022 mint must be re-inspected before trade.

At minimum detect and policy-gate:

- TransferFeeConfig;
- PermanentDelegate;
- TransferHook;
- Confidential Balances / Confidential Transfer;
- NonTransferable;
- DefaultAccountState;
- InterestBearingConfig;
- MintCloseAuthority;
- MemoTransfer;
- CPI Guard;
- Pausable behavior;
- any new extension that changes transfer or recovery assumptions.

Unknown material extension:
- fail closed;
- no automatic settlement.

## TransferFeeConfig

Official Solana documentation states that transfer fees reduce delivered amount and store withheld fees.

Therefore the signed terms must distinguish:

- gross amount;
- expected fee;
- net delivered amount;
- authority capable of withdrawing withheld fees.

A token with mutable fee configuration requires pre-trade revalidation.

## PermanentDelegate

Official Solana documentation states that a permanent delegate can authorize transfers or burns for token accounts and token owners cannot revoke that delegate.

This is a material issuer/control risk.

Default policy for automatic settlement should be:
- reject PermanentDelegate unless an explicit asset-specific security policy approves it.

## TransferHook

A transfer hook invokes another program during transfers and may require additional accounts.

Official documentation also notes that the hook program/configuration can evolve and should be re-checked for each transfer.

Therefore:
- never cache hook safety indefinitely;
- bind expected hook/program identity;
- resolve required accounts from current on-chain state;
- treat unreviewed hooks as RESTRICTED or MARKETPLACE_ONLY.

## Confidential Balances

Confidential balance extensions change:
- balance visibility;
- transfer flow;
- proof generation;
- verification dependencies.

They require a separate settlement profile and privacy review.

No classic-token settlement adapter may process confidential-balance tokens.

## Native SOL

Native SOL requires a separate profile from token programs.

The future profile must bind:

- cluster/network;
- program IDs;
- account metas;
- fee payer;
- recent blockhash or durable nonce strategy;
- rent/account lifecycle assumptions;
- signer identities;
- recovery transaction strategy.

No Mainnet program deployment is authorized during the no-test window.

---

# XRP Ledger

## Native escrow primitive

XRPL provides protocol-native escrow.

Relevant lifecycle:

- EscrowCreate;
- EscrowFinish;
- EscrowCancel.

Official documentation supports:
- time-based escrow;
- PREIMAGE-SHA-256 conditional escrow;
- expiration through CancelAfter;
- combinations of time and condition depending on asset/profile.

Candidate native-XRP route:

XRPL_XRP_ESCROW_PREIMAGE_V1

## Mandatory recovery decision

gpu.k.p2p native XRP escrows should require a CancelAfter recovery path.

An escrow without a recoverable expiration is not acceptable for this product.

CancelAfter is immutable after creation.

After expiration, EscrowCancel returns funds to the sender when ledger-time conditions are satisfied.

Any account may submit EscrowCancel, which is useful for backend-independent recovery.

## Time semantics

XRPL escrow time values use seconds since the Ripple Epoch.

Release/cancel eligibility depends on validated-ledger close time, not the user's wall clock.

The future adapter must therefore bind:

- exact Ripple Epoch conversion;
- validated-ledger source;
- close-time rounding/tolerance;
- CancelAfter;
- optional FinishAfter;
- confirmation/validated-ledger policy.

Do not reuse Bitcoin block-height timeout logic.

## PREIMAGE-SHA-256

XRPL's supported escrow crypto-condition is PREIMAGE-SHA-256.

The future profile must bind:
- condition bytes;
- fulfillment format;
- tradeId;
- termsHash;
- destination;
- amount;
- CancelAfter.

No generic cross-chain atomicity claim is made merely because a preimage condition exists.

## XRP reserves and fees

Escrow creates a ledger object and affects reserves.

The adapter must model:
- owner reserve;
- transaction fees;
- object lifecycle;
- sequence or Ticket usage.

Small trades may be economically inappropriate if reserve/fee overhead is too high.

## Issued token escrow

XRPL token escrow is materially different from native XRP.

Trust-line tokens require issuer/account configuration such as Allow Trust Line Locking.

MPTs require relevant escrow/transfer flags.

If authorization is required, sender and recipient may require issuer authorization.

Therefore token escrow requires separate profiles.

## Freeze / lock risk

Issued XRPL tokens may be affected by:

- individual freeze;
- deep freeze;
- global freeze;
- issuer authorization;
- MPT locking;
- transfer fees;
- clawback-related policy.

Official XRPL documentation notes that a deep-frozen/locked token recipient may be unable to finish an escrow while cancellation can still return funds.

This must be represented in:
- pre-trade validation;
- WYSIWYS terms;
- risk status;
- recovery logic.

XRP itself is not issuer-frozen in the same manner as issued tokens.

## Current registry decision

XRP:
- MARKETPLACE_ONLY;
- automaticSettlementSupported=false.

Issued XRPL tokens:
- separate identities;
- MARKETPLACE_ONLY or RESTRICTED;
- no inheritance from XRP native escrow qualification.

---

# Cross-family security rules

## Identity

Every account-chain asset must bind:
- chain/network;
- native vs token;
- contract/mint/issuer identifier;
- decimals/precision;
- program/contract family.

No symbol routing.

## Mutable control revalidation

Before every trade, revalidate mutable controls when relevant:

EVM:
- proxy implementation;
- paused/frozen state;
- code hash;
- issuer controls.

Solana:
- mint authorities;
- freeze authority;
- token program;
- Token-2022 extensions;
- hook/delegate configuration.

XRPL tokens:
- issuer flags;
- trust-line authorization;
- freeze/deep-freeze/global-freeze;
- MPT lock state;
- escrow eligibility.

## Recovery invariant

A settlement family is ineligible for automatic settlement unless the honest user can recover without:

- gpu.k.p2p website;
- gpu.k.p2p API;
- gpu.k.p2p workers;
- gpu.k.p2p operator signature.

## No-test-window policy

During this window:

Allowed:
- research;
- protocol specs;
- contract/program design;
- adversarial test design;
- candidate toolchain pins.

Forbidden:
- deploy EVM escrow contracts;
- deploy Solana programs;
- submit XRPL escrows;
- enable Mainnet RPC write paths;
- promote registry capabilities;
- claim qualification.

## Future execution order

After UTXO-family qualification:

1. EVM minimal escrow on isolated local/test chain;
2. Solana native SOL profile;
3. classic SPL token profile;
4. Token-2022 only after extension matrix qualification;
5. XRPL native XRP escrow;
6. XRPL issued tokens only as separate profiles.

No family skips its independent recovery and signer gates.
