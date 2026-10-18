# Render — plan manuel prêt pour autorisation, non exécuté

## État relu le 18 octobre 2026

Service [gpubnb-stage3-private](https://dashboard.render.com/web/srv-dau86i2d0e5s73elmk10), ID `srv-dau86i2d0e5s73elmk10`. Dépôt `khemisset18/gpubnb`, branche `qualification/stage3-windows-native-private-3c3e21e6`, autoDeploy `no`, région Frankfurt, une instance, Docker, contexte `.`, Dockerfile `./apps/api/Dockerfile`, healthCheckPath `/health`.

Déploiement actif relu : `dep-db4j8gom7kps73c1u4p0`, statut `live`, commit `6b655614d3b9c3fda7912742b539601ba22598f1`. Le contrôle public `/release` confirme ce même SHA. `/health` répond `mainnetEnabled=false`, `escrowConfigured=false` ; `/ready` répond JSON `ok=true`. Le WSS santé répond exactement `gpubnb-ws-ok`.

Le connecteur ne fournit pas ici de lecture des variables d'environnement : **la valeur actuelle de `BETA_TEST_DEV_BYPASS` n'est pas attestée**. Aucun secret n'a été lu ou modifié. Vérifier dans le Dashboard habilité `BETA_TEST_DEV_BYPASS=true` ET `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET` ; toute autre combinaison bloque la qualification privée. Ne pas afficher les autres valeurs.

## Cible et préparation

Branche cible unique : `audit/ssj12007-consolidation`, PR #303. Le SHA à autoriser est **le `sourceCommit` complet du paquet final remis**, avec CI du même HEAD verte. Ne pas choisir automatiquement la dernière branche ou un ancien dernier run vert. Les commits de préparation utilisent `[skip render]` et ne constituent pas une autorisation de déployer.

Le Dockerfile existant embarque API et `apps/web` dans le même runtime, exécuté avec l'utilisateur `app`. Conserver cette architecture et le contrat de port Render, l'écoute `0.0.0.0`, les paramètres privés existants et les secrets. L'origine privée HTTPS sert l'authentification, le préflight et la gateway WSS ; aucun frontend Netlify à republier pour ce test. La configuration privée expose le SHA complet runtime via `/config.js` et échoue sans identité de release.

Avant toute action, relever les réglages non sensibles, le deploy ID et la disponibilité de son ancien artefact. La différence de migrations avec le Stage 3 est `20261006020000_stage4_supabase_internal_rls` : elle active RLS sur DiagnosticRun/MachineQuarantineEvent et révoque des privilèges futurs aux rôles navigateur. Vérifier le rôle Prisma effectif, la propriété des tables ou BYPASSRLS et les grants existants avant de l'appliquer ; ne pas désactiver RLS pour contourner une erreur.

**Le Dockerfile réellement configuré (`apps/api/Dockerfile`) démarre `node dist/server.js` et ne lance pas `prisma migrate deploy`.** Ne pas supposer que le déploiement appliquera la migration. Depuis un environnement opérateur autorisé connecté à la bonne base avec les identifiants protégés déjà prévus, contrôler `prisma migrate status`, sauvegarder l'état nécessaire et, seulement après autorisation de migration, exécuter `prisma migrate deploy` depuis `apps/api` au SHA cible. Aucun identifiant ne doit être envoyé dans le chat ni écrit dans une commande publiée. Si l'opérateur n'a pas ce chemin autorisé, bloquer le déploiement plutôt qu'accorder des privilèges excessifs. Son statut d'application réel n'a pas été lu ici.

Le retour Stage 3 ne retire pas RLS et ne restaure pas les anciennes permissions : vérifier que le même rôle serveur reste compatible. Ne pas appliquer le Blueprint public `render.yaml` à ce service privé existant.

## Exécution, exclusivement après accord explicite

1. Dans le service exact ci-dessus, conserver auto-deploy OFF. Autoriser séparément toute modification nécessaire de la branche ou des paramètres privés ; ne pas modifier de secret. Sélectionner le commit précis remis dans Manual Deploy / Deploy a specific commit, ou sélectionner la branche de consolidation puis ce SHA. Contrôler de nouveau le SHA avant validation.
2. Conserver le nouvel ID de déploiement, suivre jusqu'au statut `live` et vérifier les étapes build, migration et démarrage. Une acceptation de la demande n'est pas une preuve de succès. `/health` demeure le chemin configuré ; contrôler aussi `/ready` pour PostgreSQL/Redis et les capacités requises.
3. Exiger `/release.commit == SHA cible`, `/config.js.releaseCommit == SHA cible`, les pages et scripts Stage 4 réellement servis, le GET préflight anonyme refusé, puis le GET authentifié positif depuis le navigateur de l'utilisateur. Vérifier WSS `/ws-health`, Agent compatible `0.6.6`, paquet au même SHA, mode privé sans paiement. Ne lancer aucune réservation comme contrôle de déploiement.

## Rollback, également soumis à autorisation

Le déploiement cible de retour est `dep-db4j8gom7kps73c1u4p0` / SHA `6b655614d3b9c3fda7912742b539601ba22598f1`, seulement si son artefact est encore conservé. Le Dashboard Rollback crée un nouveau déploiement depuis cet artefact ; vérifier son statut live et `/release`. Si l'artefact n'est plus disponible, préparer une reconstruction manuelle de ce SHA plutôt que prétendre que le rollback est immédiat.

Les réglages du service et groupes d'environnement n'ont pas tous la même sémantique de retour ; comparer les valeurs non sensibles et contrôler les secrets uniquement dans leur gestionnaire autorisé. Les disques et effets PostgreSQL ne sont pas annulés. Vérifier la compatibilité des migrations avant le déploiement initial. Contrôler ensuite branche et auto-deploy OFF. Un retour backend seul ne valide pas les nouveaux binaires PC1.

Références officielles relues : [déploiements](https://render.com/docs/deploys), [santé](https://render.com/docs/health-checks), [rollback](https://render.com/docs/rollbacks). Aucun déploiement ou rollback n'a été déclenché ici.
