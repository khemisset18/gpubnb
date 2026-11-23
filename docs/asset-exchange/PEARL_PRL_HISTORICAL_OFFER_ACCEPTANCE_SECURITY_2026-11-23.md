# Architecture de protection des offres Pearl historiques — 23 novembre 2026

**Scope : Asset Exchange uniquement. Ne pas toucher au minage ni à DOGE/LTC.**

**Statut : branche expérimentale PRL, PR brouillon, AUCUNE activation.**
Branche : `experiment/pearl-prl-historical-acceptance-guard-20261123`
Base : `experiment/pearl-prl-architecture-hardening-20261123` (PR #393).

## Problème et scénario

Le contrôle de publication introduit dans la PR #393 refuse les nouvelles
offres PRL non qualifiées. **Il ne suffit pas pour les offres historiques**
qui pourraient déjà se trouver dans `asset_exchange.offers`.
Le code d'acceptation peut recevoir une acceptation signée (hors de
notre laboratoire), vérifier la signature et appeler
`accept_offer_atomic` en ne transmettant que l'identifiant, le hash
et le policy epoch. Sans contrôle sur les deux asset keys de l'offre
réellement stockée, l'identité PRL non qualifiée pourrait être ignorée.

L'existence réelle de telles offres en base n'a PAS été vérifiée :
le problème est un risque architectural, non une preuve de fraude
ou d'offre PRL déjà publiée.

## Défenses ajoutées, uniquement dans Asset Exchange

1. `api/src/postgres-offer-repository.mjs` : lecture des deux clés
   canoniques `give_asset_key` et `want_asset_key` de l'offre en
   base via la requête paramétrée existante.
2. `api/src/offer-service.mjs` :
   `assertStoredOfferAssetPolicy` bloque les clés dont le chain ID
   est `pearl` ou `prl` (y compris variantes historiques de casse
   et d'espaces), les clés manquantes et les formats non canoniques.
   `acceptOffer` lit l'offre stockée, vérifie le statut, le hash,
   l'epoch et **refuse PRL avant toute vérification externe
   de signature et avant toute écriture**. Les autres actifs
   ne sont pas activés par cette modification.
3. **Migration additive non exécutée :**
   `db/migrations/010_prl_historical_offer_quarantine.sql`.
   Trois triggers prévus :
   - rejet des insertions SQL directes d'offres PRL ;
   - rejet de la création d'une transaction si l'offre stockée
     contient PRL comme actif offert ou demandé ;
   - rejet du changement de l'offre PRL vers `CONSUMED`.
   Ils se fondent sur **les asset keys stockées**, pas sur
   un nom affiché, un ticker ou une requête utilisateur.
   Ces triggers ne sont **pas appliqués à une base** par cette PR.

## Limites de sécurité et risques résiduels

- **CRITIQUE tant que la migration SQL est non appliquée :**
  un accès direct au dépôt SQL pourrait contourner un garde
  uniquement dans le service API.
- **CRITIQUE pour la production :** la migration n'a pas été
  exécutée sur PostgreSQL 16+ isolé ; absence de tests SQL
  natifs de concurrence, d'annulation, de rôles et d'idempotence.
- Les triggers empêcheraient les *nouvelles* transitions.
  **Ils n'effacent ni ne requalifient des transactions déjà
  acceptées** avant leur éventuelle installation. Le code
  SQL de rejouement idempotent peut retourner un résultat
  préexistant sans nouvelle transition ; sa politique de
  réponse en cas d'ancien résultat PRL reste à examiner.
- Les valeurs stockées peuvent être malformées ou avoir subi
  un héritage non canonique ; une correspondance de chaîne
  `pearl`/`prl` n'est pas une preuve d'identité native.
  Une vraie attestation canonique reste indispensable.
- **Ne pas lancer de migrations**, de PostgreSQL, de nœud
  Pearl, de service API, de signataire ou de réseau blockchain.
  Ne pas exposer des offres réelles dans ce laboratoire.
- Le code Python `marketplace_draft_lab.py` reste
  un exercice en mémoire, non authentifié et non déployable.

## Tests logiciels ajoutés — non encore attestés sur WSL2

- `qualification/pearl/test_prl_historical_accept_guard.mjs` :
  **14 tests** de refus avant signature/dépôt, deux sens, réseaux,
  alias historiques, champs absents, statut et cohérence
  hash/epoch, ainsi qu'une non-régression fictive non-PRL.
- `qualification/pearl/test_prl_migration_contract.mjs` :
  **6 contrôles statiques** du texte de migration SQL :
  pas une preuve d'exécution PostgreSQL.
- `api/test/postgres-offer-repository.test.mjs` :
  **1 test ajouté** sur la lecture paramétrée des asset keys.
- `api/test/offer-service.test.mjs` :
  une fixture existante complétée pour fournir les deux
  asset keys stockées, afin que les tests antérieurs de
  non-régression puissent être relancés.

**Checkpoint confirmé du poste : 109 tests hors ligne PASS sur
le commit `60a3934` de la branche PR #393.**
**Cette branche introduit 21 nouveaux tests au total mais
aucun résultat PASS WSL2 n'est encore revendiqué pour ceux-ci.**

### Commandes de qualification opérateur (réseau isolé)

Utiliser Node.js portable déjà vérifié dans
`$HOME/gpubnb-exchange-tools/node-v24.22.3-linux-x64/bin/node`,
dans un **nouveau clone sparse** du dépôt contenant uniquement
`asset-exchange` et `docs/asset-exchange`.

```sh
NODE="$HOME/gpubnb-exchange-tools/node-v24.22.3-linux-x64/bin/node"
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 -m unittest discover -s asset-exchange/qualification/pearl -p 'test_*.py' -q
unshare --user --map-root-user --net "$NODE" --test \
  asset-exchange/qualification/pearl/test_prl_exchange_gate.mjs \
  asset-exchange/qualification/pearl/test_prl_historical_accept_guard.mjs \
  asset-exchange/qualification/pearl/test_prl_migration_contract.mjs \
  asset-exchange/core/test/asset-registry.test.mjs \
  asset-exchange/api/test/offer-service.test.mjs \
  asset-exchange/api/test/postgres-offer-repository.test.mjs
```

Aucun de ces tests ne doit lancer de PostgreSQL, HTTP, wallet,
signature, nœud ni miner. Les tests existants utilisant des
chaînes `"sig"` simulent un argument opaque et ne génèrent
aucune signature cryptographique.

## Décision

**PRL MARKETPLACE_ONLY / RESTRICTED** ;
`identityReady=false`, `newOffersEnabled=false`,
`newTradesEnabled=false`,
`automaticSettlementSupported=false`.
**P0–P9 et production financière BLOQUÉS.**
Ce lot n'est ni à fusionner, ni à déployer, ni à utiliser
pour l'acceptation d'offres réelles avant tests PostgreSQL
indépendants et revue complète de la politique financière.
