# Signature privée : certificat réel et remplacement avant expiration

La signature effective exige l'accès local à la clé privée de PC1. Ce dossier prépare les commandes ; il ne constitue pas une preuve de signature PC1. L'autorisation de finaliser la signature ou de préparer le remplacement ne vaut pas autorisation d'installer les binaires, de changer la confiance Windows, de remplacer le pilote ou de déployer Render.

## 1. Contrôle local du certificat existant — lecture seule

Exécuter sous le compte Windows qui détient la clé, depuis les scripts revus de la PR #303 ou le dossier `support` de son nouvel artefact. Le relevé historique indique une fin de validité le **20 octobre 2026 à 22:23:47 UTC / 21 octobre à 00:23:47 Paris**. Ce relevé ne remplace pas la lecture du magasin actuel.

```powershell
$P = '200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a'
.\stage4-private-certificate.ps1 -ExpectedPublisherSha256 $P
```

Le JSON donne le pin réel, les dates UTC, les heures restantes, la présence de la clé, l'EKU et le premier blocage. `signingReady=true` exige exactement le pin attendu, la clé privée, le sujet de test, l'EKU code signing, au moins 24 heures restantes et la chaîne Windows déjà approuvée. `renewalRecommended=true` dès 72 heures restantes avertit de préparer le remplacement, même si une signature reste encore possible. `absent` signifie absent **dans ce compte CurrentUser/My**, pas absent de tous les comptes de PC1.

Aucun certificat n'est choisi à partir de son seul nom, aucune clé n'est exportée et aucune confiance n'est ajoutée. Les signatures sont vérifiées de nouveau au moment de signer : ce rapport ne remplace pas le préflight du paquet.

## 2. Si le certificat existant suffit à la qualification

Pour le paquet vérifié du 18 octobre, les références indépendantes sont :

- source `db149c275c0b1a1bf7e5079448f0532328fd0491` ;
- [artefact 12134998397 du run 39123309723](https://github.com/khemisset18/gpubnb/actions/runs/39123309723/artifacts/12134998397) ;
- ZIP interne SHA-256 `21ac9f00c39f44824113ccd897dd557dd63550c593a454dfabf8eb7c0858f8a8` ;
- manifeste unsigned SHA-256 `9f124edb6c830b8b5ba54b3577091daf95bfdcd3893375da85077f2081f128a3` ;
- pin `$P` ci-dessus, embarqué dans le worker et le helper.

Ces valeurs concernent exclusivement cet artefact. Pour un autre run, reprendre ses références vérifiées, sans réutiliser ces hashes. Le SHA du ZIP interne n'est pas celui de l'enveloppe de téléchargement GitHub. Vérifier ce ZIP avant extraction ; ne pas exécuter un PE unsigned sur PC1.

```powershell
$S = 'db149c275c0b1a1bf7e5079448f0532328fd0491'
$M = '9f124edb6c830b8b5ba54b3577091daf95bfdcd3893375da85077f2081f128a3'
# Renseigner les deux chemins locaux réels ; le dossier Signed doit être neuf.
$Unsigned = Read-Host 'Dossier extrait du paquet unsigned verifie'
$Signed = Read-Host 'Nouveau dossier de copies signees hors des chemins installes'
.\stage4-private-test-sign-copies.ps1 -UnsignedDirectory $Unsigned -ExpectedCommit $S -ExpectedManifestSha256 $M -ExpectedPublisherSha256 $P
```

Si le contrôle réussit et que l'échéance couvre la qualification et le retour arrière prévus, la signature des seules copies est l'opération suivante, autorisée par la demande utilisateur du 18 octobre :

```powershell
.\stage4-private-test-sign-copies.ps1 -UnsignedDirectory $Unsigned -ExpectedCommit $S -ExpectedManifestSha256 $M -ExpectedPublisherSha256 $P -SignCopiesForPrivateTest -OutputDirectory $Signed
```

La commande utilise SignTool déjà présent, le magasin utilisateur `My`, `/fd SHA256`, puis `verify /pa /all /v` et Authenticode. `/sha1` sert uniquement à sélectionner le certificat du magasin ; le pin de contrôle et le digest de signature sont SHA-256. Aucun timestamp n'est ajouté : ces copies restent limitées par la validité du certificat local. SignTool absent, clé inaccessible, chaîne non approuvée ou signature non valide provoquent un arrêt. Ne pas installer un SDK ni modifier Windows automatiquement pour contourner cet arrêt.

Le résultat doit indiquer quatre `signedFiles`, leurs hashes, le nouveau hash du manifeste signé, `expiresUtc` et `installationPerformed=false`. Conserver ce rapport hors du dossier signé. L'absence de marqueur `INCOMPLETE-DO-NOT-INSTALL.txt` et un nouveau passage du vérificateur sont obligatoires :

```powershell
$SignedManifestHash = Read-Host 'SHA-256 du manifeste signe donne par le rapport de signature'
.\verify-stage4-package.ps1 -PackageDirectory $Signed -ExpectedCommit $S -ExpectedManifestSha256 $SignedManifestHash -ExpectedPublisherSha256 $P -SignatureStatus private-signed
```

## 3. Remplacement si l'échéance est trop proche

Le parcours est préparé pour exécution locale ; aucune création de certificat PC1 n'a été effectuée ici. Choisir un dossier de sortie neuf dont le parent existe, hors de `Program Files`, `ProgramData`, `Windows` et des sources. Prévisualisation sans écriture :

```powershell
$Replacement = Read-Host 'Nouveau dossier pour les seuls fichiers publics du certificat'
.\stage4-private-certificate.ps1 -ExpectedPublisherSha256 $P -CreateReplacement -OutputDirectory $Replacement -WhatIf
```

Lors de l'exécution locale autorisée de la création, reprendre la même commande sans `-WhatIf`. Elle crée un certificat de **test privé**, RSA 3072 / SHA-256 / EKU code signing / clé CNG `NonExportable`, dans `CurrentUser/My`, pour 14 jours. Elle vérifie la politique effective de la clé et préserve l'ancien certificat. Elle écrit uniquement :

- `stage4-private-public.cer`, DER public sans clé privée ;
- `certificate-preparation.json`, pin réel, dates et métadonnées publiques ;
- `SHA256SUMS`.

Le hash SHA-256 du fichier CER doit être identique au nouveau `publisherSha256`. Un dossier avec `INCOMPLETE-CERTIFICATE-PREPARATION.txt` n'est pas accepté. Ne jamais transmettre un PFX, une clé privée, un mot de passe ou un magasin complet. Pour poursuivre la reconstruction, seuls le nouveau pin et les dates publiques sont nécessaires.

**La création ne rend pas le certificat approuvé.** La commande ne touche à aucun magasin Root/TrustedPublisher. L'approbation éventuelle du CER exact doit être examinée et autorisée séparément pour les contextes opérateur, SYSTEM et locataire qui vérifient les signatures. Une confiance CurrentUser de l'opérateur ne prouve pas celle du service ni du locataire. Tant que la chaîne n'est pas approuvée dans le contexte requis, l'échec reste bloquant.

Reconstruire ensuite les **quatre composants au même commit** avec le nouveau pin réel dans l'entrée `publisher_sha256` du workflow complet. Vérifier à nouveau le ZIP, le manifeste, les identités et les pins embarqués. Si le workflow de branche n'est pas disponible au dispatch, consolider cette seule référence publique dans la branche existante. Ne pas simplement re-signer le worker/helper de l'ancien pin. Reprendre l'audit du nouveau certificat et la signature avec les **nouveaux** S/M/P issus de ce build.

Le retour arrière doit lui aussi disposer d'un ensemble cohérent et encore valide. Une sauvegarde d'anciens binaires avec signature expirée sans timestamp ne garantit pas leur acceptation par Windows. Ne pas supprimer l'ancien certificat ni ses fichiers avant d'avoir revu ce point.

## Protections et vérification

Aucune étape ne change Secure Boot, l'intégrité mémoire/HVCI, Defender, SmartScreen, WDAC/AppLocker, la politique d'exécution PowerShell ni le mode de signature des pilotes. Un blocage par une politique Windows doit être résolu par une signature ou une autorisation d'éditeur appropriée, après revue ; aucune désactivation, exclusion antivirus ou levée globale de contrôle n'est proposée. Le pilote IddCx existant ne fait pas partie des quatre fichiers signés et n'est ni remplacé ni re-signé ici.

Les tests 5.1/7 utilisent des certificats en mémoire pour le statut et des clés de test éphémères sur les seuls runners GitHub hébergés pour la création. Ils vérifient le mode lecture seule, `WhatIf`, la clé non exportable, l'export public, la conservation de l'ancien certificat et l'absence de changement des quatre magasins de confiance lus. Ils ne constituent pas une signature du paquet avec le certificat réel PC1.

Références Microsoft : [New-SelfSignedCertificate](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate), [Export-Certificate, export sans clé privée](https://learn.microsoft.com/en-us/powershell/module/pki/export-certificate), [SignTool, sélection du magasin et vérification Authenticode](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).
