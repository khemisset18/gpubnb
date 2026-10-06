# Chain Adapter Contract V1

Status: ARCHITECTURE / SPECIFIED / NO-TEST WINDOW / NON-EXECUTABLE

## Purpose

This document defines the mandatory boundary between gpu.k.p2p chain-neutral trade logic and every chain-specific settlement implementation.

The objective is to prevent protocol assumptions from leaking across chains.

Examples of forbidden leakage:
- using Bitcoin fee logic for Dogecoin;
- using Bitcoin P2WSH assumptions for Bitcoin Cash;
- treating Qubic as EVM;
- treating SPL Token and Token-2022 as equivalent;
- treating XRPL escrow as a smart-contract clone;
- treating shielded and transparent Zcash pools as the same asset.

## Architectural rule

The core trade state machine must not know how any chain serializes, signs, broadcasts or refunds a transaction.

The chain adapter is responsible for all chain-specific behavior.

The core may consume only typed, canonical, signed outputs from the adapter boundary.

## Module isolation

Target module boundary:

asset-exchange/settlement/<chain-family>/

Examples:

- settlement/bitcoin/
- settlement/litecoin/
- settlement/dogecoin/
- settlement/bitcoin-cash/
- settlement/monero/
- settlement/zcash-transparent/
- settlement/evm/
- settlement/solana/
- settlement/xrpl/

One chain adapter MUST NOT import another adapter's settlement implementation.

Chain-neutral modules may be imported by adapters.

## Mandatory adapter identity

Every adapter specification must define:

- adapterId;
- adapterVersion;
- chainId;
- supported networkIds;
- supported asset types;
- supported canonical asset identifiers;
- protocol domain;
- protocol version;
- toolchain baseline;
- support status;
- recovery version.

No adapter may activate from symbol matching.

## Mandatory capability declaration

Each adapter must explicitly declare booleans for:

- ownershipProof;
- lock;
- redeem;
- refund;
- recovery;
- rebroadcast;
- feeBump;
- reorgAware;
- watcherConflictAware;
- externalSigner;
- hardwareSigner;
- partialFill;
- tokenSupport;
- privacySensitive;
- issuerControlled;

Unknown capabilities default to false.

No implicit capability inheritance is allowed.

## Automatic-settlement precondition

automaticSettlementSupported may become true only when ALL are true:

- canonical identity is verified;
- final terms are signed by all required parties;
- lock construction is deterministic;
- redeem construction is deterministic;
- refund construction is deterministic;
- refund is independently recoverable;
- recovery bundle exists before lock broadcast;
- watcher disagreement fails closed;
- fee policy is explicit;
- confirmation/finality policy is explicit;
- chain-specific signer policy is explicit;
- release/toolchain is pinned;
- test evidence exists;
- audit evidence exists;
- registry activation is a separate reviewed commit.

During the no-test window, this condition cannot be satisfied for a new chain.

## Required input contract

The chain adapter may receive only canonical inputs.

At minimum:

- deploymentId;
- tradeId;
- termsHash;
- canonical give/want asset identity;
- exact integer atomic amount;
- policyEpoch;
- feePolicy reference;
- confirmation/finality policy;
- recovery policy;
- chain/network id;
- party public signing identities;
- chain-specific public settlement parameters.

Forbidden adapter inputs:

- server-held private keys;
- seed phrases;
- spend keys;
- wallet passwords;
- arbitrary filesystem paths;
- shell commands;
- untrusted RPC URLs supplied directly by trade participants.

## Required output contract

Every chain-specific build operation must return immutable structured output.

For lock:
- canonical transaction/template bytes;
- deterministic transaction identity when available;
- exact inputs;
- exact outputs;
- exact amount;
- exact fee terms;
- timeout/recovery conditions;
- human-verifiable summary;
- recovery material reference;
- protocol hash.

For redeem:
- referenced lock identity;
- exact spend path;
- exact destination;
- exact amount;
- exact fee policy;
- required proof/secret condition;
- serialized unsigned/signed artifact as applicable.

For refund:
- referenced lock identity;
- exact timeout/condition;
- exact destination;
- exact amount;
- fee-bump strategy;
- backend-independent recovery artifact.

## Signing boundary

Adapters MUST NOT require gpu.k.p2p servers to hold spend authority.

Signing must occur through one of:

- browser wallet;
- hardware wallet;
- WalletConnect-like external wallet;
- local loopback signing agent;
- externally imported signed transaction/template.

The adapter may request a narrowly scoped signature over explicit bytes or typed data.

The adapter may not request:
- arbitrary message signing unrelated to current trade;
- arbitrary transaction signing;
- shell execution;
- filesystem reads;
- raw private-key export.

## WYSIWYS requirement

Before signature, the user-facing summary must be derivable from the exact object being signed.

At minimum display:
- chain;
- network;
- asset;
- amount;
- counter-asset;
- fee;
- refund condition;
- timeout;
- settlement route;
- trade id;
- terms hash.

If the UI cannot derive the summary from exact signed bytes/typed data, signing must stop.

## Watcher boundary

Watchers are evidence providers, never settlement authorities.

Each adapter must define:
- accepted evidence types;
- minimum independent sources;
- conflict state;
- uncertain state;
- reorg downgrade behavior;
- mempool vs confirmed distinction;
- finality/confirmation threshold.

A single RPC result cannot finalize a trade unless the chain profile explicitly proves that model safe.

## RPC isolation

Every adapter must use an allowlisted, operator-configured RPC profile.

Forbidden RPC targets:
- localhost unless explicitly assigned to that adapter;
- cloud metadata endpoints;
- Core database;
- Core Redis;
- PostgreSQL;
- internal service discovery;
- arbitrary participant-provided hosts.

RPC credentials belong only to the Asset Exchange environment.

## Fee policy boundary

Each chain must own its fee model.

No generic "sat/vB" assumption is permitted.

The adapter must define:
- fee unit;
- estimator source;
- minimum relay assumptions;
- dust/min-output policy;
- replacement strategy;
- fee-bump strategy;
- maximum permitted fee;
- emergency recovery fee behavior.

## Timelock boundary

The adapter must explicitly define:
- absolute vs relative timeout;
- height vs time semantics;
- median-time or ledger-time semantics;
- required transaction version/sequence fields;
- refund earliest-valid condition;
- maximum safe broadcast delay;
- confirmation/finality budget;
- reorg safety budget.

No timeout constant may be copied from another chain merely because block times look similar.

## Recovery contract

Recovery is mandatory before lock broadcast.

The adapter must produce enough non-secret recovery material for the user to recover without:
- gpu.k.p2p web frontend;
- gpu.k.p2p API;
- worker;
- database;
- operator intervention.

The recovery artifact may contain:
- signed or signable refund transaction/template;
- public lock data;
- script/program/contract identity;
- timeout condition;
- exact destinations;
- fee-bump instructions;
- independent verification data.

It must never contain:
- seed phrase;
- raw private key;
- unrestricted spend authority.

## Chain-specific examples

### Bitcoin / Litecoin / Dogecoin / Bitcoin Cash

Each gets an independent UTXO profile.

Shared concepts do not imply shared implementation.

Must independently bind:
- script form;
- sighash;
- timelock;
- transaction version;
- sequence;
- fee;
- dust;
- RBF/replacement;
- malleability assumptions;
- signer behavior.

### EVM

Must bind:
- chainId;
- contract address;
- bytecode hash;
- token contract;
- token code/proxy state;
- typed-data domain;
- gas policy;
- refund function semantics.

### Solana

Must bind:
- cluster/network;
- program id;
- program upgrade authority policy;
- mint;
- token program id;
- Token-2022 extensions;
- recent blockhash/durable nonce policy;
- account metas.

### XRPL

Must bind:
- network;
- ledger index/timing assumptions;
- EscrowCreate parameters;
- PREIMAGE-SHA-256 condition when used;
- CancelAfter;
- destination;
- destination tag policy;
- sequence/ticket.

### Privacy chains

Monero, shielded Zcash and similar families require a separate cryptographic review.

No cross-chain generic secret-sharing or atomic-swap construction may be invented inside the adapter layer.

## State-machine interaction

The core state machine may request only abstract operations:

- PREPARE_RECOVERY;
- PREPARE_LOCK;
- BROADCAST_LOCK;
- OBSERVE_LOCK;
- PREPARE_REDEEM;
- BROADCAST_REDEEM;
- OBSERVE_REDEEM;
- PREPARE_REFUND;
- BROADCAST_REFUND;
- OBSERVE_REFUND.

The adapter returns evidence/results.

The adapter must not directly mutate trade state.

PostgreSQL remains the financial state truth.

## Failure behavior

Any adapter error before lock:
- fail closed;
- do not broadcast;
- do not advance trade state.

Any adapter uncertainty after lock:
- stop irreversible progression;
- preserve redeem/refund/recovery;
- do not disable refund;
- surface recovery path.

Unknown protocol version:
- reject.

Unknown asset/network:
- reject.

Unknown signer capability:
- reject.

Unknown fee semantics:
- reject.

## Versioning

Every settlement adapter release requires:
- source commit;
- semantic adapter version;
- protocol version;
- toolchain version;
- artifact hash;
- SBOM/provenance;
- test evidence;
- compatibility matrix.

Protocol version changes require new signed-term domains or explicit compatible version rules.

## No-test-window rule

During the current no-test period:

Allowed:
- refine this contract;
- research chain behavior;
- write chain-specific protocol specs;
- write adversarial test plans;
- pin candidate toolchains in documentation.

Forbidden:
- enable new adapter imports in live runtime;
- enable broadcast;
- promote registry automaticSettlementSupported;
- claim qualification success.

When executable tests return, implementation resumes in this order:

1. Litecoin;
2. Dogecoin;
3. Bitcoin Cash;
4. Zcash transparent;
5. Monero research;
6. EVM;
7. Solana;
8. XRPL;
9. remaining experimental chains.

This ordering may change only through a documented security rationale.
