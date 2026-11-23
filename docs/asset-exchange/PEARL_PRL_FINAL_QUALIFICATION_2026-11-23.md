# Qualification finale de Pearl (PRL) pour GPUbnb Asset Exchange

**Date de l'audit : 23 novembre 2026**  
**Dépôt :** `khemisset18/gpubnb`  
**Référence auditée :** `experiment/pearl-prl-idempotency-replay-quarantine-20261123`  
**Commit de référence :** `056e28ff34e4bbdb071d832ff83443adc9be1c68`  
**Commit du code et des tests de cette proposition :** `c7bf2788f2672cb7fc19267ae31ea52d7ce02a50`  
**PR de référence :** [#396](https://github.com/khemisset18/gpubnb/pull/396), ouverte, brouillon, non fusionnée au moment de la vérification.

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
- La migration 011 sérialise une portée et une clé d'idempotence avec `pg_advisory_xact_lock` avant la lecture du registre d'idempotence. Elle lie la réponse au trade et à l'offre réellement stockés et valide hash d'offre, epoch, taker, hash d'acceptation, signature et référence de résultat.
- La migration 010 refuse les clés d'actifs nulles, malformées ou non canoniques et ajoute des triggers de garde pour insertion d'offre, création de trade et passage à `CONSUMED`.
- Les lanceurs PostgreSQL refusent les connexions libpq redirigées, imposent un socket et des chemins privés de laboratoire et vérifient plusieurs propriétés du serveur avant d'appliquer quoi que ce soit. Le script de concurrence Docker utilise `--network none` et ne monte que le socket privé.
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

Les sources primaires sont les fichiers [params.go](https://github.com/pearl-research-labs/pearl/blob/09cb165b1fbafe75288ffe89b351ba1e05197636/node/chaincfg/params.go), [protocol.go](https://github.com/pearl-research-labs/pearl/blob/09cb165b1fbafe75288ffe89b351ba1e05197636/node/wire/protocol.go), [genesis.go](https://github.com/pearl-research-labs/pearl/blob/09cb165b1fbafe75288ffe89b351ba1e05197636/node/chaincfg/genesis.go), [amount.go](https://github.com/pearl-research-labs/pearl/blob/09cb165b1fbafe75288ffe89b351ba1e05197636/node/btcutil/amount.go) et [validate.go](https://github.com/pearl-research-labs/pearl/blob/09cb165b1fbafe75288ffe89b351ba1e05197636/node/blockchain/validate.go) du dépôt officiel [pearl-research-labs/pearl](https://github.com/pearl-research-labs/pearl/commit/09cb165b1fbafe75288ffe89b351ba1e05197636). GitHub signale ce commit comme signé et vérifié; le HEAD `master` observé à la date de l'audit pointait sur le même SHA. Les SHA-256 des quatre fichiers épinglés dans `pearl-source-identity.json` ont été recalculés depuis ce commit et correspondent aux sommes du fixture. L'aide officielle [What is Pearl](https://help.pearlresearch.ai/hc/en-us/articles/49190269457041-What-is-Pearl) et [Sending PRL](https://help.pearlresearch.ai/hc/en-us/articles/49185685648657-Sending-PRL-and-what-to-do-when-a-send-fails) documente l'adresse mainnet `prl1p` et le grain comme 10⁻⁸ PRL. La documentation publique annonce Taproot; le code de consensus de ce commit accepte aussi P2MR witness-v2. Cela vérifie la spécification logicielle publiée, mais ne prouve pas qu'un nœud ou une chaîne observés en production utilisent ces paramètres.

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

### Audit statique réalisé

- Ordre du protocole : migrations 001–009; fixture de lignes synthétiques historiques avant 010; migrations 010 puis 011; scénario `prl_scratch_accept_replay_after_011.sql`. L'ordre est nécessaire, car 011 appelle le garde créé par 010.
- La migration 010 est additive et utilise des fonctions `SECURITY INVOKER` avec `search_path` fixé. Ses triggers se basent sur les clés d'actifs de l'offre stockée, y compris pour une insertion directe de trade.
- La migration 011 conserve la signature SQL de `accept_offer_atomic`, vérifie l'idempotence avant retour `CONSUMED`, et garde le flux d'acceptation frais lié à l'état opérateur, au verrou d'offre, à l'expiration, au hash et à l'epoch. Une clé d'idempotence malformée est rejetée.
- Le scénario SQL sépare les erreurs de référence de trade, request hash, hash d'offre, epoch, hash d'acceptation et signature; contrôle les identifiants d'actifs malformés; bloque les replays historiques PRL dans les deux directions; garde un replay non-PRL; teste publication directe, création de trade et transition de consommation. Les assertions de validation sont dans une transaction annulée.
- `concurrency.sh` couvre accept/accept, accept/cancel, retry séquentiel, rejeu concurrent à clé identique, hash de requête différent, epoch en transition et immutabilité financière. Ces scénarios sont écrits mais leurs résultats PostgreSQL restent inconnus.

### Décision d'exécution

**Aucune migration n'a été exécutée et aucune connexion à une base n'a été tentée.** Le système ne fournit aucun binaire PostgreSQL (`psql`, `postgres`, `initdb`, `pg_ctl`) ni moteur de conteneur (`docker`, `podman`). Il est donc impossible de prouver l'origine fraîche du cluster, l'isolation des données, le rôle connecté ou le comportement réel des migrations. La demande exige explicitement de ne pas lancer les migrations sans isolation fiable.

Les vérifications statiques du script ne remplacent pas le contrôle d'un opérateur qui provisionne le cluster. Le protocole exige une instance exclusivement jetable, PostgreSQL 16+, `PGDATA` neuf privé en mode 0700, socket Unix dans le même répertoire scratch privé, `listen_addresses=''`, aucun `PGHOSTADDR`/service libpq/URL de base partagée, une base `prl_scratch_*` neuve avec rôle de test explicite, puis la confirmation du répertoire de données, du socket, du propriétaire, du nombre de bases, de l'absence de schéma et d'objets utilisateurs avant toute migration. Le script ne crée ni ne détruit le serveur; l'opérateur doit conserver des preuves de provisionnement puis détruire l'instance.

**Protocole reproductible à exécuter dans un environnement isolé :**

1. Construire depuis l'image PostgreSQL officielle épinglée, dans un environnement jetable sans réseau, un cluster neuf dont le socket est monté seul et dont le serveur n'écoute pas en TCP. Utiliser un rôle propre au test et ne réutiliser aucune base existante.
2. Exécuter `asset-exchange/db/test/prl_scratch_replay_run.sh` avec les variables requises et `PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY`. Garder la sortie, `SHOW server_version`, `SHOW data_directory`, `SHOW listen_addresses`, le chemin du socket et le SHA des migrations.
3. Sur ce même cluster, appliquer le protocole isolé décrit dans `asset-exchange/db/test/concurrency.sh`; confirmer les assertions de nombre d'offres, trades, évènements et lignes d'idempotence après chaque course. Le script comporte des `TRUNCATE`, donc ne jamais le diriger vers autre chose que le cluster jetable dédié.
4. Enregistrer les codes retour et les versions du serveur et client. Détruire le répertoire `PGDATA` et le cluster après vérification des résultats.

Tant que cette campagne n'a pas eu lieu, la qualification PostgreSQL native est **BLOCKED**. Les contrôles de texte SQL présents dans Node sont des contrats statiques, pas un test PostgreSQL.

## Campagnes de test

La dernière campagne a été exécutée sur le contenu correspondant au commit de code `c7bf2788f2672cb7fc19267ae31ea52d7ce02a50`, après les corrections de validation de `request_hash` et la mise à jour du pin Pearl. Le workspace fourni n'inclut pas de métadonnées Git; branche et fichiers de PR vérifiés via GitHub. Versions disponibles : Node `v24.22.3`, npm `11.19.1`, Python `3.12.14`, GNU Bash `5.2.37`. PostgreSQL et Docker/Podman absents.

| Campagne | Commande | Résultat | Ignorés | Limites |
|---|---|---:|---:|---|
| Suite Node déclarée du package | `npm test` | PASS — 167/167 | 0 | N'inclut pas les nouveaux fichiers `qualification/pearl/test_prl*.mjs`. Avertissement npm sur `http-proxy` inconnu dans la configuration d'environnement. |
| Suite Node complète y compris PRL | `mkdir -m 700 -p .test-tmp-all && TMPDIR="$PWD/.test-tmp-all" node --test core/test/*.test.mjs api/test/*.test.mjs worker/test/*.test.mjs chain-watchers/test/*.test.mjs recovery/test/*.test.mjs settlement/test/*.test.mjs qualification/pearl/test_prl*.mjs` | PASS — 219/219 | 0 | Le répertoire temporaire privé est créé sous `asset-exchange/` puis supprimé. Les contrats SQL sont statiques; pas de serveur PostgreSQL. |
| Suite Python Pearl | `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s qualification/pearl -p 'test_*.py'` | PASS — 94/94 | 0 | Tests locaux hors ligne, sans moteur Pearl ni validation de réseau. |
| Syntaxe des scripts SQL-lab shell | `bash -n asset-exchange/db/test/prl_scratch_replay_run.sh asset-exchange/db/test/concurrency.sh` | PASS | — | Vérifie la syntaxe shell uniquement. |
| Refus de garde du lanceur PRL | Variables scratch synthétiques complètes + `PGHOSTADDR=198.51.100.10`, puis refus sans configuration adéquate | PASS — code 2 avant `psql` | — | Vérifie les gardes d'entrée, pas une connexion DB. |
| Refus de garde de concurrence | `PG_IMAGE=postgres:16 PRL_SCRATCH_ACK= bash asset-exchange/db/test/concurrency.sh`; puis variables scratch synthétiques + `PGHOSTADDR=198.51.100.10` | PASS — code 2 avant Docker | — | Vérifie les gardes d'entrée uniquement. |
| PostgreSQL natif 16+ | Non exécuté | **BLOCKED** | N/A | Outils et serveur isolé absents; aucune migration ni requête DB exécutée. |

Des tentatives initiales reflétaient les limites de l'environnement : avant reconstitution locale de quatre modules Recovery présents au commit de référence, `npm test` échouait sur fichiers manquants; après récupération non modifiée de ces fichiers depuis `056e28f`, `npm test` a réussi 167/167. Une première exécution combinée Node avec `TMPDIR` pointant vers un répertoire absent a donné 215 PASS et 4 FAIL `ENOENT` sur `mkdtemp`; après création du répertoire privé sous `asset-exchange/`, la relance a réussi 219/219. Les données temporaires de test ont été supprimées.

## Revue STRIDE et inventaire des risques

| ID / catégorie | Gravité | Constat, scénario de laboratoire | Correctif / état |
|---|---|---|---|
| R1 — Falsification / élévation via rejeu idempotent historique | **ÉLEVÉE** | Ancienne version de la fonction SQL pouvait retourner `CONSUMED` à partir d'un enregistrement idempotent avant de lire l'offre et ses actifs. Scénario uniquement sur scratch : semer avant 010 un replay PRL `give` ou `want`, appliquer 010/011, puis exécuter le scénario après 011. | 011 relie `scope`, clé et request hash au trade et à l'offre stockés, vérifie les preuves persistées et appelle le garde PRL avant réponse. Couverture SQL écrite; validation native **BLOCKED**. |
| R2 — Déni de service / course d'idempotence | **ÉLEVÉE** | Deux processus simultanés avec la même clé pouvaient manquer la ligne initiale et produire un conflit d'unicité ou un échec de consommation au lieu du résultat persistant. Deux sessions scratch avec la même offre, le même taker, la même clé et les mêmes hashes doivent donner une seule ligne et le même résultat. | Verrou transactionnel consulté avant le registre; assertions à deux sessions ajoutées. **Non exécuté sur PostgreSQL.** Les attentes sous contention restent à mesurer. |
| R3 — Rejeu API après redémarrage/expiration | **MOYENNE** | Le service refusait `CONSUMED` avant que la base puisse prouver un replay identique; un client non-PRL pouvait perdre le résultat après redémarrage/expiration. | L'API laisse passer seulement le cas `CONSUMED` après contrôles d'identité, hash et epoch; la fonction SQL demeure arbitre de l'idempotence exacte. Test Node ajouté et PASS; SQL natif **BLOCKED**. |
| R4 — Clé d'actif malformée / canonisation | **MOYENNE** | Une clé stockée avec un identifiant d'actif vide ou entouré d'espace peut être non canonique. Reproduction locale dans tests API et scénario SQL scratch. | Rejet de l'identifiant vide ou avec espace ASCII de bord dans les contrôles API/SQL; cas couverts. La comparaison Unicode exacte entre `String.trim()` JS et `btrim()` PostgreSQL n'a pas été testée nativement; traiter cette équivalence comme résiduelle avant ouverture de la base à des écritures directes. |
| R5 — Sécurité du harnais / redirection de cible | **ÉLEVÉE pour l'intégrité des tests** | L'ancien lanceur de concurrence utilisait une cible TCP par défaut et réinitialisait les fixtures; `PGHOSTADDR` pouvait rediriger une cible de socket apparente. Reproduction lab : activer `PGHOSTADDR` et vérifier le refus avant le client. | Variables d'override libpq/URL partagée refusées, socket et `PGDATA` privés imposés, confirmations de cible; Docker isolé `--network none`. Les refus d'entrée passent; aucun serveur n'a été démarré. |
| R6 — Élévation par accès direct DB / changement de politique | **ÉLEVÉE — non résolue** | Les migrations n'installent pas de rôles, GRANT/REVOKE ou RLS. Le propriétaire ou superutilisateur peut modifier `operator_state`, remplacer/désactiver des fonctions ou désactiver des triggers. Aucun test de rôle ne peut être fait sans cible DB et modèle de rôles. | Précondition production : rôle migration propriétaire séparé du rôle API, rôle API non propriétaire/non superutilisateur avec privilèges minimaux, accès réseau restreint et procédure approuvée de migration. Définir et tester les droits exacts avant déploiement; pas de correctif arbitraire ajouté faute de configuration de déploiement. |
| R7 — Falsification de réseau via HRP partagé `rprl` | **ÉLEVÉE pour toute intégration de fonds** | Regtest et simnet partagent `rprl` et leurs valeurs genesis peuvent être identiques. Un contrôle de préfixe seul pourrait classifier le mauvais réseau. | README et tests précisent que l'HRP n'est pas une identité réseau; les profils source dérivés exigent tous les champs/réseaux. Aucun routage PRL n'est activé. L'identité d'un nœud réel reste non prouvée. |
| R8 — Rejeu d'acceptation avec hash de requête nul/malformé | **MOYENNE** | Dans 011, la comparaison `request_hash <> NULL` donne UNKNOWN en logique SQL; l'ancienne branche de rejeu pouvait donc restituer un résultat existant sans hash de requête valide. Reproduction laboratoire : rappeler la fonction avec la même clé et un hash NULL ou de 63 caractères. | 011 rejette maintenant les valeurs nulles et les chaînes qui ne sont pas 64 caractères hexadécimaux minuscules avant la lecture d'idempotence; tests SQL de scénario et contrat statique ajoutés. Tests logiciels PASS; exécution PostgreSQL **BLOCKED**. |
| R9 — Rejeux idempotents non uniformes dans publication, annulation et signatures de termes | **MOYENNE** | Les fonctions des migrations 003, 007 et 009 comparent `request_hash` avec `<>` sans rejet préalable de NULL; la comparaison UNKNOWN peut laisser passer un rejeu existant. Elles ne sérialisent pas non plus la première utilisation d'une même clé avant la lecture du registre d'idempotence; deux sessions peuvent produire une erreur de contrainte ou d'état au lieu d'un résultat stable. | Résiduel non corrigé dans cette proposition. Ajouter une validation stricte du hash et un verrou/recontrôle par portée-clé dans ces fonctions, puis couvrir les mêmes tests sur PostgreSQL 16+ avant qualification de production. |

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

1. Exécuter et faire revoir indépendamment les migrations 001–011 sur une instance PostgreSQL 16+ neuve et jetable, puis exécuter tous les scénarios SQL et deux sessions concurrentes; publier les logs, versions et preuves de destruction de la base.
2. Tester l'application avec le rôle API réellement provisionné : pas propriétaire ni superutilisateur; démontrer qu'il ne peut pas modifier la politique, désactiver les triggers, insérer directement une offre/trade ou altérer les preuves. Définir la séparation rôle migration/rôle runtime et le modèle de privilèges.
3. Faire vérifier l'identité PRL par une source indépendante et un nœud configuré avec le réseau exact : network magic, genesis/checkpoint, chaîne et règles d'adresse; documenter l'asset key Exchange, les grains et le traitement de Taproot witness-v1/P2MR witness-v2.
4. Qualifier l'observation de chaîne, les reorgs, les confirmations, la preuve de dépense, le chemin signer, la récupération, le refus des mauvais réseaux et les tests adversariaux sans fonds réels. Aucune capacité n'est couverte par cette proposition.
5. Passer une revue de sécurité indépendante du déploiement, des clés SSO, de TLS, des secrets, des logs, des alertes, des sauvegardes/restaurations, des dépendances et du plan d'incident.
6. Conserver les restrictions du registre tant que toutes les portes ci-dessus ne sont pas PASS et qu'une autorisation explicite distincte ne permet pas de changer les permissions PRL.
7. Corriger et tester les rejeux et la concurrence de request_hash dans les fonctions SQL 003, 007 et 009; obtenir une preuve PostgreSQL native pour chacune.

## Risque résiduel et conclusion

Le logiciel Exchange hors ligne passe ses tests. Les corrections de rejeu d'acceptation, de concurrence de la clé 011 et de cible du harnais sont présentes dans la branche proposée. Le défaut de validation request_hash a été corrigé dans 011; des gaps similaires restent dans 003, 007 et 009. Ces éléments ne prouvent pas que les migrations PostgreSQL compilent ou fonctionnent comme prévu. Les actifs réels, l'identité d'un nœud Pearl en activité, les rôles de déploiement et les opérations de règlement restent hors preuve.

**Conclusion :** la qualification de spécification native Pearl est vérifiée; la qualification opérationnelle PRL et la qualification PostgreSQL sont **BLOCKED**. La publication d'offres PRL reste **INTERDITE**, le règlement automatique PRL reste **INTERDIT**, et la sécurité de production est **NON QUALIFIÉE**. Ne pas fusionner, déployer ou modifier les capacités du registre sur la base des seuls tests hors ligne.
