# DOGE — candidat intégré de validation, 15 novembre 2026

> État courant : finalisation du17 novembre ci-dessous. Les résultats du15 novembre restent historiques.

**Brouillon, qualification complète BLOCKED.** Aucun merge `main`/`dev`,
déploiement, activation, fonds réels ou opération Mainnet.

## Composition et conflits

L'ascendance Git confirme `#354 → #356 → #357 → #360 → #361`.
La base de revue reste #361 `cdb3e24759ed501b0e304dc15f58aaaedacb78f3`.
Le candidat ajoute #364, #362 et la correction Rust séparée #375, basée sur
#363. Cette dernière réutilise uniquement le backport GLib de #358 : aucune
ancienne dépendance Rand 0.7 ni son patch devenu inutile n'est réintroduit.

Les incréments #347 (test Borsh) et #348 (Trivy 0.76.2) n'étaient pas dans
l'ascendance DOGE. Leurs quatre commits ont été repris exactement :
`d9bad54a`, `cc3992f5`, `36a09eec`, `492a5caf`. Les versions npm/MinIO plus
récentes du candidat DOGE sont conservées ; les anciennes branches de sécurité
ne les rétrogradent pas. Les seuils, exclusions et gate Trivy restent intacts.
La version de scanner déjà corrigée par #348 est explicitement rétablie.

#343 a été examiné comme exécuteur JS alternatif antérieur. Il n'est pas un
ancêtre de #344 et n'est pas fusionné aveuglément : la chaîne active utilise
l'exécuteur Python natif de #344 et ses preuves ultérieures. #319 reste un
prototype de migration financière distinct ; ses résultats hôte ne qualifient
pas SBF, CPI ou le cycle de vie financier et il n'est pas intégré.

Le conflit #362/#364 concerne seulement `workspace-reliability.yml` : options,
exclusions des anciennes routes et deux nouveaux jobs ajoutés au même endroit.
Les deux jobs et leurs branches exactes sont conservés, avec exclusions
croisées `rbf-boundaries`/`recovery-consistency`. Les deux matrices couvrent
désormais les neuf modes et neuf branches, quatre événements et trois couples
d'identité de dépôt. Ces sous-cas sont des assertions dans deux tests ; ils ne
sont pas comptés comme des centaines de nouveaux tests natifs.

Les suites hors ligne D6/politique/signataire/récupération sont ajoutées au
workflow Foundation existant pour que le candidat combiné les exécute aussi
en CI. Aucun job blockchain ne devient automatique. Aucun routage natif vers
la branche d'intégration n'est ajouté ; ses anciennes limites restent fermées.

L'[inventaire](research/2026-11-15/integration/pr-inventory.json) conserve
états, HEAD, bases, fichiers et ascendance des 17 PR demandées ; l'[index CI](research/2026-11-15/integration/head-workflow-runs.json)
conserve les runs de leurs HEAD initiaux. Les nouveaux résultats gardent leurs
propres SHA : un run de parent n'est jamais attribué au candidat intégré.

## Résultats et limites de la campagne

| Vérification | Résultat observé | Périmètre |
| --- | --- | --- |
| #364, run [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) | 2 PASS / 0 FAIL / 0 SKIP natifs ; 111 PASS logiciels | SHA `e3fbbe6339d2eaecc6bd999daf2d9fe7fb6a1816`, Ubuntu 24.04, deux nœuds privés |
| Fondation Exchange locale | 277 PASS / 0 FAIL / 0 SKIP ; 52 fichiers syntaxe | Node 24.22.1, aucune nouvelle dépendance |
| Préparation D0 / D1 / D2 | 31 / 11 / 95 PASS, zéro FAIL/SKIP | Tests logiciels, pas de requalification native prétendue |
| D6 / politique / signataire / récupération | 45 / 14 / 12 / 30 PASS, zéro FAIL/SKIP | Suites intégrées ; includes matrices de routage et refus RPC |
| Gardes sources GLib / oracle récupération | 8 / 8 PASS, zéro FAIL/SKIP | Provenance, sélection Cargo et delta permis |
| Contrat Anchor hôte intégré | 11 PASS / 0 FAIL / 0 ignoré | 7 unitaires + 2 Borsh + 2 récupération publique ; aucun runtime SBF |
| Trivy 0.76.2 sur arbre combiné | FAIL : 2 MEDIUM, aucun Rand 0.7 | `Cargo.lock` Borsh 0.10.4 et GLib 0.18.5 ; gate inchangé |
| CI du candidat intégré | À vérifier au SHA publié | Aucun résultat d'un parent n'est promu en PASS du candidat |

Le premier essai local Cargo avait exécuté les 11 tests avec succès puis échoué
dans rustdoc car `/tmp` n'existe pas dans cet environnement. L'essai complet
avec `TMPDIR` privé existant passe, y compris la phase doc-tests (zéro test).
Aucun contrôle ni test n'a été supprimé. Les journaux avant/après sont conservés.

Le [dossier #364](DOGE_STABILIZATION_2026-11-15.md) et son reçu natif détaillent
le financement confirmé, rollback, refus puis restauration. Le garde natif
d'en-têtes refuse en premier ; le garde de financement est isolé en logiciel.
Les suites natives déjà positives ne sont pas relancées pour des changements
Rust hôte sans dépendance avec l'exécuteur Python DOGE. La correspondance des
sources exécutables est vérifiée séparément ; cela ne transforme pas le run
`e3fbbe6` en exécution native de tout l'arbre intégré.

## Sécurité Rust encore bloquante

Borsh 0.10.4 possède le correctif ZST publié et les deux tests #347 passent
sur le graphe Anchor réel. RustSec/OSV indiquent cette branche corrigée, tandis
que la plage machine GitHub consommée par le scanner reste contradictoire.
Le constat est documenté, sans altération locale d'avis ni exemption.

GLib conserve son identité 0.18.5 avec le fichier corrigé officiel et ses
121 fichiers de provenance/licence reconstruits. Le scanner le signale encore.
Tauri 2.12.5 publié exige GTK 0.18 ; la migration coordonnée Tauri/Wry/Tao
vers la pile publiée plus récente n'est pas disponible comme mise à jour
minimale qualifiée. Aucun remplacement incompatible ne simule une correction.

Rand 0.7 est absent du lock et des métadonnées effectivement résolues avec
la migration #363. Ses régressions de récupération publique restent nécessaires
sur chaque plateforme ; leur réussite ne démontre pas la sûreté SBF/CPI.
La [PR sécurité #375](https://github.com/khemisset18/gpubnb/pull/375) garde sa
revue et ses preuves propres. **Zéro alerte bloquante n'est pas atteint.**

## Qualification réelle D0–D9

| Phase | État | Acquis et exigence restante |
| --- | --- | --- |
| D0 | PASS limité conservé | Reconstruction source et archive D0 revalidée par le run natif ; route précompilée GPG distincte non qualifiée |
| D1 | PASS limité conservé | Identité/version/genesis Regtest privée recontrôlée ; aucun réseau public qualifié |
| D2 | BLOCKED | Profil legacy P2SH/CLTV et scénarios natifs documentés ; approbation cryptographique indépendante du profil exact manquante |
| D3 | BLOCKED | Limites CLTV/MTP/sighash et malleabilité testées historiquement ; dépendance D2 et profil final à approuver |
| D4 | BLOCKED | Claim/refund natifs et conservation préalable du remboursement ; protocole final, signataire et intégration financière non qualifiés |
| D5 | BLOCKED | 15 scénarios frais/pinning conservés ; #362 ajoute limites 100/101 et input non confirmé/confirmé ; acceptation des risques et plafond manquante |
| D6 | BLOCKED | AuxPoW/reorg/watchers conservés, rollback financement et reprise passent ; complétude adversariale et revue indépendante manquantes |
| D7 | BLOCKED | Récupération sans backend/clés, VM indépendantes et remplacement VM ; reboot sur place et indépendance de deux machines physiques NOT_TESTED |
| D8 | BLOCKED | Vérifications logicielles des termes/signatures ; matériel, firmware et termes réellement affichés NOT_TESTED |
| D9 | BLOCKED | Dossier et sources vérifiables ; deux alertes, audit externe, constats et décisions indépendantes non clos |

Les preuves historiques phase par phase restent dans le [dossier #361](DOGE_REVIEW_CANDIDATE_2026-11-12.md)
et les reçus RBF #362. CLTV marque un début de validité : il n'invente pas une
expiration blockchain des octets pré-signés. Le délai d'une nouvelle demande
de signature et l'épuisement d'une échelle finie de frais sont des refus
distincts déjà testés. Aucune garantie de frais arbitraires n'est revendiquée.

Interventions encore nécessaires : évaluation externe du profil/protocole,
réconciliation officielle de l'avis Borsh, migration GLib maintenue compatible,
qualification SBF/runtime/CPI si cette migration hôte est proposée à intégrer,
matériel signataire et deux machines physiques avec reboot réel. Toute fusion
dans `main`/`dev` et toute décision financière d'activation demandent l'accord
explicite du propriétaire ; aucun accord n'est supposé ici.


## Finalisation du17 novembre : correction minimale et dossier de passage

Base relue : PR #376, `b72fce17d75d0e75bcda36aab486d13c1c116871`.
Aucune PR DOGE postérieure pertinente ne remplace ce candidat ; les autres
travaux Stage4/Workspaces ne sont pas intégrés. La seule modification exécutable
est le renouvellement des deux SHA d’image MinIO dans le workflow S3 existant,
au commit `9a00e701ba124c3333d13d22dd2bb58e6817ff26`, arbre
`4a220b8b04e6b3bcc8c85a58d6ef43b0c4ef8a82`.
Les sources DOGE, Cargo, programmes financiers, interfaces, formats persistants,
politiques réseau/frais et backport GLib sont inchangés. Les règles de signature,
provenance, scan et tous les niveaux de sévérité sont conservés exactement.

Les [reçus vérifiables](research/2026-11-17/finalization/result.json),
[constats officiels](research/2026-11-17/finalization/external-resolution.json)
et [191 empreintes conservées](research/2026-11-17/finalization/preserved-sources.json)
fixent les identités. Ces documents postérieurs à l’exécution ne sont pas
présentés comme des fichiers déjà inclus dans les anciennes attestations #361.

### Défaut → preuve → correction → validation

| Défaut constaté | Correction ou décision | Résultat exact |
| --- | --- | --- |
| MinIO : `CVE-2026-97054` sur mc-r28 et `CVE-2026-128085` sur minio20261110 | Deux empreintes seulement : index68aab277… et amd64 7cf811b3… du registre officiel | [44164350361](https://github.com/khemisset18/gpubnb/actions/runs/44164350361) PASS : signature, attestation SPDX, scan toutes sévérités0constat et2tests S3 réels PASS/0FAIL/0SKIP |
| Borsh0.10.4 reste signalé | Correctif ZST publié présent ; archive officielle vérifiée au checksum du lock ; tests via le vrai Anchor inchangés | BLOCKED données amont : OSV/RustSec indiquent0.10.4 corrigé, les événements machine GitHub restent incohérents. Aucun avis modifié ni exemption |
| GLib0.18.5 reste signalé malgré le backport testé | Correctif source conservé. Même Tauri2.12.6 publié le16 novembre, Wry0.57.2 et Tao0.37.2 exigent encore GTK^0.18 | BLOCKED migration compatible publiée ; PR coordonnées Tauri16170/Wry1843/Tao1332 ouvertes. Pas de migration GUI majeure non qualifiée |
| Nouvelle alerte picomatch du17 novembre dans le desktop | Aucun changement de produit injustifié ; graphe actuel Vite7.3.7/tinyglobby/fdir vérifié, latest officiel4.0.7 lui aussi affecté | BLOCKED externe : `CVE-2026-112366`/`GHSA-fc5q-39xc-vjpf`, HIGH. Le scan filesystem compte désormais3constats réels et npm4entrées avec propagation transitive |

L’archive MinIO `14364652313` a été téléchargée et vérifiée SHA256
`412e80512243969413d224398b1cb1d8437873030dec1ff55d7bc9ab32fe8dd8`.
Le registre lie l’index à l’enfant amd64 ; la signature vérifiée en CI porte
sur l’index et le SBOM signé sur cet enfant. Les paquets réels sont
`mc0.20250813.083541-r29` et `minio0.20261116.001140-r0`.
Les logs attestent un put/get et une migration historique réels, un test chacun,
sans skip. Lire les signatures téléchargées localement ne remplace pas la
vérification cryptographique : celle-ci a bien été effectuée par cosign en CI.

La CI [44164350399](https://github.com/khemisset18/gpubnb/actions/runs/44164350399)
reste FAIL, et le préflight Windows
[44164350477](https://github.com/khemisset18/gpubnb/actions/runs/44164350477)
échoue à son audit npm picomatch. Le résultat positif S3 ne les annule pas.
L’avis picomatch a été actualisé le17 novembre ; aucun correctif compatible
publié n’a été trouvé dans le registre officiel. Une rétrogradation Vite proposée
par npm n’est pas appliquée pour contourner cette alerte. Aucune nouvelle
infrastructure, fonctionnalité, fausse version ou réduction de gate n’est ajoutée.

### Tests A / B / C et correspondance des preuves

| Classe | Périmètre | Traitement |
| --- | --- | --- |
| A : déjà validé et inchangé | DOGE natif, RBF, AuxPoW, récupération, frais, programmes et dépendances Rust/GLib | Sources comparées ; preuves et SHA historiques conservés, aucune relance manuelle |
| B : impacté | Image MinIO et contrôles de chaîne d’approvisionnement/S3 | Workflow existant exécuté sur la nouvelle révision : PASS |
| C : preuve insuffisante ou environnement absent | Approbation indépendante, complétude D6, matériel, deux hôtes physiques, reboot, SBF si applicable et audit D9 | BLOCKED/NOT_TESTED selon le cas ; procédures ci-dessous, aucun résultat inventé |

Les webhooks CI normaux du dépôt peuvent exécuter les jobs automatiques lors
d’une mise à jour de PR ; aucun bouton de relance des campagnes réussies n’est
utilisé. Aucun job blockchain n’est ajouté à push/PR. Les changements de matrice
d’intégration déjà vérifiés restent les seules différences des deux tests de
routage par rapport aux runs natifs ; leurs exécutables sont identiques.

Le run #364 [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110)
est confirmé SUCCESS :2cas PASS/0FAIL/0SKIP,0,98DOGE synthétique récupéré,
zéro nouvelle clé/signature, aucun envoi pendant le refus. Les exécutables de
récupération/D6/signataire/watcher correspondent ; seul le test de routage a
été étendu pour l’intégration. Le run RBF43484240757 garde ses mêmes sources
exécutables ; seul son test de routage diffère. L’ajout des deux SHA MinIO ne
modifie aucun de ces fichiers. Rand0.7 reste absent du lock actif.

**Portée D6 :** le critère publié demande une revue de complétude des hypothèses
adversariales ; il ne prescrit pas explicitement une isolation native de chaque
garde. Le refus direct sur financement est isolé en logiciel, le refus global
et la reprise le sont nativement. Aucun scénario natif supplémentaire n’est
nécessaire pour cette correction d’image. La décision de complétude reste
ouverte à l’évaluateur ; D6 n’est pas promu PASS.

### Passage de relais indépendant et physique

Le tableau D0–D9 ci-dessus reste applicable : D0/D1 PARTIAL au sens de leur
périmètre limité déjà PASS ; D2–D9 BLOCKED. Le dossier source #361 est historique,
son périmètre n’inclut pas les sources Rust racine. L’auditeur doit vérifier
séparément le commit intégré exact, son diff depuis b72fce17, les empreintes
ci-jointes, les sources vendues et les archives/attestations à leurs propres SHA.
Ne pas reconstruire ni réexécuter tout l’historique pour lire ces preuves.

1. **Revue indépendante D2–D6/D9 :** faire identifier un évaluateur externe,
   retenir son périmètre/version de profil, exiger l’examen P2SH/CLTV/sighash,
   malleabilité, claim/refund, délais et risque de frais/pinning. Relever chaque
   constat avec sévérité, propriétaire, correction et critère de clôture ;
   conserver l’acceptation indépendante des risques. Aucune revue n’est sollicitée
   ou déclarée effectuée par ce document.
2. **Deux machines physiques D7 :** avant un essai autorisé, relever identités
   matérielles distinctes, OS et boot IDs ; retenir hors de la première machine
   le seul paquet public et ses SHA indépendants. Réutiliser le protocole de
   transfert du job `independent-vm`, sur des hôtes physiques distincts, sans
   transférer clés, backend ou anciennes bases. Garder chaque exécuteur natif
   dans son namespace privé loopback et ses limites publiées. Le transfert de
   fichiers publics entre hôtes ne crée pas une nouvelle route P2P publique.
   Conserver observations, octets identiques, frais, destination et ancrage
   actif ; aucune acquisition de clé d’origine n’est permise.
3. **Reboot réel D7 :** sur le matériel privé autorisé et le profil Regtest
   figé, retenir paquet/journal avant interruption, arrêter puis redémarrer
   réellement l’hôte, relever le nouveau boot ID et récupérer depuis le paquet
   conservé hors de l’environnement perdu. Vérifier journal atomique, absence
   de nouvelle signature et absence de double diffusion après confirmation.
   Distinguer reboot, perte disque et panne électrique ; n’attribuer un PASS
   qu’à l’incident réellement effectué et documenté.
4. **Signataire matériel D8 :** obtenir matériel/firmware compatibles et
   autorisation d’essai avec uniquement une clé de test. Vérifier les termes
   réellement affichés : réseau, script/destination, montant, frais/plafond,
   lock et identité de requête. Refuser les mutations correspondantes avant
   signature. Retenir modèle, firmware, affichage et preuves publiques ; aucune
   compatibilité DOGE/CLTV matérielle n’est présumée.
5. **Solana si le chemin financier le retient :** qualifier SBF/runtime/CPI,
   propriétaires/signataires/comptes, relecture, rollback et migration. Les11tests
   hôte et les1636cas publics de récupération par wrapper ne remplacent pas cette
   qualification. L’autorité d’une activation financière reste distincte.
6. **Décision finale :** traiter les trois blocages de dépendances/données
   officiels, les constats de revue et les preuves physiques, puis consigner les
   décisions phase par phase. Aucun D9 PASS, merge main/dev, déploiement ou
   activation n’est autorisé par un résultat CI. Les20directions restent fermées.

État de passage : **MinIO corrigé et vérifié** ; **blocages externes Borsh,
GLib et picomatch documentés** ; **interventions humaines/matérielles requises**.
Aucun autre changement technique facultatif n’est entrepris pour ces blocages.

CI observée du commit exécutable9a00e701 : Foundation44164350392,
workspace44164350846, Solana récupération44164350314, desktop44164350313
et workspace Rust44164350424 SUCCESS. CI44164350399 et préflight44164350477
FAIL pour les alertes ci-dessus ; installateurs dev44164350260 CANCELLED,
sans transformer cette annulation en réussite. Aucune installation GUI/IPC
n’est revendiquée. Les éventuels runs du commit documentaire conservent
leurs propres identités et doivent être lus séparément.
