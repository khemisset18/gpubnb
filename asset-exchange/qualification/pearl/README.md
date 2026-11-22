# Pearl (PRL) — separate offline public-offer laboratory

This directory is an **additive, non-operational** research qualification
for native Pearl L1 (`PRL`), **not MTN**, not a wrapped/bridged PRL,
and not an executable exchange adapter.

The GPUbnb mining selector already shows `PRL Pearl`, but with no
hardware-validated profile. The Asset Exchange matrix already lists
`pearl-mainnet-native` with `MARKETPLACE_ONLY`,
`RESTRICTED`, and identity not ready. This lab does **not**
connect live offers, wallets or settlement to either catalog.

Contents:
- `address_guard.py`: public Bech32m witness v1 32-byte `rprl`
  shape classifier, fails closed for wrong domains, v0/v2, checksum,
  padding and mutations. **`rprl` is shared by regtest and simnet**;
  no network identity is proven by parsing an address.
- `offline_preflight.py`: public *fictional* PRL/DOGE marketplace
  listing-envelope validator. It cannot post offers or transfer coins.
- `fixtures/public_prl_offer_v1.json`: entirely fictitious
  amount and quote; not executable, not a market price.
- `test_address_guard.py` and `test_offline_preflight.py`:
  **47 isolated deterministic methods**. These have run PASS
  in the assistant's local development environment, not yet on WSL2.

Run from the repository root, Pearl-only worktree, offline:

    PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net python3 -m unittest discover -s asset-exchange/qualification/pearl -p 'test_*.py' -v

All reports keep `canSign=false`, `canBroadcast=false`,
`automaticSettlementSupported=false` and no real-world qualification.
No node, miner, RPC, wallet, keys, signing, real funds, transaction
or network access occurs during tests.

Official source snapshot reviewed:
https://github.com/pearl-research-labs/pearl/tree/29c2b03009143c98f4519271d716bd5535762a18
See `docs/asset-exchange/PEARL_PRL_ADAPTER_RESEARCH_V1.md`
for the P0–P9 blocked gate matrix and major unknowns.

## Second phase — security-only in-memory offer draft lifecycle (separate draft PR)

`marketplace_draft_lab.py` is a deliberately **NON-DEPLOYABLE** in-RAM
PRL/DOGE *fictional draft* lifecycle. It can simulate create,
owner-label view/list, cancel and expiry, idempotency and revision
checks, bounded quotas, and thread contention. It cannot post an
offer, identify a user, persist an order, contact the chain, sign,
fund or settle anything.

`actor_label` is a **self-asserted test label, NOT authentication**.
`now_tick` is a **caller-controlled test clock, NOT server time**.
`prl-lab-XXXXXXXX` identifiers are predictable and MUST NOT be
used as credentials. These are **critical production blockers**:
this Python class must never be imported into a live API as an
offer/publishing service.

- `test_marketplace_draft_lab.py`: **47 new adversarial unit
  methods**, passing locally under `unshare --user --map-root-user --net`.
- `demo_marketplace_drafts.py`: runs a bounded fake create/cancel
  example using the bundled non-executable fixture, outputs two
  JSON snapshots with all financial permissions false.
- Existing 47 address + preflight tests were verified previously
  on operator Ubuntu WSL2; **94 distinct methods are expected after
  updating to the new development branch**, not yet attested on
  the operator's PC.
- Full STRIDE review:
  `docs/asset-exchange/PEARL_PRL_MARKETPLACE_SECURITY_REVIEW_2026-11-23.md`.

Commands from the root of an isolated clone of the development branch:

```sh
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 -m unittest discover -s asset-exchange/qualification/pearl -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 asset-exchange/qualification/pearl/demo_marketplace_drafts.py
```

**This does NOT implement public marketplace listings or satisfy
Pearl production / native P0–P9 qualification.** PRL remains
`MARKETPLACE_ONLY / RESTRICTED` with
`automaticSettlementSupported=false`.
