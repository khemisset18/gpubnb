# Pearl PRL – qualification PostgreSQL et API du 24 novembre 2026

**PASS en laboratoire pour les migrations 010–012, l'atomicité et les contrôles détaillés ci-dessous.** PostgreSQL 16.16 a créé un cluster neuf, exécuté les 12 migrations et détruit ses données et identifiants. Les demandes d'offre et de règlement PRL restent fermées dans Asset Exchange. [Journal PostgreSQL](research/2026-11-24/prl-native/postgres-final.txt) · [Rapport blockchain et matrice P0–P9](PEARL_PRL_REGTEST_NATIVE_2026-11-24.md)

La branche `qual/prl-postgres-native-397` part de `19055e1a47296d611a950a20361341cc0e7b29f7`. Le code SQL et les suites Exchange ont été exécutés à `7dbe541356f59b26e253bbe9e8326194e720d10e`. La PR cible la branche expérimentale de #397. [PR #397](https://github.com/khemisset18/gpubnb/pull/397) · [PR brouillon #399](https://github.com/khemisset18/gpubnb/pull/399)

## Isolation constatée

Le harnais exécute `initdb` dans un répertoire temporaire privé de mode 0700, crée la base à partir de `template0`, choisit un port de boucle locale et génère les mots de passe SCRAM. Il vérifie le PID du processus lancé, l'identifiant système issu de `pg_controldata`, le répertoire retourné par le serveur, l'adresse d'écoute et l'absence d'objets applicatifs. La connexion de test utilise un propriétaire de schéma sans SUPERUSER, CREATEDB ni CREATEROLE. L'environnement de connexion est reconstruit localement. Le test CI a même été exécuté avec un PGHOST hérité réservé à la documentation et un port inutilisable. Le journal donne l'identité du cluster effectivement ouvert et confirme sa destruction. [Harnais](../../asset-exchange/db/test/prl_disposable.py) · [Sortie intégrale](research/2026-11-24/prl-native/postgres-final.txt)

## Résultats de l'audit

| Cible | Défaut ou risque contrôlé | Observation native |
|---|---|---|
| 010 – offres historiques | Un trade créé avant la quarantaine pouvait encore recevoir une modification directe de ses termes. La normalisation d'un identifiant SQL ne couvrait pas tous les blancs Unicode traités par l'API. | Refus de la création et de la consommation PRL, de la modification directe des termes et des identifiants non canoniques. Les lectures et l'annulation historique restent possibles. |
| 011 – acceptation et rejeu | Une comparaison SQL nullable pouvait laisser passer une identité ou une preuve incomplète. | Contrôles explicites sur déploiement, rôles applicatifs, identifiants, epoch, format des empreintes et taille de la signature. La fonction relit l'offre et le trade persistés. Un rejeu historique PRL identique est lui aussi refusé. |
| 012 – publication, annulation, termes | Un rejeu devait rester lié aux octets de la requête initiale et à sa portée. Un trade historique devait hériter de la quarantaine de son offre. | Identité, hash, preuve et acteur vérifiés. Un retry admissible peut retourner le résultat durable après expiration. Une nouvelle publication expirée est refusée après acquisition du verrou. Les deux voies de soumission des termes relisent l'offre. |
| Rejouer le DDL | Redémarrage d'un outil de migration | La seconde application de 010, conçue pour une exécution unique, retourne `42723`. La transaction protège le catalogue. 011 et 012 se réappliquent. Le harnais compare empreintes des fonctions, triggers et lignes avant/après. |
| Transaction partielle | Échec injecté sur la dernière écriture d'une acceptation | Offre toujours ouverte, aucun trade, événement ni enregistrement d'idempotence résiduel. Un client tué avant COMMIT donne le même résultat. Après une réponse de commit écartée, le retry renvoie exactement un trade, un événement et une preuve. |
| Concurrence | Deux clients sur les mêmes identifiants et le même état métier | 10 scénarios exécutés, dont acceptation contre acceptation, acceptation contre annulation, clé réutilisée avec un contenu différent, changement d'epoch, immuabilité, doubles publications, annulations et signatures. |
| Privilèges | Accès SQL direct en lecture seule | Le rôle lecteur voit les quatre offres de la fixture. UPDATE et appel d'une fonction mutante échouent sous ce rôle. Les fonctions de ce schéma s'exécutent avec les droits de l'appelant. |

Un ancien test attendait `23505` quand la preuve d'annulation changeait à empreinte de requête constante. Le moteur retourne `55000` pour l'identité persistée incohérente. Les deux cas ont désormais des assertions distinctes. D'autres contrôles exigent le motif précis du refus pour éviter qu'une collision fortuite de fixture fasse passer le test. [Échec initial](research/2026-11-24/prl-native/first-postgres-failure.txt) · [Scénarios d'atomicité](../../asset-exchange/db/test/prl_atomicity.sql) · [Privilèges](../../asset-exchange/db/test/prl_lab_privileges.sql)

## Non-régressions

| Catégorie | Preuve |
|---|---|
| API, logique métier, contrôles statiques et doubles de test | 343/343 tests Node avec Pearl. La commande standard de la fondation en couvre 283, tous réussis. Les deux nombres se recouvrent. [Suite étendue](research/2026-11-24/prl-native/node-final.txt) · [Suite standard](research/2026-11-24/prl-native/npm-final.txt) |
| Préparation Pearl hors ligne | 94/94 tests Python avec fixtures synthétiques. [Journal](research/2026-11-24/prl-native/python-final.txt) |
| Syntaxe | 110 modules JavaScript contrôlés. [Journal](research/2026-11-24/prl-native/syntax-final.txt) |
| CI GitHub au commit SQL testé | Fondation Exchange, concurrence PostgreSQL et CI générale réussies. [Fondation](https://github.com/khemisset18/gpubnb/actions/runs/45355140919) · [PostgreSQL](https://github.com/khemisset18/gpubnb/actions/runs/45355140807) · [CI](https://github.com/khemisset18/gpubnb/actions/runs/45355141087) |

Le manifeste d'inventaire d'octobre attendait l'ancienne empreinte du registre. La différence entre les deux révisions porte sur le symbole et la quarantaine PRL ainsi que le paramètre qui applique cette quarantaine. Une comparaison profonde a retrouvé les 25 autres entrées identiques. Le manifeste conserve les deux empreintes. Les deux valeurs synthétiques d'idempotence signalées par Gitleaks sont désormais générées pendant les tests. [Manifeste](research/2026-10-30/SIX_CHAIN_READINESS.json) · [CI après correction](https://github.com/khemisset18/gpubnb/actions/runs/45355141087)

## Commandes de reproduction

Depuis la racine du dépôt, avec un compte non privilégié, Python 3.12+, Node 24 et un répertoire de binaires PostgreSQL 16+ contenant notamment `initdb`, `postgres`, `pg_controldata` et `psql`. Le tarball PostgreSQL 16.16 et les binaires locaux sont identifiés dans le relevé de provenance. [Sources PostgreSQL 16.16](https://www.postgresql.org/ftp/source/v16.16/) · [Empreintes](research/2026-11-24/prl-native/provenance.txt)

```bash
export TMPDIR="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1
# PG_BIN désigne le sous-répertoire bin de la distribution PostgreSQL.
python3 asset-exchange/db/test/prl_disposable.py --pg-bin "$PG_BIN"
(
  cd asset-exchange
  npm run check
  npm test
  node --test core/test/*.test.mjs api/test/*.test.mjs worker/test/*.test.mjs \
    chain-watchers/test/*.test.mjs recovery/test/*.test.mjs settlement/test/*.test.mjs \
    release/test/*.test.mjs research/test/*.test.mjs qualification/pearl/test_prl*.mjs
  python3 -m unittest discover -s qualification/pearl -p 'test_*.py' -v
)
```

Le SQL traite les preuves binaires comme des valeurs opaques. La vérification cryptographique et l'authentification de l'acteur relèvent de l'API. Un administrateur capable de redéfinir les fonctions ou de désactiver les triggers reste une frontière de confiance. Les attributions réelles des rôles d'exploitation, la restauration d'une base de production et une mise à niveau d'un site qui aurait déjà appliqué les anciennes versions de 010–012 restent hors du résultat. Une telle mise à niveau demanderait une migration corrective versionnée et sa propre validation.
