# GPUbnb Pearl (PRL) — evidence log, 2026-11-22

Scope: **PRL native L1 research**, no production activation or financial route.
Branch: `experiment/pearl-prl-offline-preflight-20261122`.
Base: `experiment/doge-d8-ledger-emulator-free-20261122`.
DO NOT change the DOGE branch or local DOGE worktree.

## Discovery and provenance

1. GPUbnb `apps/host-desktop/src/main.ts` has
   `{ symbol: 'PRL', name: 'Pearl' }` in `MINING_CATALOG`,
   with no executable profile or validated hardware indicator.
2. `docs/asset-exchange/ASSET_ACTIVATION_MATRIX_V1.md`
   lists `pearl-mainnet-native` as
   `MARKETPLACE_ONLY / RESTRICTED / identity not ready`.
3. User corrected an earlier ticker typo: **PRL**, not MTN.
4. Official project: https://pearlresearch.ai and
   https://github.com/pearl-research-labs/pearl .
   Source snapshot examined by GitHub read:
   `29c2b03009143c98f4519271d716bd5535762a18`.
5. Static Go reference source `node/chaincfg/params.go`,
   `node/wire/protocol.go` and `node/btcutil/address_test.go`
   identifies the `prl/tprl/rprl` Bech32 HRPs, distinct network
   magics and candidate P2TR v1. **Regtest and simnet share `rprl`**.
   P2MR uses v2 in `node/btcutil/address.go`; it is intentionally
   rejected by the candidate v1-only guard.

**P0/P1 NOT QUALIFIED**: no authenticated binary release,
no actual genesis/node identity attestation, no executable Pearl
Core daemon; no evidence of real mining/recovery/transaction semantics.

## Initial code-and-test evidence

Files created only under
`asset-exchange/qualification/pearl/` plus Pearl-only documents:

- Bech32m/v1 `rprl` classification of a public synthetic
  32-byte witness program; no script interpreter, no keys.
- Synthetic, non-posted PRL/DOGE public-offer fixture;
  strictly bound PRL symbol/chain and false financial permissions.
- Two suites with **47 distinct unittest methods**.

Local developer sandbox run (not the user's WSL2):

```text
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p 'test_*.py' -v
Ran 47 tests in 0.011s
OK
```

This local run was **without network namespace isolation**, but the
Python modules contain no networking or file I/O code. The intended
WSL2 qualification command uses `unshare --user --map-root-user --net`.
No user WSL2 PRL tests have yet been reported.

No live offers, public exchange endpoint changes, transactions,
wallets, private keys, signatures (even synthetic), node, miner,
RPC, broadcast, real funds, Docker or production deployment.
**P2 outcome: OFFLINE_SHAPE_PASS only. P0/P1 and P3–P9 blocked
or deferred.**

## Required follow-up

- Operator: test the Pearl branch in a **distinct detached worktree**
  with `PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net`;
  log exact commit, test count, errors and git cleanliness.
- Independent upstream provenance; script/policy audit; identity binding
  independent of HRP; later separate reviewed marketplace-only listing
  implementation if allowed.
- Keep `MARKETPLACE_ONLY`, `RESTRICTED`,
  `automaticSettlementSupported=false`, and PR in **draft**.

## Local offline network-namespace rerun of the exact published Python files

The five source/fixture blob SHAs were checked against the locally tested files:

```text
address_guard.py                 ffa0c4929035c236325a1f6d3624e752730787a7
offline_preflight.py             c52eebc97d88f55e43d2b7cec6e5fdbd238e578f
test_address_guard.py            ced428cdb58c6b008ec71636053ba0530c122f5b
test_offline_preflight.py        717cbcfe1abfcabace141bc8ba6685710c6bf5a2
fixtures/public_prl_offer_v1.json abd1c8e1d93ebb4b28c35eb31b483bbecee5b999
```

With the exact same files, a second local run used a real user/network
namespace. It returned:

```text
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net python3 -m unittest discover -s . -p 'test_*.py' -v
Ran 47 tests in 0.009s
OK
```

**Qualification evidence: 47/47 tests PASS in the assistant sandbox,
including a network-namespace run.** This is **NOT** yet a run on the
operator's WSL2 computer. No PRL full-node, RPC, miner, hardware,
wallet, signing, network broadcast or real funds was used.

**P0–P9 remain not qualified for real financial settlement.**

## Confirmation opérateur — 47/47 tests sur Ubuntu WSL2

Le compte rendu collé depuis l'Ubuntu WSL2 de l'opérateur confirme
l'exécution des **47 méthodes de test** du seul dossier PRL :

```text
=== PEARL PRL : TESTS HORS LIGNE ===
Ran 47 tests in 0.019s
OK
=== COMMIT ET ETAT GIT PRL ===
a4f66fa
## experiment/pearl-prl-offline-preflight-20261122...origin/experiment/pearl-prl-offline-preflight-20261122
```

La commande a utilisé `PYTHONDONTWRITEBYTECODE=1` et
`unshare --user --map-root-user --net`. Répartition :
**21 contrôles de format d'adresse Bech32m PRL** et
**26 validations d'enveloppe d'offre PRL/DOGE synthétique**.
Le commit exact ayant servi à cloner ce worktree :
`a4f66faf45de253c7ed1067fbc041b4c6792301a`.
Le worktree est sur sa branche de suivi (et non en HEAD détachée)
et le journal n'indique aucune modification locale.

**État vérifié : PRL_OFFLINE_47_PASS / HARDWARE_NODE_AND_SETTLEMENT_BLOCKED.**
Les tests n'autorisent toujours ni offre publiée, ni vraie transaction,
ni clé, signature, financement, échange, nœud, RPC ou broadcast.
L'indépendance réelle regtest/simnet reste non démontrée par HRP
(`rprl` partagé). P0/P1/P3–P9 restent non qualifiés ou différés.

## Complément sécurité des brouillons PRL — 23 novembre 2026

Branche additionnelle distincte :
`experiment/pearl-prl-marketplace-draft-security-20261123`,
partant de la branche Pearl préflight. Le diff doit rester limité
à `asset-exchange/qualification/pearl/` et aux documents Pearl.

Le nouveau composant `marketplace_draft_lab.py` simule
exclusivement des brouillons PRL/DOGE non publiables et non réglables.
Identifiant d'acteur, horloge, clé de commande, id de brouillon
et prix sont tous **fictifs et non authentifiés**.
Les sorties ne publient aucune offre ; tous les droits financiers
restent `false`. Aucune route API / Web ni mécanisme financier modifié.

### Preuves en environnement local de construction

```text
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 -m unittest discover -s . -p 'test_*.py' -q
----------------------------------------------------------------------
Ran 47 tests in 0.021s
OK
```

Les 47 nouvelles méthodes passent dans l'environnement de
construction isolé. Sont testés : mutations de schéma, identités
démonstratives divergentes, IDOR simulé, idempotence, anti-replay
concurrent, révision d'annulation, TTL, quotas, copies de sortie
et absence d'I/O lors des opérations.

Le même sandbox réseau isolé a exécuté
`python3 demo_marketplace_drafts.py` : première sortie
`DRAFT_PREVIEW_ONLY` puis `CANCELLED_PREVIEW_ONLY`, avec
`realExchangeListingCreated=false` et toutes les autorisations
financières à `false`.

Empreintes Git des **fichiers publiés = fichiers testés localement** :

- `marketplace_draft_lab.py` :
  `51d1525d8658c5a02af96a2c2b28138adb35cc43`.
- `test_marketplace_draft_lab.py` :
  `f7eaa26ac9700ced8db519fcb5d727d722806ead`.
- `demo_marketplace_drafts.py` :
  `b94da2f0fa890a3226e314346e69f3f8b57afe48`.

Le total de l'ensemble Pearl devient **94 tests attendus** :
47 préflight/adresses déjà attestés sur le PC de l'opérateur
+ 47 nouveaux uniquement attestés dans le sandbox de construction.
**94/94 n'est pas encore validé sur WSL2 de l'opérateur.**

Ne pas transformer le résultat du laboratoire en une permission
de publier des annonces. Voir le rapport
`docs/asset-exchange/PEARL_PRL_MARKETPLACE_SECURITY_REVIEW_2026-11-23.md`
et ses blocages critiques (acteur non authentifié, horloge de test,
absence de persistance/quotas distribués et de routes réelles).

**P0–P9 et mise en production : NON QUALIFIÉS.**
