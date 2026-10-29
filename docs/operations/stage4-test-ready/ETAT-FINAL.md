# GPUbnb Stage 4 — état de préparation

La préparation logicielle est consolidée exclusivement dans [la PR #303](https://github.com/khemisset18/gpubnb/pull/303), branche `audit/ssj12007-consolidation`. Le paquet privé 4/4 source `447b8f3f931bd61d3131cff6f7204d7625b108b2` est rapporté comme signé et vérifié sur PC1, mais il n'est pas installé. Aucune fusion, installation PC1, réservation, qualification physique ou modification Render n'a été effectuée.

## Paquet et preuve attendue

Le workflow [Stage 4 complete Windows package](https://github.com/khemisset18/gpubnb/actions/workflows/stage4-complete-windows-package.yml) construit depuis **le SHA exact de la branche**, et non le commit de fusion implicite de GitHub :

1. Agent `0.6.6` frozen, commit embarqué contrôlé ;
2. DLL média AMD64, identité source exportée, ABI 2, NVENC 13.0 ;
3. worker AMD64, commit source et pin média réels embarqués ;
4. helper AMD64 `release-candidate`, commit, pin worker et protocoles contrôlés.

Un upload réussi exige quatre fichiers, leurs SHA-256, deux lecteurs PE indépendants (Python et PowerShell), les imports Windows, les identités exécutées uniquement sur le runner et l'absence de signatures sur la source unsigned. Le manifeste et `build-identities.json` sont vérifiés avant archivage. Aucun certificat ou secret de signature n'est utilisé par ce build.

L'archive s'appelle `stage4-unsigned-<SHA>.zip`. Le fichier `stage4-provenance.txt` joint donne **le SHA complet, le hash du manifeste, le hash du ZIP et le pin public**. Ces valeurs doivent être prises depuis le run du commit remis, jamais depuis une archive plus ancienne ou un manifeste non authentifié. Les artefacts expirent après 14 jours.

**Le paquet CI est NON SIGNÉ et NON INSTALLABLE.** Une signature de copies privées reste une opération locale soumise à autorisation. La chaîne publique `build-windows-native-release-candidate.ps1` continue à refuser les certificats `LOCAL PHYSICAL TEST ONLY`.

## Contrats et vérifications

Protocoles : worker 1, transport média interne 2, média navigateur 1, entrées navigateur 1, ABI DLL 2. En-têtes NVCodec : `e844e5b26f46bb77479f063029595293aa8f812d`, API NVENC 13.0. Minimum contractuel NVIDIA Windows : 570.00. Le pilote réel, le GPU, la capture WGC et l'encodeur NVENC restent à qualifier physiquement.

Les régressions couvrent notamment le hash/commit/pin erroné, le PE x86, les fichiers manquants, les imports falsifiés, l'identité Agent, la chaîne/EKU/expiration du certificat, l'authentification et le préflight, la révocation d'un flux déjà ouvert et le compteur de vidéo décodée. Le minuteur seul ne peut plus produire les 300 secondes ; coupure, changement d'époque, rejeu ou arrêt du décodage invalident la mesure.

Les résultats complets et artefacts à retenir sont ceux du **HEAD final**. Une CI verte d'un ancien SHA ou un workflow qui ne construit qu'un helper ne vaut pas preuve 4/4.

## Contrôle Render historique du 18 octobre 2026

Render : service `srv-dau86i2d0e5s73elmk10`, branche `qualification/stage3-windows-native-private-3c3e21e6`, autoDeploy `no`, Dockerfile `apps/api/Dockerfile`, santé `/health`. Déploiement actif `dep-db4j8gom7kps73c1u4p0`, SHA `6b655614d3b9c3fda7912742b539601ba22598f1`. `/health`, `/ready` et `/release` répondent ; WSS `/ws-health` renvoie exactement `gpubnb-ws-ok`.

Le frontend privé est servi à la même origine que l'API. Le frontend public Netlify annonce `16c13e0` et une autre gateway ; il n'est pas le parcours privé Stage 4. Le Stage 3 live renvoie encore du HTML au préflight Stage 4 absent : un HTTP 200 seul n'est donc jamais accepté.

PC1 : observations historiques fournies par l'utilisateur conservées dans `PC1-PREPARATION.md`. Aucun accès à son matériel, à ses sessions ou à ses magasins de certificats n'a été établi. Le certificat observé expire le **20 octobre 2026 à 22:23:47 UTC**, soit le 21 octobre à 00:23:47 Paris.

## Contrôle Render en lecture seule du 29 octobre 2026

Le relevé fourni dans cette session indique que le service `srv-dau86i2d0e5s73elmk10` a un déploiement actif au SHA `40e9ef5991ab13753130121fd321c60c84b4a297`, avec `autoDeploy=no`. La branche configurée dans les métadonnées reste `qualification/stage3-windows-native-private-3c3e21e6`. Il s'agit d'une observation du contrôle Render ; les réponses runtime de `/release`, `/config.js`, `/ready`, des pages et de la gateway n'ont pas été revalidées dans ce relevé.

Le paquet privé 4/4 signé et vérifié sur PC1, mais non installé, est au SHA `447b8f3f931bd61d3131cff6f7204d7625b108b2`. Il ne correspond donc pas au SHA du déploiement Render rapporté. **NO-GO pour PC1 → PC2** tant qu'un ensemble cohérent au même SHA n'est pas vérifié. Aucun déploiement, rollback ou changement de configuration Render n'a été effectué.

**Préparation logicielle, signature privée et qualification matérielle sont trois états distincts. Ne pas annoncer « PRÉPARATION TERMINÉE » tant que les critères restants de BLOCAGES.md ne sont pas satisfaits.**
