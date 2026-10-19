# Stage 4 — retour arrière après expiration de l'ancien certificat

## Constat sur PC1 : restauration non garantie

- Paquet Stage 4 déjà signé/contrôlé sur PC1 au commit immuable 447b8f3f931bd61d3131cff6f7204d7625b108b2, manifeste signé SHA256 b7427f698c3a9dc8bc86eb4443f7531b03d10031ab20fc01f57a15cb4880b5b5. Non installé.
- Sauvegarde des quatre binaires historiques : C:\Users\hicha\gpubnb-stage4-backup-20261019-000047 ; SHA256 externe du fichier backup.manifest.json : 578d687907c398d7dd8d24af5717ead158c78a2210fd6796b7c961435ac17f86. Empreintes de tous les fichiers de sauvegarde revalidées par l'opérateur.
- Ancien certificat de signature SHA256 200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a ; expiration 2026-10-20T22:23:47Z. Les quatre signatures originales sont sans horodatage.
- La sauvegarde est intacte, mais restorableWithoutFurtherChecks=false : **NO-GO** pour une restauration supposée valable après expiration.

## Solution conditionnelle : RFC3161 sur des copies des anciens binaires

Microsoft documente la commande SignTool timestamp, qui peut ajouter un horodatage RFC3161 SHA-256 à un exécutable **déjà signé**, sans remplacer l'identité du signataire. Le pin historique intégré dans le worker/helper reste celui de l'ancien signataire. Une signature horodatée et reconnue peut conserver sa validité après expiration de son certificat, mais uniquement si les chaînes de confiance, la politique Windows et l'horodatage sont valides.

Références : https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool et https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures ; URL RFC3161 publiée par DigiCert : https://knowledge.digicert.com/solution/troubleshooting-timestamping-problems

Aucune garantie n'est donnée : un serveur TSA peut refuser les certificats autosignés, être indisponible ou renvoyer un jeton invalide ; la confiance en contexte utilisateur ne prouve pas la confiance LocalSystem ou locataire. Un serveur de temps non approuvé est un **blocage**. Ne jamais désactiver Defender, WDAC, Secure Boot ou Authenticode pour contourner le refus.

Le script scripts/stage4-prepare-timestamped-rollback.ps1 est en lecture seule par défaut. Il ne contacte **aucun** serveur TSA ni ne modifie le système sans le switch explicite -CreateTimestampedCopies. Une éventuelle requête TSA utilise une URL approuvée explicitement par l'opérateur : HTTPS par défaut ; seule exception HTTP admise par le script, l'URL exacte http://timestamp.digicert.com publiée par DigiCert. RFC3161 retourne un jeton signé et SignTool doit en vérifier la chaîne ; HTTP ne fournit aucune confidentialité ni protection contre le déni de service. Ne pas contourner les contrôles cryptographiques. Ceci constitue un échange réseau externe distinct à autoriser. Seule l'empreinte de signature est envoyée pour horodatage, jamais une clé privée ou un PFX.

### Préflight (lecture seule sur PC1)

Depuis un checkout mis à jour en préservant les éventuels changements locaux :

~~~powershell
$B = 'C:\Users\hicha\gpubnb-stage4-backup-20261019-000047'
$BH = '578d687907c398d7dd8d24af5717ead158c78a2210fd6796b7c961435ac17f86'
$OldPin = '200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'

.\scripts\stage4-prepare-timestamped-rollback.ps1 -BackupDirectory $B -ExpectedBackupManifestSha256 $BH -ExpectedSignerSha256 $OldPin
~~~

Le retour lecture seule vérifie les quatre fichiers, leur signature, architecture, empreinte, identité d'éditeur et échéance ; signale durableRollbackEstablished=false. Aucune signature n'est créée ou modifiée.

### Horodatage sur COPIES — non effectué et soumis à autorisation distincte

Après sélection d'une TSA RFC3161 SHA-256 reconnue et autorisation explicite de l'opérateur :

~~~powershell
$ReviewedTsa = Read-Host 'URL de la TSA apres revue (DigiCert officiel ou HTTPS approuve)'
$Timestamped = Join-Path $env:USERPROFILE ('gpubnb-stage4-rollback-timestamped-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

.\scripts\stage4-prepare-timestamped-rollback.ps1 -BackupDirectory $B -ExpectedBackupManifestSha256 $BH -ExpectedSignerSha256 $OldPin -CreateTimestampedCopies -TimestampUrl $ReviewedTsa -OutputDirectory $Timestamped
~~~

Le script refuse les URL HTTP autres que l'endpoint officiel DigiCert, un dossier existant, un lien de redirection, des fichiers non conformes et une signature expirant dans 15 minutes ou moins. Il ne touche qu'aux quatre **nouvelles copies** ; vérifie les nouveaux fichiers par SignTool verify /pa /all /v et Authenticode, conserve le signer SHA256 historique, relève le certificat TSA, vérifie que les anciennes sources sont inchangées. Il écrit rollback-timestamp-evidence.json et laisse readyToRestore=false. Un échec laisse INCOMPLETE-DO-NOT-RESTORE.txt ; un tel dossier ne doit jamais être restauré.

### Conditions encore requises avant de dire « retour arrière sûr »

1. Chaînes de confiance de l'ancien certificat et de la TSA reconnues dans les contextes nécessaires : opérateur, SYSTEM, locataire (non démontrées).
2. Vérification de l'acceptation après expiration sans modifier l'horloge Windows ; si impossible, conserver NO-GO ou construire/qualifier un fallback réellement durable.
3. Correspondance exacte des services/processus (agent session 0 non associé au service actuellement Stopped ; second agent session 1 sous GPUbnb Host).
4. Validation des ACL historiques, des hashes des copies horodatées et de la compatibilité des anciens worker/helper et pins ; aucune modification de la configuration Host.
5. Autorisation explicite d'arrêt, installation, restauration et éventuelles modifications de confiance Windows. Aucun de ces actes n'est autorisé par la préparation du rollback.

## Tests CI et commit de release

Tests offline de politique et rejets : scripts/tests/stage4-rollback.tests.ps1 sous PowerShell 5.1 et 7, sans TSA et sans installation. Ces tests ne valident pas la signature d'une vraie copie horodatée ni un retour arrière réel.

La PR #303 continue d'évoluer pour l'outillage. Le commit d'origine **des quatre binaires privés déjà signés** sur PC1 reste 447b8f3f931bd61d3131cff6f7204d7625b108b2 et doit rester distinct du HEAD de la PR. Tout changement réel du runtime/pin impose de recompiler et signer de nouveau ; une simple modification de documentation ou des scripts de préflight ne change pas l'identité des quatre PE existants.
