# Stage 4 — Reconstruction de sauvegarde en bac à sable

**Statut : PR en brouillon, logiciel uniquement. Aucune installation autorisée.**

Le PC1 a réussi six contrôles locaux (6/6), sans installation.
Le manifeste du nouveau paquet privé signé est :
d0c465b4fcfd4d14c56a6d4e8e07d93db990738aad66ed8e6eea787da8c30335

L'ancien manifeste de sauvegarde est :
77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd

Source Windows : 32ffdc72ec7041310c4b07e286ac4c4c2818906c
Signataire SHA-256 : 3060de709bd0db7fa8588b7480a8a04f94b2a7df005ee48361cbdcd39b0e9619
Machine : cmsiggruy0004df0tn669f6bn
GPU : GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a
Compte locataire : gpubnb-renter-qual

Le certificat de test n'a pas d'horodatage et expire le 13 novembre 2026 UTC.

## Contrat du nouvel outil

Le script scripts/stage4-private-offline-rollback-drill.ps1 :

1. Refuse toute sortie existante ou hors d'un nouveau sous-dossier direct de
   Downloads préfixé GPUbnb-Stage4-rollback-rehearsal-, ainsi que les
   chevauchements de chemins et les reparse points des dossiers sources.
2. Relance les six contrôles du script d'audit existant, avec tous les
   identifiants et manifestes SHA-256 externes.
3. Copie quatre binaires du nouveau candidat dans un dossier isolé, confirme
   signatures et hashes, puis restaure les quatre fichiers sauvegardés
   **uniquement dans cette copie de test**.
4. Applique les ACL des fichiers et du dossier sur cette copie, et vérifie
   de nouveau hashes, signatures, expirations et ACL. Aucun service réel ne
   doit être arrêté ou redémarré.
5. En cas d'échec, écrit INCOMPLETE-DO-NOT-USE.txt dans le nouveau dossier.
   En cas de succès, écrit offline-rollback-rehearsal.report.json ; tous
   les champs d'autorisation d'installation/déploiement/quarantaine restent false.

Cet exercice apporte une preuve utile de reconstruction à partir d'une
sauvegarde dans un bac à sable. **Ce n'est PAS un exercice de rollback réel**
du service ou une garantie de compatibilité entre versions.

## Exécution : uniquement après CI Windows et revue

Avant d'envisager une exécution locale, exiger les tests Windows 5.1 et 7
réussis sur le SHA exact de la PR, revue de code, téléchargement vérifié à
une empreinte GitHub indépendante. Les scripts sont à lancer seulement sous
le compte de maintenance administrateur hicha, jamais dans le compte locataire.
Les paramètres attendus incluent :

- CandidateDirectory : Downloads\GPUbnb-Stage4-nouveau-paquet-prive-32ffdc72
- ExpectedCandidateManifestSha256 : d0c465b4fcfd4d14c56a6d4e8e07d93db990738aad66ed8e6eea787da8c30335
- BackupDirectory : Downloads\GPUbnb-backup-old-26af83-20261101
- ExpectedBackupManifestSha256 : 77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd
- ExpectedCommit : 32ffdc72ec7041310c4b07e286ac4c4c2818906c
- ExpectedPublisherSha256 : 3060de709bd0db7fa8588b7480a8a04f94b2a7df005ee48361cbdcd39b0e9619
- ExpectedMachineId : cmsiggruy0004df0tn669f6bn
- ExpectedGpuUuid : GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a
- RenterAccount : gpubnb-renter-qual
- OutputDirectory : nouveau sous-dossier direct de Downloads préfixé GPUbnb-Stage4-rollback-rehearsal-

## Verrous inchangés

Render privé exécute actuellement 26af83d8e8ef87b1f218a5b08671047594e645dc,
différent du paquet Windows 32ffdc72... La compatibilité de ces versions n'est
pas attestée. La quarantaine WORKSPACE_CLEANUP_FAILED reste active. Les
annonces publiques doivent rester désactivées.

Le vrai cutover nécessite encore : un installateur séparé et revu, un
rollback transactionnel testé sur un vrai service Windows, une autorisation
de maintenance explicite, une release serveur privée alignée et un
DiagnosticRun signé prouvant nettoyage/STOP/GPU quiescent. Seulement après :
session locataire exclusive et test PC1 vers PC2 H.264 + clavier/souris
pendant au moins 300 000 ms. Ne jamais capturer le bureau administrateur.

## Correction du premier test scratch : héritage NTFS

Le premier exercice PC1 a retourné stage4_offline_scratch_directory_acl_mismatch
et a créé le marqueur INCOMPLETE. Les dossiers source et scratch avaient
le même propriétaire mais des ACE héritées différentes selon le parent.
Ceci ne prouve pas que la sauvegarde est corrompue.

Le correctif construit, EN MEMOIRE, un instantané d'ACL explicitement
protégé depuis les permissions effectives du fichier ou dossier live.
Il applique ce snapshot UNIQUEMENT dans le clone, puis compare strictement
le SDDL complet ainsi que les signatures et empreintes sauvegardées.
L'installation et la sauvegarde originales ne sont jamais modifiées.
Les tests Windows reproduisent deux parents NTFS avec des ACE différentes
et vérifient le refus d'une ACE supplémentaire.

Un résultat réussi signifie uniquement que les droits effectifs ont été
copiés dans le clone ; la relation parent/enfant NTFS originelle ne peut
pas être reproduite dans Downloads et reste explicitement non attestée.
Le rapport conserve originalParentInheritanceReproduced=false,
realServiceRollbackTested=false et installationAuthorized=false.

Ne pas réutiliser, effacer ou renommer le dossier d'échec
GPUbnb-Stage4-rollback-rehearsal-20261101-A1.
Toute nouvelle exécution requiert d'abord tests CI et revue du SHA exact,
puis un nouveau nom scratch. Aucun succès du correctif sur PC1 n'est
confirmé à ce stade.
