# Chain Family Settlement Roadmap V1

Status: ARCHITECTURE / RESEARCH / NO TEST EXECUTION WINDOW

## Purpose

This roadmap defines the next settlement families after the transparent UTXO group.

The project does not use one universal swap engine.

Each chain family receives an independent protocol profile, signer model, recovery model, watcher policy and activation gate.

No family may inherit another family's security assumptions.

---

# Monero

## Research baseline

Reviewed release baseline:
- Monero CLI 0.18.5.3 "Fluorine Fermi"
- release date: 2026-10-06
- current release is highly recommended and contains a large set of bug fixes

## Architecture decision

Monero MUST remain a separate cryptographic research track.

Do not attempt to force Bitcoin-style HTLC semantics onto Monero.

Do not invent custom zero-knowledge or adaptor-signature schemes without independent cryptographic review.

The first production-capable Monero profile, if ever qualified, must define:
- exact wallet/node release;
- address ownership proof;
- view/spend-key separation;
- local signing architecture;
- recovery artifacts that never export private spend material;
- transaction construction and fee policy;
- lock/fairness mechanism;
- refund/recovery mechanism;
- watcher limitations under privacy constraints.

## Current route

- supportStatus = MARKETPLACE_ONLY
- riskLevel = RESTRICTED
- automaticSettlementSupported = false
- settlement route = null

---

# Zcash

## Research baseline

Important current facts:
- legacy zcashd reached End of Life in July 2026 and shut down at its end-of-support height;
- zcashd repository is archived;
- current node direction is Zebra, with Zallet as wallet tooling;
- Zebra 6.4.2 includes a security fix for remotely triggerable denial of service involving malformed V6 transactions;
- NU6.2 remediated a critical Orchard circuit flaw;
- transparent, Sapling, Orchard and newer shielded functionality must be treated as different risk surfaces.

## Architecture decision

Zcash MUST be split into independent pool profiles.

Candidate order:
1. transparent-only settlement research;
2. Sapling research;
3. Orchard research;
4. later shielded formats only after dedicated cryptographic review.

The first candidate profile is:

`ZEC_TRANSPARENT_V1`

and MUST:
- use current Zebra-compatible consensus assumptions;
- never silently accept shielded inputs/outputs;
- pin transaction version and consensus branch behavior;
- independently verify sighash and script rules;
- account for recent consensus/security history.

Sapling/Orchard are not aliases of transparent ZEC.

## Current route

Transparent:
- MARKETPLACE_ONLY
- RESTRICTED
- settlement route = null

Shielded pools:
- MARKETPLACE_ONLY or stricter
- separate identities/profiles
- settlement route = null

---

# EVM

## Architecture decision

EVM settlement requires a dedicated contract family.

No generic ERC-20 support may mean "all tokens are safe".

The candidate settlement contract must be:
- minimal;
- non-upgradeable;
- source-verifiable;
- immutable after deployment;
- no owner withdrawal;
- no arbitrary delegatecall;
- no proxy;
- no hidden admin recovery;
- chainId-bound;
- exact token-contract-bound;
- exact trade-term hash bound;
- refund path always available under stated assumptions.

## Native ETH profile

Candidate:
`EVM_NATIVE_ESCROW_V1`

Qualification requires:
- exact chainId;
- deployed bytecode hash;
- source/compiler reproducibility;
- CREATE2/deployment verification if used;
- explicit gas assumptions;
- reorg/finality policy;
- refund path independent of backend availability.

## ERC-20 / fungible token profile

Candidate:
`EVM_ERC20_ESCROW_V1`

Each token contract must be revalidated before trade.

Reject or restrict tokens with unsupported behavior including:
- fee-on-transfer;
- rebasing;
- blacklist/freeze;
- pausable transfers;
- upgradeable proxy semantics unless explicitly reviewed;
- callback/reentrancy behavior;
- non-standard return values;
- arbitrary mint/burn controls affecting settlement assumptions.

Stablecoins remain issuer-controlled assets even when contract identity is verified.

## Current route

- ETH mainnet: MARKETPLACE_ONLY
- ERC-20 tokens: MARKETPLACE_ONLY
- automatic settlement = false

No Mainnet contract deployment is authorized.

---

# Solana

## Architecture decision

Solana native SOL and token programs require separate profiles.

Candidate native route:
`SOLANA_NATIVE_ESCROW_V1`

Candidate token routes:
- `SOLANA_SPL_TOKEN_V1`
- `SOLANA_TOKEN_2022_V1`

These are not interchangeable.

## Token-2022 mandatory extension inspection

Before any Token-2022 trade, inspect mint/account extensions.

At minimum, detect and policy-gate:
- TransferFeeConfig;
- PermanentDelegate;
- ConfidentialTransfer / confidential balances;
- transfer hooks;
- non-transferable configuration;
- default account state;
- interest-bearing behavior;
- metadata/group-related extensions where relevant;
- authority changes that alter settlement assumptions.

PermanentDelegate is a material risk because the mint-level delegate can authorize transfers or burns from token accounts and owners cannot revoke it themselves.

TransferFeeConfig changes the delivered amount and retains withheld fees.

Confidential transfer requires client-side proof generation and different balance visibility.

## Current route

- SOL: MARKETPLACE_ONLY
- classic SPL tokens: MARKETPLACE_ONLY
- Token-2022: MARKETPLACE_ONLY / RESTRICTED depending on extensions
- automatic settlement = false

---

# XRP Ledger

## Research baseline

XRPL provides native Escrow objects.

Supported escrow forms include:
- time-based;
- PREIMAGE-SHA-256 conditional;
- combined time + condition.

Escrow lifecycle includes:
- EscrowCreate;
- EscrowFinish;
- EscrowCancel.

Expiration is represented with CancelAfter.

For XRP, conditional escrow can use a PREIMAGE-SHA-256 crypto-condition.

Token escrow adds issuer/trust-line/freeze/authorization concerns.

## Architecture decision

XRPL is a promising native-ledger settlement family because recovery can map to protocol-native escrow rather than a custom smart contract.

Candidate route:
`XRPL_XRP_ESCROW_PREIMAGE_V1`

Requirements:
- XRP first;
- explicit CancelAfter in every gpu.k.p2p escrow;
- no uncancellable escrow;
- exact Ripple Epoch conversion;
- validated-ledger close-time semantics;
- reserve requirements modeled;
- sequence/ticket behavior modeled;
- signer and destination-tag policy;
- independent ledger-source watchers;
- finish/cancel race tests;
- recovery possible without gpu.k.p2p backend.

Issued tokens and MPT/token escrow MUST be separate profiles because:
- issuer authorization may be required;
- freeze/lock state can affect finish/cancel behavior;
- transfer rates and token-specific constraints apply.

## Current route

- XRP: MARKETPLACE_ONLY
- issued XRPL tokens: MARKETPLACE_ONLY / RESTRICTED
- automatic settlement = false

---

# Cross-family activation requirements

For every new automatic settlement family:

1. official current implementation researched;
2. exact toolchain/release pinned;
3. independent chain identity defined;
4. signer model documented;
5. ownership proof documented;
6. final signed terms defined;
7. lock mechanism defined;
8. redeem mechanism defined;
9. refund mechanism defined;
10. recovery-before-lock supported;
11. backend-independent recovery supported;
12. watcher conflict behavior fail-closed;
13. fee spike behavior defined;
14. reorg/finality policy defined;
15. chain-specific adversarial tests specified;
16. formal state-machine impact analyzed;
17. security review recorded;
18. registry entry remains disabled until tested activation commit.

## Current architecture verdict

Keep the existing architecture:

- generic HTTP/API layer;
- canonical asset registry;
- per-chain settlement adapters;
- per-chain watchers;
- per-chain signer policy;
- chain-neutral trade state machine;
- chain-neutral recovery envelope with chain-specific payload;
- fail-closed registry activation.

Do NOT replace it with per-coin HTTP endpoints.

The architecture should evolve by adding isolated chain-family modules, not by branching application logic on token symbols.

## No-test window rule

During the current no-test period:
- this roadmap may be refined;
- protocol specs may be written;
- official releases may be researched and pinned in documentation;
- no new settlement adapter becomes executable;
- no registry entry gains automaticSettlementSupported;
- no Mainnet deployment or real-funds path is enabled.

When tests resume, qualification restarts from Litecoin, then Dogecoin, then Bitcoin Cash, followed by Zcash transparent / Monero research, then EVM, Solana and XRPL.
