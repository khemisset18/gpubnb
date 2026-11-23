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
**Actualisation opérateur : 22 nouvelles déclarations de tests présentes dans la branche. La campagne de validation WSL2 a réussi : 94 tests Python + 49 tests Node.js, soit 143/143 PASS au commit `71d419b` (détail et limites en fin de document).**

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

### Mesure supplémentaire : alias de chaîne PRL

Le contrôle des **nouvelles** publications a également été étendu pour refuser la chaîne non canonique `prl` comme alias historique de `pearl`, avant toute vérification externe. Un **onzième** test a été ajouté à `test_prl_exchange_gate.mjs`. L'identité canonique Pearl n'est pas activée par cet ajout.

Les 22 nouvelles déclarations de tests de ce lot correspondent à : **14** historiques, **6** contrats SQL statiques, **1** lecture du repository PostgreSQL et **1** alias de publication. Leur exécution est désormais attestée dans la campagne Node.js 49/49 PASS sur Ubuntu WSL2 au commit `71d419b`. Les six contrôles SQL restent uniquement statiques.

### Attestation de campagne opérateur, Ubuntu WSL2

Journal : `Ran 94 tests in 0.087s / OK`, suivi de `tests 49 / pass 49 / fail 0 / skipped 0` pour Node.js, puis `git rev-parse --short HEAD = 71d419b` et un worktree sans changement local. Exécution Python et Node sous `unshare --user --map-root-user --net`, Node portable Exchange `v24.22.3`.

**Bilan : 143/143 tests logiciels hors ligne réussis sur le commit testé `71d419b7f773d0a70e29855c9ec4102b65ba92db`.** Cette attestation ne prouve ni l'installation ni l'exécution des triggers de la migration 010 sur PostgreSQL. La PR reste non déployable et en brouillon ; les droits PRL sont désactivés.
