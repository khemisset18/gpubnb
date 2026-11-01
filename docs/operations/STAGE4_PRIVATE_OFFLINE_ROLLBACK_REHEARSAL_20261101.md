# Stage 4 — exercice hors installation : quatre fichiers seulement

## Constat Windows et décision

Le préflight PC1 a validé six contrôles en lecture seule, le nouveau
paquet privé signé et la sauvegarde d'origine (hashes et ACL du vrai
C:\Program Files\GPUbnb). Le premier essai scratch A1 s'est arrêté
avec stage4_offline_scratch_directory_acl_mismatch. Le correctif
suivant a échoué à nouveau sur PC1 A2 :
stage4_scratch_acl_snapshot_mismatch:scratch-directory.

**Ni A1 ni A2 ne sont une preuve de restauration. Ne les effacer ni
les réutiliser.** Ces échecs ont montré que le test était mal posé :
les ACE héritées de Program Files dépendent de son parent NTFS,
alors que Downloads possède un parent différent. Windows recalcule
les ACE héritées lorsqu'on applique une DACL à un autre endroit.
Des tests GitHub verts sur des ACL synthétiques ne valident pas les
permissions NTFS particulières du PC1.

Sources Microsoft :
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-5.1
- https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/0f0c6ffc-f57d-47f8-a6c8-63889e874e24

## Exercice corrigé : preuve de restauration des octets, pas des ACL

Le script scripts/stage4-private-offline-rollback-drill.ps1 garde
toutes les validations d'identité, manifeste, certificat, signature
et comparaison du backup avec les fichiers du service en lecture seule.
Il refuse toute sortie existante, chemin système, chevauchement,
ancêtre reparse point, mauvaise machine, mauvais GPU ou mauvais signer.

Dans un nouveau sous-dossier DIRECT de Downloads, l'outil :
1. Copie exactement les quatre binaires signés du candidat neuf
   dans un clone temporaire et vérifie signatures et hashes.
2. Remplace ces quatre copies TEMPORAIRES uniquement par les quatre
   fichiers de la sauvegarde épinglée ; aucune écriture live.
3. Vérifie après copie les quatre hashes SHA-256, signatures
   Authenticode, signataire et expiration.
4. Vérifie en lecture seule les SDDL des quatre fichiers live ET
   du dossier Program Files contre le manifeste de sauvegarde ;
   **il n'applique aucune ACL au clone**.
5. Produit un rapport scindant explicitement les garanties :
   - scratchFourFileHashesAndSignaturesVerified=true ;
   - liveFourFileAclsMatchPinnedBackup=true ;
   - liveDirectoryAclMatchesPinnedBackup=true ;
   - scratchAclReconstructionVerified=false ;
   - originalParentInheritanceReproduced=false ;
   - realServiceFileAclsRestored=false ;
   - realServiceRollbackTested=false ;
   - installationAuthorized=false.

Si un contrôle échoue, le dossier reçoit
INCOMPLETE-DO-NOT-USE.txt ; il ne peut pas être utilisé comme
package d'installation.

L'exercice prouve seulement l'exactitude des octets de quatre copies
et la conformité des ACL live à l'instant du contrôle. Il NE prouve
ni restauration fonctionnelle d'un service arrêté, ni confiance
LocalSystem réelle, ni durée/expiration d'un nouvel installateur,
ni compatibilité de la release privée Render ni session locataire.

## Traçabilité du test

Le candidat installé n'a PAS changé :
- Machine : cmsiggruy0004df0tn669f6bn ;
- GPU : GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a ;
- Commit source : 32ffdc72ec7041310c4b07e286ac4c4c2818906c ;
- Candidat manifeste SHA256 : d0c465b4fcfd4d14c56a6d4e8e07d93db990738aad66ed8e6eea787da8c30335 ;
- Backup manifeste SHA256 : 77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd ;
- Signataire SHA256 : 3060de709bd0db7fa8588b7480a8a04f94b2a7df005ee48361cbdcd39b0e9619 ;
- Signatures sans timestamp : certificat de test expire
  le 2026-11-13T00:20:59Z.

Aucune nouvelle exécution PC1 ne doit être demandée sans que la
CI Windows 5.1/7 et les autres workflows soient verts au HEAD exact.
Même dans ce cas, un succès scratch ne donne PAS l'autorisation
d'installer le nouveau paquet.

## Verrous physiques inchangés

Render privé est actuellement au commit
26af83d8e8ef87b1f218a5b08671047594e645dc,
différent de la source candidate Windows 32ffdc72...
La compatibilité doit être attestée avant déploiement privé.

PC1 est toujours en quarantaine WORKSPACE_CLEANUP_FAILED.
Il manque un diagnostic cleanup propriétaire signé, un rollback
transactionnel réel du service (avec permissions NTFS dans son
dossier réel), confiance LocalSystem, session console exclusive
renter et validation H264 + input PC1 vers PC2 pendant 300 s.

**Toujours NO-GO pour installer, déployer, lever la quarantaine,
ouvrir les réservations ou capter le bureau administrateur.**
