# Stage 4 — séparation de la preuve Render/API et du paquet Windows PC1

**Statut : lecture seule, PR de revue, aucun déploiement et aucune autorisation d'installation.**

## Deux versions observées

- Service privé Render : `gpubnb-stage3-private`, service ID `srv-dau86i2d0e5s73elmk10`, dernier déploiement live observé `26af83d8e8ef87b1f218a5b08671047594e645dc`, autoDeploy désactivé.
- Paquet Windows signé et vérifié sur PC1 : source `32ffdc72ec7041310c4b07e286ac4c4c2818906c`, manifeste `d0c465b4fcfd4d14c56a6d4e8e07d93db990738aad66ed8e6eea787da8c30335`.
- Sauvegarde de l'ancienne installation PC1 : manifeste `77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd`.
- Le test A3 a restauré les octets des quatre fichiers dans un clone isolé (hash et signature 4/4), sans restaurer les ACL du service ni effectuer de rollback physique.

## Vérification reproductible des sources

Le conteneur API (`apps/api/Dockerfile`) construit le serveur avec `apps/api/src`, Prisma et les dépendances verrouillées, mais **copie aussi `apps/web` dans l'image de production**.

Le script `scripts/stage4_private_backend_delta.py` compare les deux commits Git exacts, exige un lien d'ancêtre entre eux et répertorie le changement de chaque chemin. Il vérifie les composants suivants indépendamment :

- fichiers de compilation API (`apps/api/src`, `apps/api/prisma`, Dockerfile, package.json, lockfile, scripts API et tsconfig) ;
- fichiers de l'interface navigateur `apps/web` embarqués dans le conteneur Render ;
- code Agent Windows et composants natifs.

Le delta Git du 1er novembre contient 27 commits et 11 chemins modifiés, dont le code de récupération de quarantaine de l'Agent et plusieurs fichiers `apps/web`. Aucun fichier de production sous `apps/api/src` n'est listé ; les deux fichiers modifiés sous `apps/api/test` ne sont pas livrés dans l'image API. **Le bundle navigateur est, lui, différent.**

Les tests synthétiques changent volontairement une source API, le Dockerfile, le navigateur, les composants natifs et les commits, et vérifient que les conclusions ne deviennent jamais des autorisations d'installation.

## Ce qui est attesté et ce qui ne l'est pas

La comparaison peut démontrer uniquement l'identité des **sources Git de compilation API**, pour les deux commits pinnés. Elle ne prouve pas que le conteneur Docker réellement en cours d'exécution correspond bit à bit à sa source Git ou que le nouveau navigateur fonctionne avec les endpoints serveur actuellement déployés.

Le rapport conserve donc toujours `renderRunningImageCommitIndependentlyAttested=false`, `browserSessionProtocolCompatibilityAttested=false`, `signedOwnerCleanupEvidenceReceived=false`, `pc1ServiceTransactionalRollbackTested=false` et `installationAuthorized=false`. Ne jamais transformer un `apiRuntimeInputsIdenticalAtSource=true` en feu vert.

## Gates avant un vrai PC1→PC2 (300 secondes)

1. Préparer et revoir une variante du frontend/API adaptée à la révision du backend privé, et la tester hors production avec les voies de signalisation native/WTS.
2. Attester la release concrète qui tourne sur Render privé (image/build Git SHA et vérification des routes nécessaires). Tout déploiement réel doit être expressément autorisé ; le service public reste inchangé.
3. Vérifier un vrai installateur/rollback transactionnel du service Windows (y compris ACL Program Files, conservation de l'état et confiance LocalSystem) dans un environnement jetable avant une maintenance opérateur.
4. Obtenir le nouveau diagnostic propriétaire signé pour `WORKSPACE_CLEANUP_FAILED`, sans reset inventé, sans suppression de quarantaine par SQL et sans réactivation de réservations.
5. En présence de l'opérateur, contrôler la session WTS **exclusive locataire**, ne jamais capturer le bureau administrateur ; seulement alors exécuter H264/NVENC + clavier/souris durant au moins 300 secondes.

**NO-GO à date :** ne pas merger automatiquement les drafts empilées, installer PC1, déployer sur Render, lever la quarantaine ou activer le streaming public.
