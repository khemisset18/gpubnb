# PC1 — dossier privé, sans installation exécutée

## Références connues, à réévaluer localement

Observations utilisateur : GTX 1650, pilote 592.82, UUID `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a` ; `GPUbnb Isolated Virtual Display`, `ROOT\DISPLAY\0000`, état OK ; fournisseur `HICHAM\hicha`, locataire local activé `gpubnb-renter-qual` avec SID distinct. **Aucune session locataire interactive n'a été démontrée.**

Deux Agent ont été observés : `C:\Program Files\GPUbnb` en session 0 et `C:\Program Files\GPUbnb Host` en session 1. Le service `GPUbnbAgent` était Stopped. Corréler PID, chemin et session avec l'inventaire ; ne pas en déduire qu'un redémarrage est nécessaire.

| Fichier installé historique | SHA-256 observé |
| --- | --- |
| gpubnb-agent.exe | 073c98950248301bb152aa0ebd08c5e72d0a118f294388b584029cd145e981da |
| gpubnb-windows-stream.exe | d114bca3293da78481dee1d53d06c7b91b4a94f08ccde4a61d268ea73d039690 |
| gpubnb-windows-worker.exe | 720325acac59d5e7e24f25f2ec72e13cef1e1071249943f024ff135844091579 |
| GPUbnbWindowsMedia.dll | 510d559b056ba094f8dc06b73d4c6d7bce46ca97fa774524e605844ad16fc9de |

Agent installé : `0.6.6`, frozen, commit `9be531450463`. Worker installé : `3cb18fb71c494e3947768455d61bc8763cd1e5c2`. Ces fichiers ne constituent pas le nouveau paquet Stage 4.

## Contrôle du paquet avant signature

Télécharger uniquement l'artefact 4/4 du HEAD retenu, vérifier le hash du ZIP depuis `stage4-provenance.txt`, puis extraire dans un dossier neuf hors des chemins installés. Conserver hors bande : `$S` = SHA complet, `$M` = SHA-256 du manifeste unsigned, `$P` = SHA-256 du certificat public prévu. Ne pas calculer ces valeurs attendues depuis un paquet non authentifié.

Depuis `support`, la vérification purement logicielle est :

```powershell
.\verify-stage4-package.ps1 -PackageDirectory $Unsigned -ExpectedCommit $S -ExpectedManifestSha256 $M -ExpectedPublisherSha256 $P
```

Elle n'exécute pas les PE, n'installe rien, ne crée aucune session et contrôle les quatre hashes, l'AMD64, les imports présents, les identités CI et les pins. La vérification des identités exécutables unsigned est exclusivement réservée au runner GitHub éphémère.

## Certificat : deux cas

Le pin historique réel est `200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a`, sujet `GPUbnb LOCAL PHYSICAL TEST ONLY 2026-09-21`, NotAfter observé `2026-10-20T22:23:47Z`. Ce certificat n'est pas un éditeur public.

**A — certificat encore valide.** Le préflight vérifie dans CurrentUser/My exactement le pin du build, la clé privée locale, l'EKU `1.3.6.1.5.5.7.3.3`, les dates avec au moins 24 heures restantes et une chaîne Windows déjà approuvée. Sans switch, cette commande reste en lecture seule :

```powershell
.\stage4-private-test-sign-copies.ps1 -UnsignedDirectory $Unsigned -ExpectedCommit $S -ExpectedManifestSha256 $M -ExpectedPublisherSha256 $P
```

Après autorisation explicite de signature seulement, reprendre la même commande avec `-SignCopiesForPrivateTest -OutputDirectory $SignedNewDirectory`. Le dossier de sortie doit être neuf et séparé. La source unsigned est conservée. Les quatre copies sont signées SHA-256 sans timestamp, contrôlées Authenticode Valid avec le pin exact, puis munies d'un nouveau manifeste et des hashes signés. Un échec conserve un marqueur `INCOMPLETE-DO-NOT-INSTALL.txt`. Ne jamais installer un tel dossier.

**B — certificat absent, expiré ou incompatible.** Ne pas tenter de signer avec un autre certificat simplement disponible. Après autorisation locale explicite, créer un certificat de code signing auto-signé de test, sujet contenant `LOCAL PHYSICAL TEST ONLY`, clé RSA au moins 3072 bits, SHA-256, EKU code signing, clé **NonExportable**, magasin CurrentUser/My, validité courte choisie pour la qualification. Aucun script de ce dossier ne crée de certificat ou de nouvelle confiance.

Relever ensuite le SHA-256 réel du certificat public, ses dates et l'EKU. Une approbation de confiance distincte doit viser cette empreinte exacte ; documenter les contextes qui vérifient les signatures (opérateur, service SYSTEM et worker locataire). Une confiance CurrentUser chez le fournisseur ne prouve pas la confiance dans les deux autres contextes. L'approbation machine éventuelle reste manuelle et expressément autorisée. Ne jamais exporter de PFX/clé privée, installer silencieusement une autorité ou modifier les protections Windows.

Reconstruire le paquet avec ce **nouveau pin public réel** via l'entrée `publisher_sha256` du workflow, ou un commit de consolidation ne modifiant que cette référence publique si le dispatch de branche est indisponible. Ordre : DLL média, worker avec pin média, helper avec pin worker, Agent du même SHA. Recontrôler toutes les identités et tous les hashes. Ne pas re-signer un worker/helper compilé avec l'ancien pin. La nouvelle copie privée reste interdite à la publication publique.

## Préflight machine, lecture seule

`stage4-pc1-inventory.ps1` collecte GPU/UUID/pilote, dépendances NVIDIA, IddCx, compte/SID, sessions WTS et console active, processus et services. Il exige la session console locataire active et exclusive comme le code natif ; il ne la crée pas. Il ne lance aucun probe NVENC/IddCx. `stage4-test-ready-audit.ps1` ajoute la vérification du paquet signé ET des quatre hashes réellement installés, avec `$SignedManifestHash` issu du rapport de signature. Avant toute installation, `-StagingOnly` vérifie uniquement le dossier préparé et ne doit pas être confondu avec une validation de l’installation :

```powershell
.\stage4-test-ready-audit.ps1 -PackageDirectory $Signed -ExpectedCommit $S -ExpectedManifestSha256 $SignedManifestHash -ExpectedPublisherSha256 $P
```

L’inventaire ne demande pas la clé privée dans le compte locataire ; seul le préflight de signature sous le compte détenteur de la clé l’exige. Le mode `qualification-preflight-pc-a.ps1 -Stage4Native` délègue au même audit et évite les anciens prérequis Docker. Le minimum contractuel est NVENC 13.0 / NVIDIA 570.00 ; les DLL système `nvcuda.dll` et `nvEncodeAPI64.dll` doivent exister. Aucun de ces constats ne prouve un encodage réel ni la compatibilité ABI du pilote IddCx installé : les deux restent réservés au test physique.

## Sauvegarde, installation et retour arrière — non exécutés

1. Après accord, lancer `stage4-backup-installed.ps1 -OutputDirectory $BackupNewDirectory -CreateBackup`. Il copie uniquement les quatre composants existants, relève leurs hashes avant/après copie, ACL SDDL et configuration déclarative des services. Il ne copie pas de secrets de configuration ni de clé de certificat. Conserver le SHA-256 de `backup.manifest.json` hors du dossier de sauvegarde. Tout marqueur INCOMPLETE interdit la restauration.
2. Avant une installation expressément autorisée, vérifier l'audit signé, les signatures en contexte service/locataire et la sauvegarde. Identifier l'Agent réellement utilisé et les deux chemins observés. L'utilisateur arrête proprement les seuls processus/services concernés après revue de cette correspondance. Ne pas redémarrer automatiquement un service Stopped. Confirmer l'absence de processus utilisant les quatre fichiers.
3. Remplacer uniquement les quatre fichiers de `C:\Program Files\GPUbnb` par les copies signées vérifiées, conserver leurs ACL, ne toucher ni à `GPUbnb Host`, ni aux pilotes, comptes, certificats ou fichiers de configuration. Recontrôler hashes signés, Authenticode, identités et préflight avant tout redémarrage manuellement autorisé. `verify-windows-release.ps1` est un smoke d'installation CI explicitement limité aux runners GitHub jetables ; ne pas l'utiliser sur PC1.
4. Si une étape échoue, ne pas lancer de test. Après autorisation de rollback, arrêter proprement le nouveau runtime, vérifier le hash externe du manifeste de sauvegarde puis chacun des quatre hashes, signatures et ACL sauvegardées. Restaurer uniquement ces fichiers et ACL, vérifier l'identité du service et reprendre seulement l'état de fonctionnement antérieurement approuvé. Ne pas modifier les données, restaurer un pilote ou redémarrer Windows.

**Limite temporelle du rollback :** des anciens binaires signés avec un certificat privé expiré sans timestamp peuvent être refusés par Windows. Vérifier leur validité à l'heure de la restauration ; une sauvegarde correcte n'annule pas l'expiration. Si le certificat doit changer, préparer et autoriser un ensemble de retour cohérent avec ses propres pins avant d'installer. Aucune sauvegarde ni restauration matérielle n'a été prétendue exécutée ici.
