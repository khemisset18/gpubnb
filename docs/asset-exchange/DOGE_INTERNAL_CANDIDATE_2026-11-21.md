# DOGE — candidat interne consolidé du 21 novembre 2026

> Mise à jour du 22 novembre : le transport externe, l'appairage et le journal
> logiciel sont désormais implémentés et testés. Voir le
> [nouveau candidat et ses preuves](DOGE_EXTERNAL_SIGNER_INTERNAL_2026-11-22.md).
> Le présent document conserve l'état historique du 21 ; D8 matériel reste bloqué.

**DOGE — VALIDATION TECHNIQUE INTERNE : BLOCKED.**
Le candidat logiciel et ses contrôles de sécurité passent. La qualification
complète reste bloquée par D2/D8 : le profil final exige une compatibilité de
signataire externe/matériel qui n'est pas implémentée ni démontrée sur appareil.
L'audit externe indépendant est **NON RÉALISÉ, hors mission** ; il n'a empêché
aucune correction ni aucun essai privé.

Ce bilan remplace les états de sécurité FAIL des rapports des 17–18 novembre.
Ces rapports et les échecs historiques restent conservés. Aucun ancien échec
n'est réétiqueté PASS.

## Identité et décision

- PR de travail : [#376](https://github.com/khemisset18/gpubnb/pull/376), toujours brouillon.
- Candidat exécutable publié : [17bb3e2e7774d97538305759e706de6f6a8da0d1](https://github.com/khemisset18/gpubnb/commit/17bb3e2e7774d97538305759e706de6f6a8da0d1).
- Arbre Git : `4fb75f3aab95895b8d841e240932cad083687fc6`.
- Révision de test de PR : `898ea2c01b96e56e8c375faf6d4c3323a2895b67`.
  Son arbre est strictement identique à celui du candidat, vérifié sur les objets
  Git ; il s'agit du merge virtuel de GitHub, sans fusion réelle dans main/dev.
- Le présent dossier est ajouté après les exécutions. Il n'est pas prétendu
  présent dans leur arbre ni dans l'archive source déjà construite.
- Aucun fonds réel, Mainnet, clé utilisateur, déploiement financier, merge main/dev
  ou activation des 20 directions. Registre DOGE toujours MARKETPLACE_ONLY,
  newTrades=false, automaticSettlement=false, settlement route null.

| Élément | Résultat | Portée vérifiable |
| --- | --- | --- |
| DOGE transactions | PASS | Constructions synthétiques et refus adversariaux du profil Regtest candidat |
| DOGE remboursement | PASS | Claim/refund natifs conservés ; reprise et refus après rollback vérifiés |
| DOGE récupération | PASS | Cœur actuel : 40 tests logiciels ; nouveaux contrôles natifs ; VM historiques attribuées à leur propre source |
| DOGE RBF / frais | PASS | Matrices bornées, 100/101 remplacements, pinning et plafond ; refus sûr au-delà du plafond |
| DOGE AuxPoW | PASS | Matrices natives et 12 sorties d'erreur explicites revues ; aucune exhaustivité universelle revendiquée |
| Sécurité Rust | PASS | Borsh 1.8.0, GLib 0.22.11 ; Trivy strict zéro constat |
| Sécurité Desktop | PASS | Audits, tests, Tauri natif, GUI Linux réelle, installateurs trois OS |
| CI complète | PASS |12 workflows terminés SUCCESS : 35 jobs réussis, 5 jobs natifs manuels non sélectionnés |
| Qualification interne | BLOCKED | D2/D8 complets exigent encore le profil/signataire matériel démontré |
| Audit indépendant | NON RÉALISÉ | Hors mission ; aucun test interne ne remplace cette exigence de D9 |

Les PASS fonctionnels ci-dessus concernent les essais décrits ; ils n'autorisent
ni le profil financier définitif ni le lancement d'échanges.

## Corrections et sources officielles

| Constat | Correction effective | Validation |
| --- | --- | --- |
| Borsh — GHSA-fjx5-qpf4-xjf2 | Migration compatible vers Anchor 1.2.2 et Borsh 1.8.0 ; aucun parent Borsh 0.10 restant | Source financière inchangée ; 38 reçus ABI identiques ; 17 tests hôte sur chacun des 3 OS ; 12 cas SBF |
| GLib — GHSA-wrw7-89jp-8q8g | Migration coordonnée : 15 crates, 7 dépôts officiels, révisions Git immuables ; GTK 0.19.0/GLib 0.22.11 | Provenance, 2080 comparaisons en release, compilation Tauri réelle, GUI/IPC et installateurs 3 OS |
| Picomatch — GHSA-fc5q-39xc-vjpf | Retrait officiel de l'avis puis synchronisation de la base officielle ; pas de changement opportuniste du paquet | npm et Trivy stricts zéro constat ; aucune version corrigée inventée |
| Effect — GHSA-7589-6fvf-x4pw | Effect 3.22.1 officiel via override limité à @prisma/config 6.19.3, aux deux racines npm | Régression ReDoS, Unicode/configuration Prisma ; génération/build ; API réelle 706 PASS |

Borsh : [RustSec](https://rustsec.org/advisories/RUSTSEC-2023-0033.html)
reconnaît la correction ^0.10.4, comme le constat OSV conservé. La page humaine
[GitHub](https://github.com/advisories/GHSA-fjx5-qpf4-xjf2) borne les versions
affectées à 0.10.3, mais ses événements machine ne mentionnent que 1.0.0-alpha.1.
La migration élimine ce désaccord du graphe actif sans exemption. Les protections
contre les ZST restent exercées ; le changement officiel de catégorie d'erreur
InvalidInput vers InvalidData n'autorise aucune désérialisation d'élément ZST.

GLib : l'avis officiel corrige la famille à partir de
[0.20.0](https://github.com/advisories/GHSA-wrw7-89jp-8q8g).
Le manifeste publié [Tauri 2.12.7](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.7/crates/tauri/Cargo.toml)
exige encore GTK 0.18 ; la [migration coordonnée officielle 16170](https://github.com/tauri-apps/tauri/pull/16170)
est encore ouverte/brouillon lors du contrôle du 21 novembre. Le candidat utilise
ses sources épinglées et testées ; ce n'est pas une certification de release
stable amont. Le correctif source historique est conservé et son intégrité
reconstruite. L'exemple public Editkin a informé la méthode ; seuls les essais
GPUbnb propres constituent nos preuves.

Picomatch : [avis retiré](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
le 18 novembre 2026 à 15: 38: 56 UTC, motif officiel corrigé le 19 novembre :
ce constat n'est pas considéré comme un problème de sécurité. L'avis ne publie
aucune version corrigée. Aucun prototype de correctif non publié n'est adopté.

Effect : [avis officiel](https://github.com/advisories/GHSA-7589-6fvf-x4pw),
[correctif 3cc3c6e1](https://github.com/Effect-TS/effect/commit/3cc3c6e1a64cbdc360e9d28e44f3ec3ce0ece6e3).
Prisma/client/engines/config restent en 6.19.3. Aucun changement de schéma métier.

Deux corrections DOGE déjà intégrées ferment les fenêtres de cohérence RPC :
le readback ne peut annoncer un nœud synchronisé avec des en-têtes en avance ;
le tip lu avant rebroadcast doit égaler celui ayant autorisé l'observation.
Les nouveaux cas échouaient avant et passent après. Ils ajoutent des refus avant
diffusion, sans modifier scripts financiers, transactions ni budgets RPC.
Le daemon conserve sa propre validation ; ces contrôles ne promettent pas
l'atomicité universelle de plusieurs RPC.

Une défaillance API réelle a aussi été reproduite : trois transactions
Serializable contournaient la reprise bornée existante, et échouaient sur
P2034/P2028. Les trois callbacks DB réutilisent maintenant runBookingTransaction ;
authentification Redis et consommations de challenge restent hors reprise.
Trois entrées obsolètes sont supprimées de l'allowlist, sans l'élargir.
Régression : 2échecs avant, 15 PASS après avec la suite du helper ; intégration
PostgreSQL/Redis réelle réussie dans la CI finale.

Le scanner, ses seuils, les exclusions préexistantes, les sources de sa base et
ses contrôles obligatoires ne sont pas affaiblis. Aucun Rand 0.7 réintroduit.
MinIO/S3 et les protections cryptographiques existantes sont conservés.

## CI du candidat exact

| Exécution GitHub Actions | Résultat |
| --- | --- |
| [CI 44952572246](https://github.com/khemisset18/gpubnb/actions/runs/44952572246) | SUCCESS : sécurité, contrat, production-gates, npm, API, Agent |
| [Foundation 44952572254](https://github.com/khemisset18/gpubnb/actions/runs/44952572254) | SUCCESS : régressions Core, DOGE et routes manuelles |
| [Fiabilité 44952572272](https://github.com/khemisset18/gpubnb/actions/runs/44952572272) | SUCCESS : 10 passes API, 25 passes Agent ; 5 jobs DOGE manuels SKIP |
| [MinIO/S3 44952572307](https://github.com/khemisset18/gpubnb/actions/runs/44952572307) | SUCCESS : les 2 cas S3 réels passent, aucun skip sélectionné |
| [API mining 44952572281](https://github.com/khemisset18/gpubnb/actions/runs/44952572281) | SUCCESS |
| [Deployment readiness 44952572257](https://github.com/khemisset18/gpubnb/actions/runs/44952572257) | SUCCESS : validations/builds seulement, aucun déploiement |
| [Desktop 44952572290](https://github.com/khemisset18/gpubnb/actions/runs/44952572290) | SUCCESS : 6 jobs, dont Rust3 OS et sécurité |
| [Solana récupération 44952572205](https://github.com/khemisset18/gpubnb/actions/runs/44952572205) | SUCCESS : 3 OS |
| [Rust/GTK 44952572232](https://github.com/khemisset18/gpubnb/actions/runs/44952572232) | SUCCESS : provenance, régressions optimisées, Anchor, Tauri natif |
| [Anchor SDK 44952572222](https://github.com/khemisset18/gpubnb/actions/runs/44952572222) | SUCCESS : 3 OS hôte et exécution privée des 2 ELF SBF |
| [Installateurs 44952572210](https://github.com/khemisset18/gpubnb/actions/runs/44952572210) | SUCCESS : Linux x64, Windows x64, macOS ARM64 ; développement non signé |
| [Windows complet 44952572199](https://github.com/khemisset18/gpubnb/actions/runs/44952572199) | SUCCESS : installateur, agent autonome et tunnel embarqués |

API : 708 tests recensés, 706 PASS, 0 FAIL, 2 SKIP. Ces 2 cas nécessitent un serveur S3
et passent séparément avec MinIO dans 44952572307 ; ils ne sont pas comptés PASS
dans le job API. PostgreSQL et Redis sont réellement prêts avant la suite.
Les 5 jobs natifs manuels SKIP de la fiabilité ne sont pas présentés comme exécutés.

Les artefacts ont été téléchargés : SHA256 des ZIP et des fichiers, CRC,
manifestes internes, trois locks identiques et 15pins officiels vérifiés.
Métadonnées Cargo : 564 paquets sur chacun des 3 OS, Borsh 1.8.0/GLib 0.22.11,
aucun Rand 0.7 ni libsecp256k1. Les installateurs sont des builds de développement
non signés ; leur réussite ne constitue pas une publication de production.

La GUI réelle réutilise [44891701749](https://github.com/khemisset18/gpubnb/actions/runs/44891701749),
composant GTK `c7f32c1a2922c217e02d1cb4d91f005af89acdf1` :
5 contrôles PASS sur tauri://localhost, refus IPC inconnu, host_status et rendu
du statut, capture native conservée. Les graphes effectivement compilés du
Desktop sont identiques dans le candidat consolidé ; cet essai GUI inchangé
n'a pas été répété. Aucun GPU disponible sur ce runner : le refus de readiness
est attendu, sans revendication de location matérielle qualifiée.

La compatibilité Anchor comprend38 reçus ABI byte-identiques, 1636 vecteurs
publics de récupération, 17 tests hôte par OS, 6 cas exécutés sur l'ancien ELF
et 6sur le candidat ; 11instructions et 15 CPI System par exécution.
Signatures, blockhash, rejeu et états de comptes sont réellement vérifiés.
L'extension optionnelle de précompiles, absente des 11instructions exercées,
n'est pas ajoutée au nouveau harnais et reste NON QUALIFIÉE. Aucune vérification
de signature/blockhash n'a été désactivée. Aucun consensus réseau Solana ni
déploiement n'est revendiqué.

## D0–D9 : preuves acquises et conditions restantes

Le profil reste DOGE-1.14.9-LEGACY-P2SH-CLTV-REGTEST-CANDIDATE-1,
CANDIDATE_NOT_APPROVED. Un PASS de cas isolés ne clôt pas les prérequis de phase.

| Critère | Essais internes | État de phase complète et preuve |
| --- | --- | --- |
| D0 — outils | PASS limité | Route source : [40866305437](https://github.com/khemisset18/gpubnb/actions/runs/40866305437), exécution99724d5b66b9475dcb96f6c471c75ce01ed60f9a ; archive 4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8 ; précompilé GPG distinct non choisi |
| D1 — identité | PASS limité | [40892872892](https://github.com/khemisset18/gpubnb/actions/runs/40892872892), 1636df354d4fafd2cc2d9ab8595f4dca52582ad7 ; réseau/genesis/isolement recontrôlés dans chaque nouveau laboratoire |
| D2 — profil | PASS des cas mesurés | BLOCKED pour le gel : 32 cas natifs/24 prédicats, [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068), 5d5d6fc9825e9b24bea061570982ad77d727a25c ; politique [43005573333](https://github.com/khemisset18/gpubnb/actions/runs/43005573333), 9fb396839eefc8cdc47028d6f8e0aecf516752cf ; §7 exige encore compatibilité externe/matérielle avant approbation |
| D3 — timelocks/signatures | PASS borné | BLOCKED pour clôture finale par D2 ; [43060202035](https://github.com/khemisset18/gpubnb/actions/runs/43060202035), 66afc5bf1fdff1666280a74c8f45604a14ca89b8 : 2357 assertions, 4 cas sélectionnés ; CLTV1350/1351, hauteur/temps/MTP, 6sighashes et malléabilité ; 249 cas non sélectionnés non qualifiés |
| D4 — financement/claim/refund | PASS borné | BLOCKED pour clôture finale par D2 ; [43052066409](https://github.com/khemisset18/gpubnb/actions/runs/43052066409), 4a253fc15503e9e9a164ce96375f1729c915c020 ; compléments natifs44400212431 et 44652078768 ci-dessous |
| D5 — RBF/frais/pinning | PASS borné | BLOCKED pour clôture finale du profil ; [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770), 06c96c6284d1c33a771c41d1f9b6ffe533c946bf : 15 cas ; reprise ciblée [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757),fc2d34c58e0696e48c4490cf758070d861058fc8 : 73assertions100/101 ; ancien run43326020199 FAIL conservé |
| D6 — AuxPoW/reorg | PASS borné | BLOCKED pour clôture finale par profil ; [43074060943](https://github.com/khemisset18/gpubnb/actions/runs/43074060943), 6ebdaef913e6b102c0835fbab261da9ac4cc11b6 et [43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839),c7adde84149250c3a972e570b5df4911b20778ee : 12 propriétés supplémentaires, 16 négatifs/4 positifs ; rollback/incertitude/reconvergence conservés |
| D7 — récupération/crash | PASS des essais logiciels et natifs décrits | BLOCKED pour clôture finale par prérequis du profil ; 40 tests du cœur actuel, 17 interruptions SIGKILL ; [43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236), 6307538265aef8273447891f445a28531043d1b5 : 15 incidents/reprise sur VM ; anciens runtime/SHA distingués ; nouvelles preuves du cœur actuel ci-dessous |
| D8 — signataires | PASS logiciel16 tests | BLOCKED : transport/adaptateur/appairage NOT_IMPLEMENTED ; appareil/firmware/affichage/déconnexion NOT_TESTED ; procédure reproductible préparée |
| D9 — dossier/revue | Dossier interne et contrôles logiciels PASS dans leur portée | BLOCKED pour D9 complet par D0–D8 requis et revue indépendante ; audit externe NON RÉALISÉ hors mission, activation séparée non autorisée |

Le plafond fini de remboursements présignés est une condition explicite :
au-dessus du plafond, le refus est le comportement de sécurité attendu.
Aucune garantie de remboursement à frais arbitraires n'est inventée comme gate.
L'absence d'un fuzzing exhaustif ou de coupures secteur n'est pas ajoutée
artificiellement aux critères. D7 n'exige pas une coupure d'alimentation physique ;
les H7.* préparés le 20 novembre sont des essais supplémentaires non exécutés.

Les preuves formelles historiques de sécurité/liveness bornées sont conservées :
modèles/runners/configurations identiques à bef36cb9f45bb130b0533d9aea39f6573d894255,
vérifié par diff vide. Voir le [README formel](formal/README.md) et la
[correspondance modèle/code du candidat](research/2026-11-21/final-candidate/model-code-traceability.md).
Le modèle borné, ses hypothèses de progression et cette correspondance manuelle
ne prouvent pas un raffinement formel complet de l'implémentation ni une
liveness face à une panne réseau/chaîne permanente. G4 complet reste distinct.

## Deux preuves natives du cœur actuel

- [44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431) :
 2 cas sélectionnés PASS, 0 FAIL/0 SKIP sélectionné ; 175 appels client =
 171 reçus daemons118A/53 B +4 tentatives de disponibilité, 2 blocs, 6 invocations
 autonomes ; 0clé/0signature nouvelle ; 0diffusion pendant refus ; mêmes octets
 confirmés sur 2 nœuds, 0, 98 DOGE synthétique récupéré.
 Dossier : [integrated-qa](research/2026-11-20/integrated-qa/README.md).
- Nouveau contrôle non redondant [44652078768](https://github.com/khemisset18/gpubnb/actions/runs/44652078768) :
 harnais [555419d73ff0430f862a7836ef11e129e273b980](https://github.com/khemisset18/gpubnb/commit/555419d73ff0430f862a7836ef11e129e273b980),
 exécution [3aea3b7f5cfb499ae9754f04e24223ce11d3ae02](https://github.com/khemisset18/gpubnb/commit/3aea3b7f5cfb499ae9754f04e24223ce11d3ae02).
 Financement non confirmé, headers=blocks1355 : refus direct avant send du
 runtime autonome.53 appels client =49reçus37A/12 B +4 readiness, 0 bloc,
 2 invocations autonomes, 0clé/0signature. Les 2anciens cas natifs non sélectionnés
 n'ont pas été répétés.
 Dossier : [funding-unconfirmed](research/2026-11-21/funding-unconfirmed/README.md).

Le nouveau vérificateur d'artefact a aussi été corrigé : l'absence des deux txid
ne doit jamais réussir par égalité de valeurs undefined. Reproduction avant/après
et 14mutations négatives conservées. Les compteurs client/daemon restent distincts.

## Empreintes et paquet D9

| Objet | SHA256 |
| --- | --- |
| Cœur DOGE actuel | ab6221fb209ac05316a37d9b17beb26ad45317b125dd0c1866abf3d3240a1c8b |
| Zipapp autonome | 690a26f739217fb19701b5dc5ee3c6abac747b28e3ebaf7014c29897806c3f73 |
| Source financière GPU escrow inchangée | ffaa27c11cc7873282a85b05f2cfc0bcd8a6b8baba3154575596225b5faa8b41 |
| Graphe financier182 paquets | 6b616dcf73618ebd71e849ecdad3cb974e798ac1aa4a22bc9977b451ee3644e9 |
| Cargo.lock intégré | 6919a9b221c32ff7a1a243659fe0eb73c843ff6fd2f9e0512ab17ed0bb448ecf |
| ELF SBF candidat | 123e187d9254a8ad60811a7dac2acb9b1f0a84d1e9a7edce47cd1c8a9125b125 |
| Rapport Trivy final | f7ce3136a91c335bc930dc701c2921e962621bcb76e8afc89427682b2922cf81 |
| Archive ZIP native44652078768 | 2bf772edc65124f50c09724b64ba27bc23448e2903ee592f293027c446b1e413 |
| Archive source locale reproductible17bb | 0cc2947df3c311329725c3d78e42be0bb30709965c63cea0309a082fa4246ded |
| SBOM source SPDX2.3 | 90ed2943e0b58e85004ca29d94da1fe11c898e674eac6950fdccbe4890b3aec7 |

L'archive source a été construite deux fois, identique octet pour octet,
puis vérifiée : 721 fichiers dans le périmètre asset-exchange, sa documentation,
ses workflows asset-exchange et workspace-reliability. Ce n'est pas une archive
intégrale du Desktop/SDK ; ceux-ci sont liés par l'arbre Git, les pins et leurs
artefacts propres. Aucune nouvelle attestation GitHub/OIDC n'est revendiquée.
L'ancienne archive 602 fichiers signée de43316922937 reste liée à son ancien SHA.

Les [reçus machines et SHA256SUMS](research/2026-11-21/final-candidate/README.md)
conservent les résultats CI, audits, logs utiles, empreintes par artefact,
rapports SBF/hôte, provenance des recherches et paquet source.
Les archives natives/installateurs restent attachées aux exécutions citées avec
leur durée de rétention GitHub ; leurs sommes et reçus sont commis durablement.

## Risques résiduels et suite exacte

| Condition restante | Classification | Travail restant |
| --- | --- | --- |
| Adaptateur/transport/appairage de signataire matériel | Techniquement développable ; dépend de la décision explicite de périmètre | Nouvelle intégration produit absente, exclue de cette mission de corrections ; choisir modèle/profil avant développement |
| Essais D8 réels | Matériel indisponible et contrôle humain sur appareil | Modèle/firmware identifiés, appareil de test, consentement opérateur, WYSIWYS, mutations et déconnexions ; procédure H8.1–H8.5 prête |
| Gel du profil D2 et clôture des phases dépendantes | Décision explicite après preuves requises | Ne pas approuver un profil dont la compatibilité externe/matérielle manque ; aucune modification de critère |
| Migration stable Tauri/GTK | Correction coordonnée officielle non publiée | Candidat Git officiel testé disponible maintenant ; adoption d'une release stable future à valider par les seuls tests affectés |
| Assurance formelle complète G4 | Revue/assurance supplémentaire, distincte des essais bornés acquis | Correspondance manuelle fournie ; pas de preuve mécanisée complète ni de promesse de liveness universelle |
| Audit indépendant D9 | Contrôle humain externe, hors mission | NON RÉALISÉ ; n'est pas remplacé par nos tests et ne retarde pas le laboratoire privé |
| Merge, activation, déploiement financier | Décision explicite utilisateur | Non exécutés ; 20 directions et settlement restent désactivés |

Aucun échec logiciel reproductible connu ne subsiste dans les vérifications
exécutées sur 17bb. Cette observation est bornée aux preuves consignées.
Une décision PASS globale serait prématurée tant que D2/D8 requis manquent.
Le candidat interne corrigé est conservé pour cette suite précise.
