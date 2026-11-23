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
  shape classifier, fails closed for wrong domains, witness versions
  outside this Exchange research profile, checksum, padding and mutations.
  Pearl's upstream consensus code also recognizes P2MR witness v2; this
  classifier does not validate or qualify that address type. **`rprl` is
  shared by regtest and simnet**; no network identity is proven by parsing
  an address.
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

## Phase 3 — garde architecturale de publication dans l'Exchange réel

Branche indépendante :
`experiment/pearl-prl-architecture-hardening-20261123`.

Cette phase ne modifie que des éléments d'Asset Exchange et
des documents Exchange. L'API d'offres existante est soumise
à une règle de refus PRL lorsque l'identité native est non
qualifiée. Le catalogue Exchange affiche désormais le symbole
`PRL` tout en laissant `newOffersEnabled=false` et toutes les
permissions financières à `false`.

`test_prl_exchange_gate.mjs` ajoute **10 tests Node.js**
de cette politique de refus avant tout vérificateur de
signature et toute écriture au repository. **Ces tests sont maintenant attestés sur Ubuntu WSL2 : 10/10 PASS**, avec les 94 tests Python (94/94) et les cinq tests Node de non-régression du registre Exchange (5/5). **Total : 109/109 PASS** sur le commit testé `60a3934`. Les commandes de test ont été exécutées dans un namespace réseau isolé, sans serveur ni signature.

Depuis un clone isolé de cette branche, sans serveur :

```sh
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 -m unittest discover -s asset-exchange/qualification/pearl -p 'test_*.py' -q
unshare --user --map-root-user --net \
  node --test asset-exchange/qualification/pearl/test_prl_exchange_gate.mjs
unshare --user --map-root-user --net \
  node --test asset-exchange/core/test/asset-registry.test.mjs
```

Le chemin d'acceptation d'éventuelles offres PRL historiques
reste un **blocage critique** à auditer et verrouiller
au niveau de la politique d'offre et de la base atomique
avant tout déploiement. Aucune publication d'offre PRL réelle,
aucune signature ni aucun règlement n'est autorisé ici.

Voir `docs/asset-exchange/PEARL_PRL_EXCHANGE_ARCHITECTURE_SECURITY_2026-11-23.md`.

## Phase 4 — historical PRL offer acceptance quarantine (draft, no deployment)

New experimental branch:
`experiment/pearl-prl-historical-acceptance-guard-20261123`.
This branch touches **Asset Exchange code and Exchange docs only**.

The actual Exchange `acceptOffer` service now obtains both asset
keys from the stored offer row and rejects PRL (including the
legacy ambiguous `prl` chain alias) **before external signature
verification and before repository acceptance writes**.
The PostgreSQL repository lookup includes both keys.

`db/migrations/010_prl_historical_offer_quarantine.sql` is
**NOT DEPLOYED**; its three triggers are designed to reject
new PRL offer inserts, trade inserts against historical PRL
offers and PRL offer state transitions to `CONSUMED` in
an Exchange-only database. No SQL migration or node was run.
Native SQL correctness remains **unverified**.

New test declarations: **14 historical-acceptance cases +
6 static migration structure cases + 1 PostgreSQL repository
lookup case + 1 alias publication case = 22**. **Operator WSL2 confirmed 143/143 tests PASS** at the exact tested commit `71d419b` (94 Python, 49 Node.js across PRL policy, SQL static contract, registry and Exchange API mock tests). The 6 migration checks inspect SQL text only: no PostgreSQL engine or triggers were executed.
Also re-run the original offer-service and PostgreSQL repository
mock test suites before any merge.

See `docs/asset-exchange/PEARL_PRL_HISTORICAL_OFFER_ACCEPTANCE_SECURITY_2026-11-23.md`.
PRL stays MARKETPLACE_ONLY / RESTRICTED, `newOffersEnabled=false`,
`newTradesEnabled=false`, `automaticSettlementSupported=false`.
No mining changes, API deployment, wallet, signatures or funds.

**Phase 4 operator update:** The isolated Ubuntu WSL2 run of the historical acceptance branch finished with **94 Python PASS + 49 Node.js PASS = 143/143** at commit `71d419b`; the worktree was clean. No live Exchange publishing, real signatures, PostgreSQL migration, blockchain, payments or mining operations were executed. This is not a native SQL or production qualification.


## Phase 5 — historic acceptance idempotency replay quarantine

Branch: `experiment/pearl-prl-idempotency-replay-quarantine-20261123`,
base PR #395; Asset Exchange files only.

The *previous* three SQL triggers cannot prevent an old idempotency
record from returning `CONSUMED` without touching offers/trades.
The proposed **UNDEPLOYED** SQL migration 011 checks the actual
stored offer/trade identity and the PRL quarantine before such a return,
while keeping the original function signature.

`test_prl_accept_replay_contract.mjs` contains **17 offline
static / harness tests**. Operator WSL2 confirmed **160/160 PASS**
at commit `f61dc5d6c7ead0a1448ccdd4b02cff45a3f27a4c` (94 Python,
66 Node). These static SQL checks do not execute migration 010/011
or establish PostgreSQL behavior.

A strictly scratch-only native PostgreSQL harness is in
`asset-exchange/db/test/prl_scratch_replay_run.sh`; it has not
been executed and is not an installation script. Do not direct it
to any existing database. The final qualification branch adds API
retry handling for non-PRL consumed offers, and code-level tests pass;
the required SQL behavior remains unverified until native PostgreSQL.

All PRL publishing and settlement permissions stay false.
No mining files, wallets, keys, funds or live exchange operations.

## Phase 6 — finale logicielle et durcissement idempotent (draft, non déployé)

Branche : `experiment/pearl-prl-final-qualification-20261123`,
PR brouillon #397, issue de la référence PR #396.

Le contrôle du code a découvert des replays insuffisamment liés au
résultat persistant dans les fonctions SQL de publication, annulation
et signatures de termes (migrations 003/007/009). La migration additive
012 ajoute la validation des hash/clé, la sérialisation transactionnelle,
et la vérification des identifiants et preuves stockés avant tout résultat
de rejeu. Les retries exacts après expiration n'ont plus besoin de l'horloge
applicative; les nouvelles écritures expirées restent refusées par l'API
et/ou la fonction atomique selon l'opération.

Les fichiers de test ajoutent un scénario PostgreSQL transactionnel
annulé pour les replays publication/annulation/termes et trois courses
à deux sessions dans `db/test/concurrency.sh`. Ces scénarios sont écrits,
mais **pas exécutés** : aucun binaire PostgreSQL ou moteur isolé n'est
disponible dans cette campagne. Les contrats Node sont statiques et ne
remplacent pas l'exécution sur PostgreSQL 16+.

Résultats logiciels finaux : `npm test` **171/171**, Node avec tous les
tests de qualification Pearl **231/231**, Python Pearl **94/94**, contrôle
JavaScript **83 modules PASS**, `bash -n` **PASS**. Les tests exécutés
n'incluent aucune chaîne active, wallet, signature réelle, transaction,
ni migration SQL native.

La qualification PostgreSQL native et la sécurité de production restent
**BLOCKED / NON QUALIFIÉE**. PRL reste `MARKETPLACE_ONLY / RESTRICTED`,
`identityReady=false`, `newOffersEnabled=false`, `newTradesEnabled=false`,
`automaticSettlementSupported=false`; la publication d'offres et le
règlement automatique restent interdits.
