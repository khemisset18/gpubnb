# GPUbnb Stage 4 — manifeste Windows AMD64 non signé

GO préparation. NO-GO signature, installation, déploiement, fusion et qualification physique.

Source applicative exacte : `2b055992f7521505d0387dd4c876e36794fffd63` (#285 → #290 → #291). Les instructions de compilation sont sur une branche séparée, commit `8270e0cf0576fe468c01fb89649602e260512609` ; elles extraient explicitement la source à `2b055992f7521505d0387dd4c876e36794fffd63`. Aucun changement des PR existantes ni du runtime. Une seule surcouche de métadonnées Agent (`_build_info.py`, commit court attendu) est générée avant PyInstaller et ses deux empreintes sont enregistrées.

[Compilation CI réussie](https://github.com/khemisset18/gpubnb/actions/runs/38748425182), job numérique **116468085920**, workflow `.github/workflows/stage4-amd64-manifest.yml`, runner Windows standard AMD64. Archive **11980008547**, 22 343 892 octets, SHA-256 `113ed2b8644dd7796692bf894b5b5de4c9fd8402b772837935f9db7abe9d94a4`, expiration **29 octobre 2026, 14:08:44 UTC**. Téléchargement local et vérification indépendante de l’archive, de SHA256SUMS et des quatre PE effectués. Aucun binaire GPUbnb signé ; aucun helper ou DLL média exécuté/chargé. Seules les commandes de métadonnées worker et Agent ont été utilisées sur le runner isolé.

| Fichier | Version source / interface | Octets | SHA-256 non signé calculé |
| --- | --- | ---: | --- |
| gpubnb-windows-stream.exe | 0.1.0 | 465408 | `258f61515a8ca919e945957699283550e9f5fc0bed421dbaa82214ecc26fdb30` |
| gpubnb-windows-worker.exe | 0.1.0 | 181760 | `632bdfb73a0cd6c57e6655ca6c7813a55b4cf8560016860c4d38dead1694adc2` |
| GPUbnbWindowsMedia.dll | media-ABI-2 | 66560 | `2817cc7f7852d3d5001b57f386dd51073a4772b7b3f19ed9d81b83ee52e1808a` |
| gpubnb-agent.exe | 0.6.6 | 22259360 | `9de3ea6016048799675ac59709d4530eab669cf9ec257fb762eb26ce44dd6070` |

Les quatre fichiers sont PE32+ AMD64 (`Machine=0x8664`, `Magic=0x20b`), table de certificats vide, statut Authenticode **NotSigned**. Ils n’ont pas de FileVersion/ProductVersion incorporée : les versions Rust sont celles des Cargo.toml ; « media-ABI-2 » désigne l’interface et non une version produit. Agent 0.6.6 et son commit `2b055992f752` sont confirmés par le binaire gelé. Les cinq exports DLL attendus ont été lus directement dans le PE, sans charger la DLL. Le pin helper est aussi présent dans ses octets ; le worker annonce réellement le commit complet et le pin média attendus via son branchement `--build-policy --json`.

Compatibilité de contrat confirmée : protocole worker 1, média navigateur 1, entrées navigateur 1, ABI média 2 ; NVENC 13.0, en-tête fixé au commit `e844e5b26f46bb77479f063029595293aa8f812d` et SHA-256 `6cca5db41ba7a3120de9987f9ce5c54ac9089da97a7faa6a3a81fae62b9c4269`. Helper construit avec **physical-qualification**, worker sans option de mutation moniteur, pins publics inchangés `200208e0…2965a`. Il s’agit de composants de qualification privés non signés, pas d’un package public/release-candidate. Le constructeur de release standard n’a pas été utilisé ou affaibli : il exige notamment des signatures et interdit le certificat LOCAL PHYSICAL TEST ONLY.

Quatre artefacts au commit consolidé sont désormais construits et vérifiés ; aucun de ces quatre ne reste à reconstruire pour ce manifeste. Le précédent helper fe0b1cde a été retéléchargé et rehashé séparément (SHA-256 `6957c09b…bb905c`) ; il figure uniquement dans historicalArtifacts. Les quatre empreintes PC1 communiquées le 9 octobre sont uniquement un inventaire historique et ne désignent aucun nouveau binaire. Toute signature ultérieure modifiera les empreintes et imposera un nouveau manifeste.

La CI applicative de `2b055992…` est verte : 8 exécutions réussies, dont Authenticode, CodeQL, sécurité des workflows et préqualification. La [CI des instructions de construction](https://github.com/khemisset18/gpubnb/actions/runs/38748425136) est également réussie (6 jobs). Les identifiants et les états des PR restées intactes sont conservés dans `ci-evidence.json`.

Blocages restants :

1. **Signature :** les quatre binaires sont non signés. La protection et l’indépendance du poste éditeur restent non démontrées ; aucune clé n’est placée en CI ni sur PC2. Le certificat observé expire le **21 octobre 2026 à 00:23:47 Paris**. Aucune TSA n’est approuvée et aucune exception sans horodatage n’est activée. La clôture de l’étude privée reste le **20 octobre à 18 h Paris**, sans prolongation de validité.
2. **Worker installé :** son build-policy communiqué annonce `3cb18fb7…`, différent de `2b055992f7521505d0387dd4c876e36794fffd63`. Les pins correspondent, mais le script de compilation de qualification impose aussi la même source worker/helper ; cette exigence n’est pas contournée. Un remplacement du seul helper ne peut donc pas être approuvé sur la base de ce manifeste.
3. **Pilote IddCx :** la version installée observée 9.3.32.4 n’a pas de provenance binaire/INF/CAT ni d’empreintes collectées. Le template INF source porte 0.1.0.0, ce qui ne permet aucune attribution au package installé. Ni reconstruction nécessaire ni compatibilité installée ne peuvent être conclues. Conserver le pilote actuel ; aucune installation n’est préparée implicitement.
4. **Autres dépendances :** le pilote NVIDIA et NVENC n’ont pas été testés physiquement. Host tunnel n’est requis que si le serveur active ce chemin ; cette configuration et cet éventuel binaire ne sont pas inventoriés ici. Aucun logiciel GPUbnb, extension ou clé n’est nécessaire sur PC2.
5. **Qualification :** aucune capture/NVENC réelle, lease, entrée clavier/souris ou session de 300 secondes n’a été lancée. Les contrôles de sécurité, l’isolation, la suspension/reprise et la facturation restent intacts.

Vérification hors ligne : `python verify-manifest.py stage4-amd64-manifest.json --archive /chemin/stage4-unsigned-amd64-2b055992.zip`. Les sommes du présent dossier sont dans SHA256SUMS. Les copies textuelles de métadonnées sont normalisées en UTF-8/LF pour Git ; les métadonnées et sommes CI dans l’archive conservent leurs octets originaux. Cela constitue une preuve d’intégrité et de provenance CI, sans équivaloir à une release signée autorisée.
