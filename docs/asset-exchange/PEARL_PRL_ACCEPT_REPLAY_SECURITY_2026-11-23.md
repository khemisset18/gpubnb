# Pearl PRL — revue du rejeu idempotent historique (23 novembre 2026)

**Portée STRICTE : Asset Exchange uniquement. Aucun minage, aucun portefeuille, aucun fonds réel.**

Branche de développement : experiment/pearl-prl-idempotency-replay-quarantine-20261123
Base : experiment/pearl-prl-historical-acceptance-guard-20261123 (PR n° 395).
Statut : **PROPOSITION EN BROUILLON, AUCUNE MIGRATION DÉPLOYÉE**.

## Risque identifié

La fonction PostgreSQL accept_offer_atomic issue de 002_atomic_offer_operations.sql vérifie une clé d'idempotence, puis retourne le résultat CONSUMED avant de relire les actifs d'une offre. Les trois triggers proposés dans 010 bloquent les futures écritures, mais pas un ancien résultat renvoyé sans INSERT/UPDATE. Dans le scénario d'une ancienne offre PRL déjà consommée, le retour d'idempotence pouvait donc contourner la quarantaine des actifs.

Une réponse CONSUMED de ce type ne crée pas nécessairement un nouveau transfert ; le risque porte sur la présentation trompeuse d'un résultat historique, le non-respect des politiques d'activation et la validité du chemin de rejeu. L'existence de lignes réelles PRL en base n'est pas démontrée.

## Correctif proposé : migration 011, non appliquée

- Conserve exactement la signature publique de accept_offer_atomic et ses opérations de trade, événement et idempotence pour les actifs non PRL.
- Avant tout résultat historique, relit l'offre et le trade stockés et compare deployment, identifiant, hash, policy epoch, taker, état CONSUMED, résultat d'idempotence, acceptance hash et signature opaque enregistrée.
- Rejette le rejeu en cas d'incohérence ; vérifie les deux clés d'actifs via la fonction de quarantaine installée par la migration 010, et bloque pearl/prl même si l'offre est déjà CONSUMED.
- Vérifie aussi les clés d'actifs stockées après le SELECT FOR UPDATE normal, avant tout INSERT du nouveau trade.
- N'accorde aucun droit de création d'offres, de règlement automatique ni de traitement d'actifs non qualifiés.

**Ordre indispensable de revue : migrations 001–009, fixture historique de laboratoire, migration 010, puis 011.** Ce n'est pas un ordre de déploiement autorisé en production.

## Preuves logicielles et tests

- 17 tests Node.js déclarés dans qualification/pearl/test_prl_accept_replay_contract.mjs : 12 contrôles de la signature de fonction, du chemin de rejeu, des clauses d'identité et des invariants non-PRL ; 5 contrôles de sécurité du protocole PostgreSQL jetable.
- Un lanceur facultatif db/test/prl_scratch_replay_run.sh refuse toute connexion ne visant pas un socket Unix /tmp/gpubnb-prl-scratch-* et une base prl_scratch_* explicitement déclarée. Il refuse une base Exchange déjà initialisée, n'installe aucun logiciel et ne crée pas de base.
- db/test/prl_scratch_historical_before_010.sql installe UNIQUEMENT des enregistrements fictifs dans une base de test vide AVANT les triggers : offres Pearl historiques déjà consommées dans les deux sens, une offre PRL ouverte et une offre consommée non-PRL témoin.
- db/test/prl_scratch_accept_replay_after_011.sql teste le comportement du moteur PostgreSQL après migrations 010/011 : refus PRL rejoué, refus de mauvais trade, refus de request hash divergent, non-régression du rejeu non PRL, et trois triggers. Ses écritures d'essai sont annulées par ROLLBACK.
- Les six tests SQL statiques précédents de la PR 395 ne suffisent pas à prouver ce comportement. Les tests Node des contrats 011 restent eux-mêmes NON EXÉCUTÉS sur le PC opérateur.

**Dernier résultat opérateur acquis : 143/143 tests PASS sur Ubuntu WSL2, commit 71d419b.** Aucun nouveau PASS ne doit être annoncé pour la branche 011 sans sortie des commandes correspondantes.

## Séparation et sécurité des tests natifs

Le lanceur SQL **n'a PAS été exécuté** : aucun serveur PostgreSQL jetable n'est disponible dans cet environnement de construction, et aucune base du projet ne doit être utilisée. Le protocole est fourni pour revue indépendante, puis éventuel essai sur une installation localement isolée, explicitement créée pour ces données.

Ne jamais fournir au lanceur une chaîne de connexion vers GPUbnb Core, un Exchange de test partagé, la production ou un système financier. Ne jamais l'exécuter sans la déclaration volontaire PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY, un socket privé, une base prl_scratch_* VIDE, PostgreSQL 16+ et des permissions limitées à ce laboratoire. L'absence de PostgreSQL ne doit PAS être compensée en utilisant Supabase ou une base existante.

## Limitations restant bloquantes

- La migration 010 et la migration 011 n'ont pas été exécutées sur PostgreSQL ; compilation, contraintes, transactions concurrentes, verrouillages, politiques de rôle, restauration et compatibilité native restent NON QUALIFIÉS.
- La réponse d'idempotence d'un ancien trade non PRL peut rester disponible même lorsque le mode opérateur désactive les nouvelles acceptations : comportement préservé volontairement pour le rejeu historique, mais à faire approuver comme politique fonctionnelle.
- Dans la couche API, l'acceptation d'un enregistrement déjà CONSUMED est actuellement refusée par la prévalidation de la PR 395 ; les rejeux HTTP/API authentifiés de non-PRL demandent donc un parcours distinct, sans relâcher le refus PRL et sans modifier DOGE/LTC dans cette PR.
- Aucune revue indépendante de l'identité native PRL, des clés canoniques historiques et du consensus/recovery n'a été menée.
- Aucun composant de minage ni paramètre GPUbnb hors Asset Exchange n'est modifié.

**Décision finale : PRL = MARKETPLACE_ONLY / RESTRICTED ; identityReady=false ; newOffersEnabled=false ; newTradesEnabled=false ; automaticSettlementSupported=false. Aucune fusion ni activation.**


## Mise à jour — preuve d'exécution WSL2 (commit f61dc5d)

L'opérateur a exécuté **160/160 tests hors ligne PASS** sur
Ubuntu WSL2 : 94 tests Python et 66 tests Node.js
(`fail=0`, `skipped=0`), commit exact testé
`f61dc5d6c7ead0a1448ccdd4b02cff45a3f27a4c`,
worktree de branche propre et suivi par `origin`.
Les tests ont été exécutés dans un namespace réseau isolé.
Les 17 tests nouvellement ajoutés à cette phase ont passé dans
ce groupe Node.

**Aucune exécution native PostgreSQL n'a été réalisée.** La
validation des 17 tests Node n'atteste que des contrats
statiques du SQL, de la politique de refus et du harnais de
laboratoire. Les migrations 010/011 restent **non appliquées**,
la base `prl_scratch_*` reste un protocole non exécuté,
et le déploiement financier demeure interdit.
