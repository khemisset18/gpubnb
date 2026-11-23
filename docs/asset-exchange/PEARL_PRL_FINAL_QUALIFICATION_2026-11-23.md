# Qualification finale de Pearl (PRL) pour GPUbnb Asset Exchange

**Date de l'audit : 23 novembre 2026**  
**Dépôt :** `khemisset18/gpubnb`  
**Référence auditée :** `experiment/pearl-prl-idempotency-replay-quarantine-20261123`  
**Commit de référence :** `056e28ff34e4bbdb071d832ff83443adc9be1c68`  
**Branche de travail :** `experiment/pearl-prl-final-qualification-20261123`  
**Commit du code et des tests de cette proposition :** `b05e74a6ea4b8decea4fcf52f0582561fa599f24`  
**PR de référence :** [#396](https://github.com/khemisset18/gpubnb/pull/396), ouverte, brouillon, non fusionnée au moment de la vérification.
**PR de travail :** [#397](https://github.com/khemisset18/gpubnb/pull/397), brouillon, non fusionnée; la branche a été mise à jour avec le code et les tests de cette campagne.

## Décisions

| Critère | Décision | Motif vérifiable |
|---|---|---|
| A. Qualification logicielle Exchange PRL | **BLOCKED** | Les tests Exchange hors ligne passent. Les fonctions, triggers et courses SQL n'ont pas été exécutés sur PostgreSQL. |
| B. Qualification PostgreSQL native | **BLOCKED** | Aucun `psql`, `postgres`, `initdb`, `pg_ctl`, Docker ou Podman n'est installé. Aucun serveur jetable n'a été provisionné et aucune migration n'a été lancée. |
| C. Identité native Pearl | **BLOCKED** au niveau de l'Exchange | La spécification native est confirmée dans le dépôt officiel épinglé, mais la provenance d'une chaîne active et la validation indépendante de son réseau ne sont pas établies ici. |
| D. Publication d'offres PRL | **INTERDITE** | Le registre Exchange conserve `identityReady=false` et `newOffersEnabled=false`; le garde API refuse PRL. |
| E. Règlement automatique PRL | **INTERDIT** | `automaticSettlementSupported=false`, aucun routage de règlement PRL, aucune capacité native de règlement qualifiée. |
| F. Sécurité de production | **NON QUALIFIÉE** | Rôles PostgreSQL, déploiement, secrets, journaux de production, migrations natives et opérations réseau n'ont pas été vérifiés. |

Ces décisions ne changent pas le statut ou les permissions de PRL. La qualification d'affichage au catalogue ne confère aucune autorisation d'offre, d'achat, de vente, de dépôt, de signature ou de règlement.

## Périmètre et état du dépôt

Le dépôt local fourni à cet environnement n'était pas un clone Git. La branche et la PR ont donc été vérifiées via le connecteur GitHub. La branche de référence pointait sur `056e28ff34e4bbdb071d832ff83443adc9be1c68`; la PR #396 était `open`, `draft`, `unmerged`. La PR #396 atteste 160/160 tests Ubuntu WSL2 au commit `f61dc5d6c7ead0a1448ccdd4b02cff45a3f27a4c`, tout en déclarant explicitement que PostgreSQL natif n'a pas été exécuté.

Le travail de cette proposition porte exclusivement sur `asset-exchange/` et `docs/asset-exchange/`. Le diff final comprend des changements de service, SQL, scripts de test et qualification Pearl, plus ce rapport. Aucun fichier de minage, interface de minage, mineur, configuration GPU ou fichier extérieur à ces deux répertoires n'est inclus.

Changements techniques principaux :

- Le service d'offres autorise un rejeu après redémarrage d'une offre non-PRL déjà `CONSUMED` à atteindre la fonction atomique, en gardant le contrôle PRL avant le rejeu. La réponse persistée doit correspondre à la même offre, aux mêmes hash et epoch; le SQL vérifie l'ensemble des preuves persistées.
- La migration 011 sérialise une portée et une clé d'idempotence avec `pg_advisory_xact_lock` avant la lecture du registre d'idempotence. Elle refuse aussi les `request_hash` nuls ou malformés, puis lie la réponse au trade et à l'offre réellement stockés et valide hash d'offre, epoch, taker, hash d'acceptation, signature et référence de résultat.
- La migration 012 complète les contrôles atomiques de publication, annulation et signature des termes : validation des clés et hash avant rejeu, verrou transactionnel avant lookup, comparaison `IS DISTINCT FROM`, puis contrôle du `result_ref` et des champs/preuves financiers persistés. Un retry de publication exact peut retrouver le résultat après expiration; une nouvelle publication expirée reste refusée.
- L'API transmet les replays de publication expirés et d'annulation déjà faite au repository atomique. Pour une annulation nouvelle et expirée, elle conserve le refus; pour une offre déjà annulée, le SQL doit confirmer la même clé, le même hash, la même signature et la même offre.
- La migration 010 refuse les clés d'actifs nulles, malformées ou non canoniques et ajoute des triggers de garde pour insertion d'offre, création de trade et passage à `CONSUMED`.
- Les lanceurs PostgreSQL refusent les connexions libpq redirigées, imposent un socket et des chemins privés de laboratoire et vérifient plusieurs propriétés du serveur avant d'appliquer quoi que ce soit. Le script de concurrence Docker utilise `--network none` et ne monte que le socket privé; il comprend maintenant des courses concurrentes de publication, annulation et signature des termes.
- La documentation du vérificateur d'adresse ne prétend plus que Pearl ne prend pas en charge P2MR v2 : le profil de recherche Exchange accepte uniquement le format witness-v1 qu'il sait valider.

## Matrice de capacités PRL dans l'Exchange

| Champ | Valeur vérifiée |
|---|---|
| Nom / symbole | Pearl / PRL |
| ID de registre | `pearl-mainnet-native` |
| Support / risque | `MARKETPLACE_ONLY` / `RESTRICTED` |
| Identité prête | `identityReady=false` |
| Nouvelle offre | `newOffersEnabled=false` |
| Nouveau trade | `newTradesEnabled=false` |
| Preuve de propriété, lock, redeem, refund, recovery | `false` |
| Règlement automatique | `automaticSettlementSupported=false` |
| Routage de règlement | `null` |
| Signature, financement, diffusion PRL par l'Exchange | **Non qualifiés et interdits** |

Cette valeur du registre est vérifiée dans `asset-exchange/core/src/asset-registry.mjs`. Le garde de `asset-exchange/api/src/offer-service.mjs` bloque PRL sur les deux côtés d'une offre ainsi que l'alias historique `prl`, les identités token/NFT déguisées et les offres historiques avant vérification externe de signature ou écriture.

## Identité native et provenance du protocole

Les sources primaires consultées sont le dépôt officiel [pearl-research-labs/pearl](https://github.com/pearl-research-labs/pearl), dont le `master` au 23/11/2026 pointe sur le commit vérifié `09cb165b1fbafe75288ffe89b351ba1e05197636`, dans `node/chaincfg/params.go`, `node/wire/protocol.go`, `node/chaincfg/genesis.go`, `node/btcutil/amount.go` et `node/blockchain/validate.go`, ainsi que l'aide officielle Pearl. Le profil de surveillance Exchange était auparavant épinglé à `0dbdb2ffd8b81193a5079bb67a59aecc10ad501c`; sa fixture et son commit ont été remis à jour. La comparaison des deux révisions confirme que les six tuples réseau (nom, genesis, magic, HRP) sont identiques. Elle détecte néanmoins une modification de `RankPenaltyForkHeight` dans `params.go`, de `36761` à `36763`; le garde Exchange valide l'identité réseau, pas toutes les règles de consensus. Cela vérifie les paramètres publiés du logiciel; cela ne prouve pas qu'un nœud ou une chaîne observés en production utilisent ces paramètres.

| Propriété protocolaire | Valeur de source | Conséquence pour l'Exchange |
|---|---|---|
| Actif | PRL natif Pearl, chaîne UTXO de niveau 1 | Ne pas confondre avec MTN, une représentation emballée ou un token homonyme. |
| Mainnet | HRP `prl`; magic `0x50524C4D` (`PRLM`); port P2P par défaut `44108` | La forme publique documentée commence par `prl1p`; le vérificateur Exchange actuel ne valide pas cette forme mainnet. |
| Regtest | HRP `rprl`; magic `0x50524C52` (`PRLR`); port P2P par défaut `18444` | Le préfixe d'adresse seul ne prouve pas regtest. |
| Simnet | HRP `rprl`; magic `0x50524C53` (`PRLS`); port P2P par défaut `18555` | Le préfixe d'adresse ne le distingue pas de regtest; le dépôt source indique aussi des valeurs de genesis identiques entre ces deux réseaux. Il faut vérifier la configuration réseau complète, notamment la magic. |
| Adresse | Formats publics Bech32m witness v1/Taproot; le code consensus officiel reconnaît aussi witness-v2/P2MR | Le checker de recherche Exchange accepte seulement une forme `rprl` witness-v1 de 32 octets. Il classe une forme; il ne prouve ni réseau, ni provenance, ni capacité de dépense. P2MR v2 n'est pas qualifié par ce profil. |
| Unité atomique | 1 PRL = 100 000 000 grains; 1 grain = 10⁻⁸ PRL | L'unité native est documentée, mais le registre Exchange ne l'a pas encore liée à une identité prête. |

**Résultat d'identité :** PASS pour les faits de spécification confirmés par les sources officielles; BLOCKED pour l'identité native opérationnelle de l'Exchange. Aucune connexion à un nœud Pearl, comparaison indépendante de checkpoints, preuve de possession, ou observation de chaîne n'a été faite. L'identifiant natif Exchange, l'asset key canonique et les règles de consensus/address complètes doivent être validés indépendamment avant toute activation.

## Priorité P0 — audit et protocole PostgreSQL

### Audit SQL et protocole

- Ordre du protocole : migrations 001–009; fixture de lignes synthétiques historiques avant 010; migrations 010, 011 puis 012; scénarios `prl_scratch_accept_replay_after_011.sql` et `idempotency_replay_after_012.sql`. L'ordre est nécessaire, car 011 et 012 appellent le garde créé par 010.
- La migration 010 est additive et utilise des fonctions `SECURITY INVOKER` avec `search_path` fixé. Ses triggers se basent sur les clés d'actifs de l'offre stockée, y compris pour une insertion directe de trade.
- La migration 011 conserve la signature SQL de `accept_offer_atomic`, valide `request_hash` comme 64 caractères hexadécimaux minuscules avant toute lecture de rejeu, et garde le flux d'acceptation lié à l'état opérateur, au verrou d'offre, à l'expiration, au hash et à l'epoch. Une clé d'idempotence malformée est rejetée.
- L'audit des migrations 003/007/009 a trouvé que les replays de publication/annulation/termes omettaient la validation SQL des clés et hash, le verrou d'idempotence et la preuve que le résultat stocké correspond aux valeurs présentées. Le guard API d'expiration de publication annulait aussi un retry valable après expiration, et un état `CANCELLED` empêchait le service d'atteindre le repository.
- La migration 012 corrige ces défauts au niveau fonction : vérification stricte des paramètres, sérialisation transactionnelle de portée/clé, comparaison null-safe, et lecture verrouillée des lignes financières réelles avant retour du résultat antérieur. Elle ne modifie pas `accept_offer_atomic` ni les permissions de l'opérateur.
- Le contrôle des nouvelles annulations expirées reste dans l'API, car la fonction SQL d'annulation ne reçoit pas l'expiration signée. La validation de signature cryptographique demeure dans le service; les fonctions `SECURITY INVOKER` ne peuvent pas prouver seules qu'un acteur qui a un accès DB direct a présenté une signature valide. Les rôles/grants d'un déploiement réel restent donc un blocage critique.
- Le scénario SQL sépare les erreurs de référence de trade, request hash, hash d'offre, epoch, hash d'acceptation et signature; contrôle les identifiants d'actifs malformés; bloque les replays historiques PRL dans les deux directions; garde un replay non-PRL; teste publication directe, création de trade et transition de consommation. Les assertions de validation sont dans une transaction annulée.
- `concurrency.sh` couvre accept/accept, accept/cancel, retry séquentiel, rejeu concurrent acceptation/publication/annulation/termes, hash de requête différent, epoch en transition et immutabilité financière. Ces scénarios sont écrits mais leurs résultats PostgreSQL restent inconnus.

### Décision d'exécution

**Aucune migration n'a été exécutée et aucune connexion à une base n'a été tentée.** Le système ne fournit aucun binaire PostgreSQL (`psql`, `postgres`, `initdb`, `pg_ctl`) ni moteur de conteneur (`docker`, `podman`). Il est donc impossible de prouver l'origine fraîche du cluster, l'isolation des données, le rôle connecté ou le comportement réel des migrations. La demande exige explicitement de ne pas lancer les migrations sans isolation fiable.

Les vérifications statiques du script ne remplacent pas le contrôle d'un opérateur qui provisionne le cluster. Le protocole exige une instance exclusivement jetable, PostgreSQL 16+, `PGDATA` neuf privé en mode 0700, socket Unix dans le même répertoire scratch privé, `listen_addresses=''`, aucun `PGHOSTADDR`/service libpq/URL de base partagée, une base `prl_scratch_*` neuve avec rôle de test explicite, puis la confirmation du répertoire de données, du socket, du propriétaire, du nombre de bases, de l'absence de schéma et d'objets utilisateurs avant toute migration. Le script ne crée ni ne détruit le serveur; l'opérateur doit conserver des preuves de provisionnement puis détruire l'instance.

**Protocole reproductible à exécuter dans un environnement isolé :**

1. Construire depuis l'image PostgreSQL officielle épinglée, dans un environnement jetable sans réseau, un cluster neuf dont le socket est monté seul et dont le serveur n'écoute pas en TCP. Utiliser un rôle propre au test et ne réutiliser aucune base existante.
2. Exécuter `asset-exchange/db/test/prl_scratch_replay_run.sh` avec les variables requises et `PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY`. Le lanceur applique 001–009, sème les lignes fictives avant 010, applique 010–012, puis exécute les scénarios transactionnels qui annulent leurs writes. Garder la sortie, `SHOW server_version`, `SHOW data_directory`, `SHOW listen_addresses`, le chemin du socket et le SHA des migrations.
3. Sur ce même cluster, appliquer le protocole isolé décrit dans `asset-exchange/db/test/concurrency.sh`; confirmer les assertions de nombre d'offres, trades, évènements et lignes d'idempotence après chaque course. Le script comporte des `TRUNCATE`, donc ne jamais le diriger vers autre chose que le cluster jetable dédié.
4. Enregistrer les codes retour et les versions du serveur et client. Détruire le répertoire `PGDATA` et le cluster après vérification des résultats.

Tant que cette campagne n'a pas eu lieu, la qualification PostgreSQL native est **BLOCKED**. Les contrôles de texte SQL présents dans Node sont des contrats statiques, pas un test PostgreSQL. `db/test/idempotency_replay_after_012.sql` est un test PostgreSQL écrit pour l'instance dédiée; il n'a pas été exécuté ici.

## Campagnes de test

Les tests logiciels ont été exécutés sur le commit de code qui sera indiqué ci-dessus (fichiers identiques à ceux testés localement avant le commit). Versions disponibles : Node `v24.22.3`, npm `11.19.1`, Python `3.12.14`, GNU Bash `5.2.37`. PostgreSQL et Docker/Podman absents.

| Campagne | Commande | Résultat | Ignorés | Limites |
|---|---|---:|---:|---|
| Suite Node déclarée du package | `npm test` | PASS — 171/171 | 0 | Inclut les tests API, repository, watcher, registre, settlement, release et research. Avertissement npm non bloquant sur la clé d'environnement `http-proxy`. |
| Suite Node complète avec qualification PRL | `TMPDIR="$PWD/.test-tmp" node --test core/test/*.test.mjs api/test/*.test.mjs worker/test/*.test.mjs chain-watchers/test/*.test.mjs recovery/test/*.test.mjs settlement/test/*.test.mjs release/test/*.test.mjs research/test/*.test.mjs qualification/pearl/test_prl*.mjs` | PASS — 231/231 | 0 | Le dossier temporaire privé a été supprimé à la fin. Les contrats SQL restent statiques; pas de serveur PostgreSQL. |
| Suite Python Pearl | `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s qualification/pearl -p 'test_*.py' -v` | PASS — 94/94 | 0 | Tests hors ligne; sans moteur Pearl, portefeuille, signature réelle ou validation d'une chaîne active. |
| Contrôle de syntaxe JavaScript du package | `npm run check` | PASS — 83 fichiers `.mjs` | 0 | Le miroir local omettait le script déjà présent sur la branche; je l'ai étendu sans dépendance pour inclure les modules de qualification Pearl. |
| Syntaxe des scripts de laboratoire SQL | `bash -n db/test/prl_scratch_replay_run.sh db/test/concurrency.sh` | PASS | — | Vérifie la syntaxe shell seulement; ne parse ni n'exécute PL/pgSQL. |
| Refus du lanceur PRL faute de `psql` | Variables explicites de scratch + `PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY` | PASS — code 2 | — | Le client `psql` est absent; refus avant toute connexion ou migration. |
| Refus du lanceur PRL sur override libpq | `PGHOSTADDR=198.51.100.10` avec noms de cible scratch | PASS — code 2 | — | Refus observé avant toute connexion. |
| Refus de garde de concurrence | `PG_IMAGE=postgres:16 PRL_SCRATCH_ACK= bash db/test/concurrency.sh` | PASS — code 2 | — | Refus observé avant Docker. |
| PostgreSQL natif 16+ | Non exécuté | **BLOCKED** | N/A | `psql`, `postgres`, `initdb`, `pg_ctl`, Docker et Podman absents; aucune migration ni requête DB exécutée. |

Résultats de correction : un premier test des termes utilisait une enveloppe non normalisée et échouait avec `invalid settlement terms domain`; le fixture a été normalisé. Un test ciblé ultérieur avait associé une horloge qui échoue au cas d'une annulation nouvelle expirée; l'horloge de ce scénario a été rétablie, tandis que les retries durables sont maintenant testés sans dépendance à l'horloge applicative. Les tests ciblés finaux passent (20/20), ainsi que les suites Node complètes. `npm run check` a d'abord échoué parce que le miroir local ne contenait pas le script déjà présent sur la branche GitHub; après récupération et extension du contrôle aux modules de qualification, il a réussi sur 83 fichiers `.mjs`. Aucun des échecs initiaux n'a été masqué. Les commandes n'ont exécuté aucun mineur, service déployé, signer, wallet ni opération blockchain.

## Revue STRIDE et inventaire des risques

| ID / catégorie | Gravité | Constat, scénario de laboratoire | Correctif / état |
|---|---|---|---|
| R1 — Falsification / élévation via rejeu idempotent historique | **ÉLEVÉE** | Ancienne version de la fonction SQL pouvait retourner `CONSUMED` à partir d'un enregistrement idempotent avant de lire l'offre et ses actifs. Scénario uniquement sur scratch : semer avant 010 un replay PRL `give` ou `want`, appliquer 010/011, puis exécuter le scénario après 011. | 011 relie `scope`, clé et request hash au trade et à l'offre stockés, vérifie les preuves persistées et appelle le garde PRL avant réponse. Couverture SQL écrite; validation native **BLOCKED**. |
| R2 — Déni de service / course d'idempotence | **ÉLEVÉE** | Deux processus simultanés avec la même clé pouvaient manquer la ligne initiale et produire un conflit d'unicité ou un échec de consommation au lieu du résultat persistant. Deux sessions scratch avec la même offre, le même taker, la même clé et les mêmes hashes doivent donner une seule ligne et le même résultat. | Verrou transactionnel consulté avant le registre; assertions à deux sessions ajoutées. **Non exécuté sur PostgreSQL.** Les attentes sous contention restent à mesurer. |
| R3 — Rejeu API après redémarrage/expiration | **MOYENNE** | Les précontrôles service pouvaient bloquer un retry publié ou annulé après expiration/transition d'état avant que le SQL vérifie son enregistrement idempotent exact. | Le service transmet ces retries au repository atomique après vérification d'identité et de signature; 012 n'autorise qu'une correspondance exacte avec les preuves persistées. Tests Node ajoutés; comportement SQL natif **BLOCKED**. |
| R4 — Clé d'actif malformée / canonisation | **MOYENNE** | Une clé stockée avec un identifiant d'actif vide ou entouré d'espace peut être non canonique. Reproduction locale dans tests API et scénario SQL scratch. | Rejet de l'identifiant vide ou avec espace ASCII de bord dans les contrôles API/SQL; cas couverts. La comparaison Unicode exacte entre `String.trim()` JS et `btrim()` PostgreSQL n'a pas été testée nativement; traiter cette équivalence comme résiduelle avant ouverture de la base à des écritures directes. |
| R5 — Sécurité du harnais / redirection de cible | **ÉLEVÉE pour l'intégrité des tests** | L'ancien lanceur de concurrence utilisait une cible TCP par défaut et réinitialisait les fixtures; `PGHOSTADDR` pouvait rediriger une cible de socket apparente. Reproduction lab : activer `PGHOSTADDR` et vérifier le refus avant le client. | Variables d'override libpq/URL partagée refusées, socket et `PGDATA` privés imposés, confirmations de cible; Docker isolé `--network none`. Les refus d'entrée passent; aucun serveur n'a été démarré. |
| R6 — Élévation par accès direct DB / changement de politique | **ÉLEVÉE — non résolue** | Les migrations n'installent pas de rôles, GRANT/REVOKE ou RLS. Le propriétaire ou superutilisateur peut modifier `operator_state`, remplacer/désactiver des fonctions ou désactiver des triggers. Aucun test de rôle ne peut être fait sans cible DB et modèle de rôles. | Précondition production : rôle migration propriétaire séparé du rôle API, rôle API non propriétaire/non superutilisateur avec privilèges minimaux, accès réseau restreint et procédure approuvée de migration. Définir et tester les droits exacts avant déploiement; pas de correctif arbitraire ajouté faute de configuration de déploiement. |
| R7 — Falsification de réseau via HRP partagé `rprl` | **ÉLEVÉE pour toute intégration de fonds** | Regtest et simnet partagent `rprl` et leurs valeurs genesis peuvent être identiques. Un contrôle de préfixe seul pourrait classifier le mauvais réseau. | README et tests précisent que l'HRP n'est pas une identité réseau; les profils source dérivés exigent tous les champs/réseaux. Aucun routage PRL n'est activé. L'identité d'un nœud réel reste non prouvée. |
| R8 — Rejeu avec `request_hash` SQL nul | **MOYENNE** | En PL/pgSQL, `v_existing.request_hash <> NULL` vaut inconnu; avant le garde ajouté, l'exception n'était pas levée. Reproduction scratch : appeler le rejeu non-PRL présemé avec la même clé et un hash nul ou trop court. | 011 rejette les hashes nuls ou non conformes avant la lecture du registre; scénario SQL et contrat statique ajoutés. Tests offline PASS; le cas natif reste **BLOCKED**. |
| R9 — Contrat de rejeu publication/annulation/termes | **MOYENNE — corrigée en code; preuve native bloquée** | Les fonctions 003/007/009 consultaient l'idempotency record sans valider les entrées assez tôt, sans lock transactionnel et sans prouver que l'offre/trade et les preuves persistées correspondaient au résultat. Une comparaison SQL `<> NULL` donne UNKNOWN, pas TRUE, donc n'assure pas l'échec fermé. | Migration 012 ajoute validations, advisory locks, `IS DISTINCT FROM`, verrouillage et comparaisons des enregistrements. Les scénarios SQL et courses à deux sessions sont écrits, pas exécutés : **BLOCKED**. |
| R10 — Accès direct DB / vérité des signatures et expirations | **ÉLEVÉE — résiduelle** | Les fonctions `SECURITY INVOKER` vérifient les liens entre ligne, identité et preuve stockée, mais ne valident pas cryptographiquement les signatures. La fonction SQL d'annulation ne reçoit pas l'expiration signée; l'API vérifie l'expiration d'une annulation nouvelle. Un rôle DB trop puissant pourrait appeler les fonctions hors des contrôles API. | Rôle runtime dédié, non propriétaire/non superutilisateur, accès minimal aux seules fonctions nécessaires, réseau privé et séparation du rôle migration requis. Tester les privilèges réels avant production; aucune configuration DB de déploiement n'est disponible ici. |

### Contrôles observés dans le code Exchange

- **Authentification et origine :** les routes de mutation utilisent session et CSRF; tickets SSO ont signature Ed25519, issuer, audience, deployment, durée et `jti` de rejeu. La confiance de déploiement et la clé d'émetteur réelle n'ont pas été vérifiées.
- **Autorisation / IDOR-BOLA :** les offres et annulations sont liées au sujet maker; les acceptations au sujet taker, à l'offre stockée et au deployment; le repository lie les paramètres SQL. Tests service/API PASS, sans test de déploiement réel.
- **Isolation d'actifs :** identité exacte par clés canoniques; règles PRL dédiées et alias `prl` rejetés; DOGE/LTC/BTC restent couverts par les suites non-PRL. Le test Node confirme des cas témoins, pas le comportement SQL natif.
- **Entrées / exposition :** JSON dupliqué, profondeur et taille sont bornés; montants et clés d'idempotence canoniques; routes ont contrôle Origin, Fetch-Site, CSRF et rate limit. En configuration de production non testée, quotas et limites doivent être vérifiés.
- **Transactions et immutabilité :** repository utilise des paramètres SQL et des transactions; migrations 002/008 ajoutent verrous/lifecycle et triggers immutables sur preuves financières, évènements append-only. Aucun de ces triggers n'a été exécuté ici.
- **Expiration/annulation :** nouvelles acceptations vérifient expiration et état `OPEN`; les offres annulées sont rejetées; les replays non-PRL consommés demandent des preuves persistées exactes. Comportement PostgreSQL réel non qualifié.
- **Secrets/journalisation :** session store conserve des hash de session/CSRF; la recherche de code n'a pas révélé de journalisation des secrets dans les routes inspectées et les erreurs HTTP sont génériques. Les journaux et politiques de rétention d'un déploiement ne sont pas disponibles.
- **Dépendances/configuration :** aucun nouveau package ou service externe n'est ajouté; la configuration API refuse le fallback silencieux de `DATABASE_URL` Core et exige l'URL explicite Exchange. Aucun audit d'image, SBOM signé, scan de dépendances ou contrôle des secrets de déploiement n'a été réalisé.

## Conditions de passage avant production

1. Exécuter et faire revoir indépendamment les migrations 001–012 sur une instance PostgreSQL 16+ neuve et jetable, puis exécuter tous les scénarios SQL et courses multi-session acceptation/publication/annulation/termes; publier les logs, versions et preuves de destruction de la base.
2. Tester l'application avec le rôle API réellement provisionné : pas propriétaire ni superutilisateur; démontrer qu'il ne peut pas modifier la politique, désactiver les triggers, insérer directement une offre/trade ou altérer les preuves. Définir la séparation rôle migration/rôle runtime et le modèle de privilèges.
3. Faire vérifier l'identité PRL par une source indépendante et un nœud configuré avec le réseau exact : network magic, genesis/checkpoint, chaîne et règles d'adresse; documenter l'asset key Exchange, les grains et le traitement de Taproot witness-v1/P2MR witness-v2.
4. Qualifier l'observation de chaîne, les reorgs, les confirmations, la preuve de dépense, le chemin signer, la récupération, le refus des mauvais réseaux et les tests adversariaux sans fonds réels. Aucune capacité n'est couverte par cette proposition.
5. Passer une revue de sécurité indépendante du déploiement, des clés SSO, de TLS, des secrets, des logs, des alertes, des sauvegardes/restaurations, des dépendances et du plan d'incident.
6. Revoir le contrat SQL d'annulation : transmettre et enregistrer l'expiration signée si l'on veut que PostgreSQL soit lui-même la source de vérité pour sa validité temporelle. Jusqu'alors, l'API validée et le cloisonnement de rôle DB sont obligatoires.
7. Conserver les restrictions du registre tant que toutes les portes ci-dessus ne sont pas PASS et qu'une autorisation explicite distincte ne permet pas de changer les permissions PRL.

## Risque résiduel et conclusion

Le logiciel Exchange hors ligne passe ses tests. Les corrections de rejeu, de concurrence et de cible du harnais sont présentes dans la branche proposée. Elles ne constituent pas une preuve que les migrations PostgreSQL compilent ou fonctionnent comme prévu. Les actifs réels, l'identité d'un nœud Pearl en activité, les rôles de déploiement et les opérations de règlement restent hors preuve. Les annulations dépendent toujours du service API pour contrôler l'expiration signée et valider le signataire; il faut prouver que les identifiants DB runtime ne permettent aucun contournement de ce service.

**Conclusion :** la qualification de spécification native Pearl est vérifiée; la qualification opérationnelle PRL et la qualification PostgreSQL sont **BLOCKED**. La publication d'offres PRL reste **INTERDITE**, le règlement automatique PRL reste **INTERDIT**, et la sécurité de production est **NON QUALIFIÉE**. Ne pas fusionner, déployer ou modifier les capacités du registre sur la base des seuls tests hors ligne.
