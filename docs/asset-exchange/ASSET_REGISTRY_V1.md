# Executable Asset Registry V1

Status: G5 FOUNDATION / NO REAL FUNDS / NO MAINNET SETTLEMENT

## Purpose

The registry converts the Asset Exchange taxonomy into fail-closed machine decisions.

It does **not** mean every listed asset is securely swappable.

Each record separately binds:
- registry id;
- canonical chain/network/asset identity when verified;
- public support status;
- dynamic-risk baseline;
- marketplace capability;
- new-offer capability;
- new-trade capability;
- ownership-proof capability;
- lock/redeem/refund/recovery capability;
- automatic settlement capability;
- settlement route, if and only if automatic settlement is enabled;
- research family.

## Routing rule

There are not separate HTTP implementations like `/btc`, `/doge`, `/xmr`.

HTTP routes are generic. The registry decides which exact chain/network/asset can progress.

This avoids symbol ambiguity and prevents one chain's assumptions from silently leaking into another.

## Current automatic settlement

Only:

`bitcoin | regtest | NATIVE | BTC_NATIVE | 8`

routes to:

`BITCOIN_P2WSH_HTLC_V1_REGTEST`

This is still no-real-funds and not Mainnet authorization.

## Stablecoins

Stablecoins are represented by exact contract/mint identifiers.

Examples currently pinned:
- USDT Ethereum mainnet;
- USDT Solana mainnet;
- USDT Tron mainnet;
- USDC Ethereum mainnet;
- USDC Solana mainnet.

They remain MARKETPLACE_ONLY because issuer controls, freeze/blacklist semantics, contract/program behavior, recovery and settlement protocol review remain separate gates.

Bridged and wrapped variants are not aliases of native issuer forms.

## Experimental assets

Qubic, Pearl, Aleo and Tari remain visible as catalog/R&D entries with `identityReady=false` until exact network identity and settlement assumptions are independently verified.

Firo is QUARANTINED in this V1 registry pending dedicated security review.

## Hard invariant

`automaticSettlementSupported=true` is rejected unless:
- canonical identity is verified;
- support status is SECURE or LIMITED;
- lock is supported;
- redeem is supported;
- refund is supported;
- recovery is supported;
- an explicit settlement route exists.

Knowing an asset is never sufficient to claim secure settlement.
