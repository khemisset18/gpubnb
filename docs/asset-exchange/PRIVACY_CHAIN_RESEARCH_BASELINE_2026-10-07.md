# Privacy Chain Research Baseline — 2026-10-07

Status: RESEARCHED / SPECIFIED / NO-TEST WINDOW / NO AUTOMATIC SETTLEMENT ACTIVATION

## Purpose

This document records the current official research baseline for:

- Zcash transparent transactions;
- Zcash shielded pools;
- Monero.

The goal is to prevent transparent-chain assumptions from leaking into privacy-preserving protocols and to keep all private spend authority outside gpu.k.p2p servers.

No runtime activation occurs from this document.

---

# Zcash

## Current node baseline

The currently reviewed Zebra line is 6.x.

Official Zcash Foundation release material reviewed during this baseline includes:

- Zebra 6.0.0: NU6.3 / Ironwood mainnet support;
- Zebra 6.1.0: security fixes and getstandardfee;
- Zebra 6.2.1: synchronization/mempool hardening;
- Zebra 6.4.2: security fix for malformed V6 transaction denial-of-service.

The qualification baseline for future implementation MUST use the latest separately reviewed stable Zebra release available when tests resume.

Do not pin an older 4.x/5.x release merely because previous design notes referenced it.

## Important 2026 protocol change

NU6.3 / Ironwood introduces:

- a new shielded pool;
- a V6 transaction format;
- separate note commitment tree;
- separate nullifier set;
- separate chain value pool and history metadata.

Therefore current Zcash cannot be modeled as only:

- transparent;
- Sapling;
- Orchard.

Ironwood is a distinct shielded profile and MUST have its own registry/security treatment if added.

## Transparent Zcash

Candidate future profile:

ZCASH_TRANSPARENT_V1

This profile must remain distinct from every shielded pool.

Required independent review:

- exact transaction version;
- consensus branch id;
- transparent script behavior;
- transparent sighash behavior;
- P2SH sigop rules;
- fee policy;
- ZIP-317 interaction;
- node standardness policy;
- reorg behavior;
- signer support;
- recovery behavior.

Recent Zebra security history includes transparent-script and sighash-consensus fixes.

This is material evidence that gpu.k.p2p must not reimplement Zcash transparent sighash or sigop accounting casually.

Where possible, use reviewed upstream libraries/nodes as validation oracles and differential-test any local logic.

## Shielded pools

Each pool requires its own profile:

- Sapling;
- Orchard;
- Ironwood.

No pool inherits another pool's qualification.

Required pool-specific analysis:

- note commitment tree;
- nullifier semantics;
- proving system;
- transaction version;
- consensus branch;
- spend authorization;
- viewing-key model;
- recovery semantics;
- privacy leakage;
- hardware signer support;
- proof-generation dependency;
- denial-of-service/resource limits.

## Current registry decision

Transparent Zcash remains MARKETPLACE_ONLY / RESTRICTED.

Shielded pool entries remain separate and non-automatic.

If Ironwood is added to the registry later, it must be a distinct entry and start disabled.

No shielded pool is eligible for automatic settlement during the no-test window.

---

# Monero

## Current official baseline

Current Monero software version observed from the official getmonero downloads/release pages:

0.18.5.3 "Fluorine Fermi"

The release was published on October 6, 2026.

Future qualification must pin:

- exact release tag;
- exact source commit;
- official hashes;
- official signing keys;
- reproducible-build evidence where available.

## Key architecture

A Monero standard address contains:

- public spend key;
- public view key;
- network/address-type byte;
- checksum.

Private-key roles are separate:

- private spend key authorizes spending;
- private view key recognizes incoming transactions.

This distinction is fundamental to the gpu.k.p2p custody boundary.

## Hard custody rule

gpu.k.p2p servers must never receive:

- mnemonic seed;
- private spend key;
- unrestricted wallet password;
- arbitrary wallet file;
- unrestricted local wallet RPC.

A server-side private view key is also privacy-sensitive and must not be treated as harmless merely because it cannot spend.

If viewing capability is needed, use the minimum disclosure model consistent with the product and legal/privacy requirements.

## View-only wallet limitations

Official Monero documentation states that a view-only wallet:

- can observe incoming transactions;
- cannot sign/spend by itself;
- cannot reliably infer all outgoing activity without additional key-image information;
- may have an incorrect balance after outgoing transactions unless key images are imported.

Therefore:

- view-only balance MUST NOT be treated as authoritative financial truth;
- watcher logic must model key-image availability;
- proof of incoming payment is not equivalent to proof that funds remain spendable.

## Ownership proof

Monero wallet tooling includes address/file signing and verification operations that can demonstrate control of a Monero address.

However, gpu.k.p2p must not treat transaction proofs, reserve proofs, spend proofs and address ownership proofs as interchangeable.

Each proof type must have a separately specified purpose.

Candidate future ownership-proof profile must define:

- domain separation;
- challenge binding;
- expiry;
- network binding;
- address binding;
- replay prevention;
- exact wallet command/library;
- privacy consequences.

## Multisig caution

Official Monero documentation describes multisig as a wallet-level feature, not a distinct on-chain multisig address type.

It requires exchange of wallet-level multisig information and shared knowledge including the public address and private view key.

Monero wallet RPC documentation still exposes experimental multisig controls.

Therefore gpu.k.p2p MUST NOT build its first XMR settlement protocol by assuming multisig behaves like Bitcoin script multisig.

Any Monero multisig-based protocol requires:

- dedicated cryptographic review;
- wallet-version compatibility analysis;
- round/failure recovery design;
- participant-offline handling;
- metadata/privacy analysis;
- explicit experimental-feature policy.

## Background/view-only operation

Monero wallet RPC supports background synchronization modes where spend authority can be removed from active memory while syncing continues with viewing capability.

This is useful as an architectural reference but does not authorize server custody of the spend key.

Preferred model:

- user/local-agent holds spend authority;
- gpu.k.p2p server receives only public settlement evidence needed for coordination;
- recovery artifacts remain user-controlled;
- server failure must not strand funds.

## Fairness and atomicity

No generic Bitcoin-style HTLC must be copied to Monero.

A future XMR protocol must explicitly prove:

- fairness assumptions;
- secret/adaptor-signature model if used;
- refund/recovery path;
- chain observation model;
- reorg behavior;
- fee behavior;
- wallet crash/restart behavior;
- offline participant recovery.

If adaptor signatures, DLEQ proofs, cross-curve constructions or custom cryptographic transforms are required:

- do not invent them in gpu.k.p2p;
- use reviewed constructions;
- obtain independent cryptographic specialist review.

## Current registry decision

XMR remains:

- MARKETPLACE_ONLY;
- RESTRICTED;
- privacySensitive=true;
- automaticSettlementSupported=false.

No activation until cryptographic review and executable evidence exist.

---

# Cross-privacy-chain rules

For every privacy-sensitive chain or pool:

1. canonical network identity must be explicit;
2. privacy model must be documented;
3. spend authority must remain user-side;
4. viewing capability must be minimized;
5. proofs must be purpose-specific;
6. backend logs must not contain privacy-sensitive wallet material;
7. recovery data must be encrypted where it contains sensitive metadata;
8. watcher data must not become an unintended tracking database;
9. compliance-mode data must stay isolated from GPUbnb Core;
10. Sovereign mode must not weaken cryptographic/recovery security;
11. legal/privacy policy and cryptographic security remain separate concerns.

## No-test-window restrictions

Allowed now:

- research;
- protocol comparison;
- proof taxonomy;
- privacy threat modeling;
- key-boundary design;
- future test plans.

Forbidden now:

- enabling Monero wallet RPC in production;
- storing view/spend keys;
- enabling Zcash shielded settlement;
- claiming shielded-pool qualification;
- claiming XMR atomicity;
- adding custom cryptography to a live path.

## Execution order after tests return

After LTC/DOGE/BCH qualification:

1. Zcash transparent;
2. Monero research harness / stagenet only;
3. shielded Zcash pools only after separate crypto review.

No shielded/private asset skips directly from catalog recognition to automatic settlement.
