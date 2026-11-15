# DOGE — candidat intégré de validation, 15 novembre 2026

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
