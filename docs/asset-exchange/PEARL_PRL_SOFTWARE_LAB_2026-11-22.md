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

## Attestation opérateur Ubuntu WSL2 — 94/94 PASS, démonstration conforme

L'opérateur a exécuté la suite entière de la branche
`experiment/pearl-prl-marketplace-draft-security-20261123`
dans son Ubuntu WSL2 avec le namespace réseau isolé
`unshare --user --map-root-user --net` et
`PYTHONDONTWRITEBYTECODE=1`.

Fin de journal relevée :

```text
Ran 94 tests in 0.073s

OK
=== DEMONSTRATION HORS LIGNE ===
... "draftId": "prl-lab-00000001", "revision": 1,
    "status": "DRAFT_PREVIEW_ONLY",
    "actorAuthenticated": false,
    "realExchangeListingCreated": false,
    "canPostOffer": false, "canSettle": false
... "draftId": "prl-lab-00000001", "revision": 2,
    "status": "CANCELLED_PREVIEW_ONLY",
    "actorAuthenticated": false,
    "realExchangeListingCreated": false,
    "canPostOffer": false, "canSettle": false
=== ETAT GIT ===
9c685cc
## experiment/pearl-prl-marketplace-draft-security-20261123...origin/experiment/pearl-prl-marketplace-draft-security-20261123
```

Le code testé est le commit
`9c685ccf0d8ab1fabbc0fd6a01a25de42458620b`.
**Les 94/94 méthodes sont attestées PASS sur le poste de
l'opérateur, sans erreur et avec copie Git propre.**
La démonstration a montré le changement d'état local attendu
sans offre publiée ni activation de permissions financières.

**Classification : OFFLINE_DRAFT_MODEL_94_PASS /
PRODUCTION_MARKETPLACE_BLOCKED.** Les identifiants de propriétaires
ne sont toujours pas authentifiés, l'horloge est contrôlable par
l'appelant, les données ne sont pas persistées, aucun rate limiting
distribué n'existe et aucune route API d'offres n'est déployée.
**P0–P9 restent non qualifiés** pour les transactions / fonds réels.
Les vérifications ne constituent ni audit indépendant, ni attestation
de chaîne, ni validation du matériel, ni contrôle de production.

## Contrôle d'architecture Exchange PRL — 23 novembre 2026 (en attente de tests Node)

Branche : `experiment/pearl-prl-architecture-hardening-20261123`.
La dernière campagne opérateur confirmée reste **94/94
tests Python PASS** sur le commit `9c685cc`.

L'analyse statique de l'Exchange réel a identifié :
- ticker incorrect `PEARL` dans le registre Asset Exchange ;
- `newOffersEnabled=true` par défaut pour un actif Pearl
  avec `identityReady=false` ;
- absence de garde spécifique PRL dans la couche de
  publication des offres malgré l'identité native non qualifiée ;
- README API G5 obsolète, alors que des modules routes,
  sessions, PostgreSQL et offer-service existent dans les sources.

Les corrections proposées sont **uniquement dans l'Exchange** :
symbole `PRL` ; `newOffersEnabled=false` pour Pearl ;
refus des offres Pearl sur les côtés give/want avant toute
signature ou toute écriture au dépôt ; clarification documentaire.

Le fichier `test_prl_exchange_gate.mjs` apporte **10 méthodes
Node.js nouvelles non encore exécutées/attestées sur Ubuntu**.
Ces tests n'exécutent aucun signataire, n'ouvrent aucun
service, ne créent aucune transaction et ne touchent aucun fonds.

**Bloqueur restant critique :** la politique d'acceptation
d'anciennes offres PRL, et les contrôles au niveau de la
base de données atomique, ne sont pas encore qualifiés.
L'authentification publique, le déploiement et les preuves
natives Pearl restent non qualifiés.

Aucun fichier de minage ni aucun autre domaine hors
Asset Exchange n'est modifié. Aucune capacité de
publication PRL ou de règlement n'est activée.

## Tentative opérateur — 23 novembre 2026 — blocage Node.js dans WSL2

L'opérateur a cloné séparément et en sparse checkout la branche
`experiment/pearl-prl-architecture-hardening-20261123`
dans `$HOME/gpubnb-prl-exchange-arch-lab`. Seuls les répertoires
`asset-exchange` et `docs/asset-exchange` ont été récupérés.

Résultat réellement observé :

```text
=== PRL : 94 TESTS PYTHON ===
----------------------------------------------------------------------
Ran 94 tests in 0.060s

OK
=== PRL : 10 TESTS ARCHITECTURE ===
unshare: failed to execute node: No such file or directory
```

**94/94 tests Python PASS sur Ubuntu WSL2** pour le code de cette
branche. **Les 10 nouveaux tests JavaScript et le contrôle de
non-régression `asset-registry.test.mjs` n'ont pas démarré** :
l'exécutable `node` est absent/non résolu par ce namespace.
Le shell étant lancé avec `set -euo pipefail`, il s'est arrêté
avant l'affichage du commit exact et de l'état Git final ;
ne pas revendiquer le worktree propre sans sortie de `git status`.

Le constat `node: No such file or directory` est un **blocage
de l'outillage**, PAS une preuve que les tests Node.js échouent.
Les publications PRL restent désactivées, l'API n'a pas été lancée,
aucune opération de règlement n'a été effectuée.

Prochaine vérification non destructive :

```sh
command -v node || true
command -v nodejs || true
cat /etc/os-release
git -C "$HOME/gpubnb-prl-exchange-arch-lab" status --short --branch
```

Après installation ou découverte d'un Node.js compatible et
de confiance, les tests Node devront être relancés uniquement
dans le namespace réseau isolé. Rien ne nécessite d'accéder
au répertoire ni au code de minage.
