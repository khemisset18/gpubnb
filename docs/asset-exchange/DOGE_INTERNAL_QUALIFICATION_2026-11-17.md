# DOGE — qualification technique interne du 17 novembre 2026

> Instantané historique. Voir le [bilan du 21 novembre](DOGE_INTERNAL_CANDIDATE_2026-11-21.md)
> pour les corrections publiées, la sécurité PASS et les conditions D2/D8 restantes.

**DOGE — VALIDATION TECHNIQUE INTERNE : FAIL.** Les contrôles de sécurité
obligatoires ont été exécutés et échouent encore sur trois dépendances.
Les observations DOGE réussies ci-dessous restent valides dans leur périmètre
Regtest privé. Elles ne constituent pas une qualification financière complète.

Cette mission réalise notre validation interne. Aucun auditeur externe n'est
recherché ou attendu pour poursuivre les corrections et les essais privés.
L'exigence d'audit indépendant de D9 reste **NON RÉALISÉE, hors mission** ;
ce rapport ne la remplace pas. L'échec de la décision interne repose sur les
contrôles de sécurité, indépendamment de l'absence d'audit externe.

## Candidat et changements

PR de travail : [#376](https://github.com/khemisset18/gpubnb/pull/376), toujours
ouverte et en brouillon, base `cdb3e24759ed501b0e304dc15f58aaaedacb78f3`.
Référence relue : `39189e689c32e8f09ad7e11b899f5d1266f86b26`.
Révision de code finale de cette campagne :
[`8b39c405fa51dd4ce516778b4d5d69d84d094d5f`](https://github.com/khemisset18/gpubnb/commit/8b39c405fa51dd4ce516778b4d5d69d84d094d5f),
arbre `9d1296f7c74fa032b18a9b15160da7df6bae7bbb` avant ajout de ce dossier.
Elle ajoute seulement la correction des métadonnées décrite ci-dessous au
précédent candidat [`30b7b65d…`](https://github.com/khemisset18/gpubnb/commit/30b7b65d51445f698b7d363c795b53af8cf2fc23),
arbre `f4a13061f70fd5448b9de4eb69eadd3ce84dd5b3`.
Le commit qui ajoute ce rapport ne change que la documentation et les reçus.

Un défaut CI réellement reproductible a été corrigé : le job d'installateur
macOS demandait `macos-14`, retiré par GitHub le 2 novembre. Le job
[`134332212908`](https://github.com/khemisset18/gpubnb/actions/runs/44166034756/job/134332212908)
n'avait ni runner ni étape exécutée ; son annotation exacte était
`The configuration 'macos-14-arm64-us-default' is not supported`.
La [retraite officielle](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/)
confirme la cause. Un premier essai sur `macos-15`
([commit `0c0f83c`](https://github.com/khemisset18/gpubnb/commit/0c0f83caab6a78e575a4e4f4bf00824ccf7ea6a1))
est resté sans allocation. Le candidat utilise maintenant `macos-latest`, déjà
utilisé avec succès par le workflow Solana du dépôt. La matrice, les architectures,
les étapes, les seuils et les contrôles de l'installateur sont identiques.

Le job macOS du premier essai sur ce pool
[`134362564799`](https://github.com/khemisset18/gpubnb/actions/runs/44174624762/job/134362564799)
a terminé **CANCELLED, aucun runner alloué, aucune étape exécutée**. GitHub précise
`The job was not acquired by Runner of type hosted even after multiple attempts`
et signale une capacité insuffisante des runners macOS arm64. Ce résultat reste
conservé. Le nouveau run[44178051127](https://github.com/khemisset18/gpubnb/actions/runs/44178051127)
a obtenu un runner et termine **SUCCESS sur Windows, Linux et macOS arm64**.

Une seconde anomalie réelle concerne les preuves des installateurs : les deux
archives Windows/Linux produisaient `CARGO-METADATA.json` sans `desktop-runtime`,
alors que `tauri:build` active cette option. Les graphes ne contenaient donc aucun
paquet Tauri/GLib. Le commit8b39c405 ajoute uniquement
`--features gpubnb-host-desktop/desktop-runtime` à la collecte, avec `--locked`
conservé. La [documentation Cargo](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html#feature-selection)
confirme la sélection des fonctionnalités de membres par cette syntaxe. Il ne
modifie ni les octets source du binaire ni le lock. Les trois nouvelles archives
ont été téléchargées et vérifiées : fonctionnalités `default,desktop-runtime`
actives, Tauri2.11.5 et vrai vendor GLib0.18.5 présents, aucun Rand0.7 ou
libsecp256k1. Ces métadonnées couvrent le workspace et toutes les plateformes ;
elles ne sont pas présentées comme un SBOM reconstruit du seul binaire livré.

Les 191 empreintes critiques du [manifeste conservé](research/2026-11-17/finalization/preserved-sources.json)
ont été revérifiées. Aucun changement DOGE, transaction, signature, protocole,
backport GLib, graphe Cargo/npm ou réglage MinIO/S3 n'est apporté ici.
Rand 0.7 reste absent. Aucune campagne native DOGE déjà réussie n'a été relancée.
Les webhooks CI normaux du dépôt ont exécuté leurs contrôles existants.

## Résultats intégrés au même candidat

| Élément demandé | Résultat | Preuve et portée |
| --- | --- | --- |
| DOGE transactions | PASS | Transactions synthétiques du profil privé ; [D2 natif](https://github.com/khemisset18/gpubnb/actions/runs/42875442068), [D3](https://github.com/khemisset18/gpubnb/actions/runs/43060202035) |
| DOGE remboursement | PASS | Refund conservé avant lock ; frais/pinning [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770), rollback/reprise [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) |
| DOGE récupération | PASS | VM et remplacement [43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236), puis régression ciblée du cœur actuel [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) ; limites physiques distinctes |
| DOGE RBF / frais | PASS | 15 scénarios bornés [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770), limite 100/101 [43326020199](https://github.com/khemisset18/gpubnb/actions/runs/43326020199), reprise ciblée entrée confirmée/non confirmée [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757) |
| DOGE AuxPoW | PASS | [8 contrôles](https://github.com/khemisset18/gpubnb/actions/runs/43074060943) + [12 contrôles](https://github.com/khemisset18/gpubnb/actions/runs/43311713839), revue interne des 12 sorties d'erreur explicites ; pas de revendication de fuzzing exhaustif |
| Sécurité Rust | FAIL | [Scan strict 44178051033](https://github.com/khemisset18/gpubnb/actions/runs/44178051033) : Borsh et GLib ; comportements corrigés testés séparément |
| Sécurité Desktop | FAIL | Même scan et audit npm : picomatch HIGH ; quatre entrées npm par propagation, pas quatre causes distinctes |
| CI complète | FAIL | Deux jobs sécurité de la CI et préflight Windows échouent ; installateurs 3OS PASS |
| Qualification interne | FAIL | Les gates sécurité obligatoires ne sont pas satisfaites |

Les PASS DOGE sont des observations du profil figé
`DOGE-1.14.9-LEGACY-P2SH-CLTV-REGTEST-CANDIDATE-1`, pas des PASS globaux D2–D9.
Les refus attendus comptent comme réussites seulement lorsque la mesure vérifie
le refus exact et l'absence d'action financière indue.

| Workflow au commit `8b39c405…` | Résultat observé |
| --- | --- |
| [CI 44178051033](https://github.com/khemisset18/gpubnb/actions/runs/44178051033) | FAIL sécurité ; Agent, API, contrat hôte, production-gates et dependency-audit PASS |
| [Rust workspace 44178051028](https://github.com/khemisset18/gpubnb/actions/runs/44178051028) | SUCCESS : provenance, graphe, régressions, Anchor hôte et compilation Tauri native Linux |
| [Solana recovery 44178050932](https://github.com/khemisset18/gpubnb/actions/runs/44178050932) | Windows/Linux SUCCESS, macOS QUEUED au relevé, aucun PASS global ; dernière exécution achevée [44174625058](https://github.com/khemisset18/gpubnb/actions/runs/44174625058) SUCCESS Linux/Windows/macOS, mêmes sources cryptographiques |
| [Host desktop 44178050930](https://github.com/khemisset18/gpubnb/actions/runs/44178050930) | SUCCESS |
| [Foundation 44178051125](https://github.com/khemisset18/gpubnb/actions/runs/44178051125) | SUCCESS : suites logicielles DOGE/Exchange inchangées, zéro échec/skip |
| [Workspace 44178051146](https://github.com/khemisset18/gpubnb/actions/runs/44178051146) | SUCCESS |
| [MinIO/S3 44178051102](https://github.com/khemisset18/gpubnb/actions/runs/44178051102) | SUCCESS ; correctif d'image, provenance et tests réels conservés |
| [Windows preflight 44178051104](https://github.com/khemisset18/gpubnb/actions/runs/44178051104) | FAIL sur audit npm picomatch |
| [Installateurs 44178051127](https://github.com/khemisset18/gpubnb/actions/runs/44178051127) | SUCCESS sur Windows/Linux/macOS arm64 ; 506/506/500 tests natifs respectivement, zéro échec/ignoré ; métadonnées corrigées vérifiées |

Le workflow d'installateur audite déjà les dépendances de production. Sa réussite
Windows/Linux ne neutralise pas l'échec du contrôle Desktop qui inclut les outils
de construction. Les deux contrôles ont conservé leurs paramètres respectifs.
La réussite Anchor/Solana est une preuve **hôte** ; elle ne démontre pas une
exécution SBF, les CPI ou une application desktop graphique en fonctionnement.

Les artefacts finaux téléchargés sont [Windows14372055336](https://github.com/khemisset18/gpubnb/actions/runs/44178051127/artifacts/14372055336),
[Linux14370698016](https://github.com/khemisset18/gpubnb/actions/runs/44178051127/artifacts/14370698016)
et [macOS14371122487](https://github.com/khemisset18/gpubnb/actions/runs/44178051127/artifacts/14371122487).
Les SHA d'archive, 1/8/5 fichiers de bundle, empreintes des deux locks et
en-têtes PE/DEB/UDIF vérifient. Les différences de nombre de tests entre OS
restent celles de leurs suites compilées, sans test ignoré compté PASS.
Les artefacts sont des installateurs de développement, sans approbation de
distribution publique signée/notarisée.

## Les trois alertes : source, comportement et résultat strict

| Alerte | Chemin actif et vérification | Résolution compatible disponible |
| --- | --- | --- |
| Borsh 0.10.4 — GHSA-fjx5-qpf4-xjf2 | Anchor 0.31.1 exige `^0.10.3`. L'archive officielle sélectionnée contient le rejet ZST avant désérialisation. Les 2 régressions passent via le vrai Anchor. Les versions Anchor publiées 0.31.2 et 0.31.3 gardent la même contrainte. | Le correctif source existe déjà. RustSec/OSV fixent 0.10.4 ; les événements machine GitHub n'indiquent que 1.0.0-alpha.1 malgré `last_known_affected <=0.10.3`. Pas de nouvelle version compatible qui résout cette contradiction du scanner. |
| GLib 0.18.5 — GHSA-wrw7-89jp-8q8g | Cargo sélectionne réellement le backport local vérifié. La régression release passe et Tauri natif Linux compile. Latest GLib 0.22.11 ; dernière 0.18 publiée : 0.18.5. Tauri 2.12.6 / Wry 0.57.2 / Tao 0.37.2 imposent encore GTK `^0.18`. | Pas de migration officielle coordonnée publiée compatible. Les PR Tauri16170/Wry1843/Tao1332 restent ouvertes. Forcer GLib 0.20+ ne remplace pas ce graphe compatible. |
| Picomatch 4.0.5 — GHSA-fc5q-39xc-vjpf / CVE-2026-112366 | Vite7.3.7 `^4.0.3`, tinyglobby0.2.17 `^4.0.4`, fdir6.5.0 pair `^3 || ^4`. Latest officiel 4.0.7 toujours affecté ; l'avis npm couvre `*`. | Pas de version corrigée officielle publiée. PR238 ouverte : repli en littéral de certains extglobs, changement de sémantique. PR246 ouverte : proposition v2 incompatible avec le graphe v4. Aucune adoptée. |

Sources primaires relues :
[GitHub Borsh](https://api.github.com/advisories/GHSA-fjx5-qpf4-xjf2),
[OSV/RustSec](https://api.osv.dev/v1/vulns/RUSTSEC-2023-0033),
[plage machine GitHub](https://github.com/github/advisory-database/blob/main/advisories/github-reviewed/2023/04/GHSA-fjx5-qpf4-xjf2/GHSA-fjx5-qpf4-xjf2.json),
[Tauri publié](https://crates.io/api/v1/crates/tauri/2.12.6/dependencies),
[migration Tauri](https://github.com/tauri-apps/tauri/pull/16170),
[Wry](https://github.com/tauri-apps/wry/pull/1843),
[Tao](https://github.com/tauri-apps/tao/pull/1332),
[registre picomatch](https://registry.npmjs.org/picomatch),
[PR238](https://github.com/micromatch/picomatch/pull/238) et
[PR246](https://github.com/micromatch/picomatch/pull/246).
Les empreintes des réponses et têtes proposées sont dans le
[reçu interne](research/2026-11-17/internal-qualification/assessment.json).

Les archives du scan strict et de l'audit npm ont été téléchargées, leurs SHA256
vérifiés et leurs constats relus : exactement **2 MEDIUM + 1 HIGH** dans le scan,
**4 HIGH transitifs** dans npm. Borsh et GLib disposent de protections source
testées ; cela ne permet pas de déclarer le gate du scanner réussi.
Aucune version fictive, exemption, exclusion, modification d'avis, baisse de seuil,
désactivation Trivy ou rétrogradation majeure Vite/Anchor n'est appliquée.

## Grille D0–D9 sans changement des critères

| Critère | Observations internes recevables | État complet conservé et preuves manquantes |
| --- | --- | --- |
| D0 | PASS route source épinglée — [40866305437](https://github.com/khemisset18/gpubnb/actions/runs/40866305437) | PASS limité à cette route ; voie précompilée GPG distincte non choisie |
| D1 | PASS identité/version/genesis Regtest — [40892872892](https://github.com/khemisset18/gpubnb/actions/runs/40892872892), recontrôlé dans les laboratoires | PASS limité au réseau privé ; aucun réseau public qualifié |
| D2 | PASS des 32 contrôles natifs et 24 prédicats typés — [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068), [43005573333](https://github.com/khemisset18/gpubnb/actions/runs/43005573333) | BLOCKED : profil encore CANDIDATE_NOT_APPROVED ; exigences wallet/signataire/matériel et prérequis de récupération plus larges que la matrice |
| D3 | PASS des limites activation1350/1351, CLTV hauteur/temps/MTP, six sighashes et malléabilité : 2357 assertions — [43060202035](https://github.com/khemisset18/gpubnb/actions/runs/43060202035) | BLOCKED pour qualification complète liée au profil final ; aucune activation CSV/SegWit |
| D4 | PASS financement/claim/refund synthétiques, bundle avant lock, mutations/refus — [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068), [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) | BLOCKED : service financier et intégration signataire finale non qualifiés ; aucune nouvelle fonctionnalité développée pour les créer |
| D5 | PASS frais/pinning/RBF dans les bornes, reprise et refus sans diffusion — [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770), [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757) | BLOCKED : une échelle finie pré-signée ne couvre pas des frais arbitraires ; plafond et risque financier restent à accepter explicitement |
| D6 | PASS observations AuxPoW/reorg/partition/reconvergence/watchers ; 12 sorties d'erreur explicites examinées — [43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839), [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) | BLOCKED pour le critère complet lié aux prérequis ; garde direct de financement isolé en logiciel, garde d'en-têtes prioritaire nativement ; pas de fuzzing exhaustif revendiqué |
| D7 | PASS périmètre VM : 14 incidents + remplacement, récupération sans backend/clés d'origine — [43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236) ; delta courant ciblé [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) | BLOCKED : indépendance de machines physiques, reboot réel sur place et coupure physique NOT_TESTED |
| D8 | PASS politique logicielle : 12 tests, contrôle public OpenSSL des signatures et termes exacts — [44174624911](https://github.com/khemisset18/gpubnb/actions/runs/44174624911) | BLOCKED : matériel/firmware/profil/affichage réel et déconnexion NOT_TESTED |
| D9 | Dossier de sources et preuves vérifiables, [43316922937](https://github.com/khemisset18/gpubnb/actions/runs/43316922937) ; contrôles stricts exécutés | BLOCKED pour D9 complet ; sécurité interne FAIL ; audit externe indépendant NON RÉALISÉ hors mission ; activation séparée non autorisée |

Les anciens gates complets D2 n'étaient pas verts : seule leur expérience native
sélectionnée passait. Le run RBF43326020199 garde son échec global historique ;
son cas limite100/101 réussi est réutilisé, et seul le cas d'entrée corrigé a
été repris dans43484240757. Aucun échec historique n'est effacé.

## Intégrité et portée des preuves réutilisées

Les archives natives ont été revérifiées hors ligne, sans démarrer de nœud :
contrôle ZIP borné, SHA256 de l'archive, sommes internes et rapprochement des
compteurs RPC avec les journaux natifs. Les identités de leurs exécutions restent
distinctes du candidat intégré.

| Preuve | Résultat conservé | Vérification complémentaire interne |
| --- | --- | --- |
| Financement/reorg43760009110 | 2 PASS / 0 FAIL / 0 SKIP ; 2 blocs ; 173 appels client dont 169 reçus par les daemons, 4 tentatives de disponibilité ; 0,98 DOGE synthétique récupéré | Zéro nouvelle signature/clé ; zéro diffusion durant refus ; octets identiques et confirmation sur les deux nœuds |
| Frais/pinning43108343770 | 15 PASS / 0 FAIL / 0 SKIP ; 1362 blocs ; 488 appels client dont 484 reçus, 4 tentatives de disponibilité | Pression77 transactions, minimum0,01841703 DOGE mesuré, refus au plafond sans envoi, récupération0,99 DOGE ; pas une garantie de frais illimités |
| AuxPoW43311713839 | 12 propriétés, 16 mesures négatives appariées, 4 positives, 20 preuves, 133 RPC et 8 blocs | Vérificateur existant PASS sur archive ; correspondance des 12 sorties d'erreur de CAuxPow::check avec ce run et43074060943 : [revue source](research/2026-11-17/internal-qualification/auxpow-source-review.json) |
| Rust44166034964 | 11 tests Anchor hôte + 1 régression GLib release + 506 tests desktop ; zéro échec/ignoré ; compilation Tauri Linux complète PASS | Archive téléchargée et relue ; vrai vendor GLib sélectionné, Rand0.7/libsecp256k1 absents |
| Solana44166034602 | 1636 cas publics par ancien/nouveau wrapper sur chacun des 3 OS ; 2 tests par wrapper/OS, zéro échec/ignoré | Archives Linux/Windows/macOS téléchargées et relues ; pas de nouvelle signature ni clé |
| Installateurs44178051127 | SUCCESS Windows/Linux/macOS arm64 ; tests506/506/500, zéro échec/ignoré | Trois archives téléchargées, bundles et locks vérifiés, runtime réellement présent dans les métadonnées corrigées |

Les installateurs Windows/Linux du run44174624762 ont aussi été téléchargés :
leurs SHA d'archives, huit/un fichiers de bundle, SHA des locks et en-têtes
DEB/PE vérifient. Cela prouve la construction et l'intégrité du paquet, pas son
installation ou son lancement. L'omission du runtime dans leurs métadonnées
est conservée comme anomalie corrigée, pas décrite comme une preuve complète.

La révision synthétique GitHub `a4ed8e5f14e8cc72e59b197508acfc79693d8506`
des preuves hôte possède exactement le même arbre Git que39189e6 :
`2680cb03a9bbdd0f10c3808455fb7f19ee948132`, vérifié directement sur les deux
objets Git. L'égalité n'est pas déduite d'une comparaison trois points vide.
La révision synthétique `d0a2cedbf9efbafe512207eeeecf0a42d6ced161` du dernier
run d'installateurs possède elle aussi exactement l'arbre du candidat8b39c405,
`9d1296f7c74fa032b18a9b15160da7df6bae7bbb`, vérifié sur les objets Git.

Depuis l'ancienne campagne VM, le cœur a reçu des gardes supplémentaires de
cohérence/financement testés dans les 30 tests logiciels de récupération et la
régression native43760009110. Le changement de cleanroom conserve le JSON d'un
refus connu avant sa comparaison exacte ; vm_recovery ajoute la licence MIT
autorisée au colis. L'ancienne campagne complète VM n'est donc pas présentée
comme une exécution du cœur actuel. Les sources des preuves natives RBF et de
la régression reorg correspondent ; seuls leurs tests de routage CI ont évolué.

L'attestation source historique #361 porte sur ses 602 fichiers à son SHA.
Elle n'atteste ni ces nouveaux documents, ni tous les vendors Rust du candidat.
Ces derniers ont leurs propres contrôles de provenance, empreintes et preuves
Cargo. Le [reçu interne](research/2026-11-17/internal-qualification/assessment.json)
conserve les SHA d'archives, limites et correspondances exactes. Les quatre
documents de ce dossier ont leur [index SHA256](research/2026-11-17/internal-qualification/SHA256SUMS.txt)
propre et leur identité Git. Les octets signés
et journaux RPC complets restent dans les artefacts originaux, pas dans ce commit.

## Commits exacts des preuves historiques

Les têtes ci-dessous restent celles des exécutions ; elles ne sont pas remplacées
par le SHA du candidat intégré.

| Preuve | Run | Commit exécuté |
| --- | --- | --- |
| D0 source-rebuild | [40866305437](https://github.com/khemisset18/gpubnb/actions/runs/40866305437) | [`99724d5b66b9475dcb96f6c471c75ce01ed60f9a`](https://github.com/khemisset18/gpubnb/commit/99724d5b66b9475dcb96f6c471c75ce01ed60f9a) |
| D1 private identity | [40892872892](https://github.com/khemisset18/gpubnb/actions/runs/40892872892) | [`1636df354d4fafd2cc2d9ab8595f4dca52582ad7`](https://github.com/khemisset18/gpubnb/commit/1636df354d4fafd2cc2d9ab8595f4dca52582ad7) |
| D2 32-case native experiment PASS; full D2 gate not satisfied | [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068) | [`5d5d6fc9825e9b24bea061570982ad77d727a25c`](https://github.com/khemisset18/gpubnb/commit/5d5d6fc9825e9b24bea061570982ad77d727a25c) |
| source policy diagnostic, not D0 binaries | [43005573333](https://github.com/khemisset18/gpubnb/actions/runs/43005573333) | [`9fb396839eefc8cdc47028d6f8e0aecf516752cf`](https://github.com/khemisset18/gpubnb/commit/9fb396839eefc8cdc47028d6f8e0aecf516752cf) |
| D3 source diagnostic,2357 assertions,4 selected/249 unselected | [43060202035](https://github.com/khemisset18/gpubnb/actions/runs/43060202035) | [`66afc5bf1fdff1666280a74c8f45604a14ca89b8`](https://github.com/khemisset18/gpubnb/commit/66afc5bf1fdff1666280a74c8f45604a14ca89b8) |
| multi-node pre-lock bundle and keyless refund | [43052066409](https://github.com/khemisset18/gpubnb/actions/runs/43052066409) | [`4a253fc15503e9e9a164ce96375f1729c915c020`](https://github.com/khemisset18/gpubnb/commit/4a253fc15503e9e9a164ce96375f1729c915c020) |
| eight original AuxPoW controls | [43074060943](https://github.com/khemisset18/gpubnb/actions/runs/43074060943) | [`6ebdaef913e6b102c0835fbab261da9ac4cc11b6`](https://github.com/khemisset18/gpubnb/commit/6ebdaef913e6b102c0835fbab261da9ac4cc11b6) |
| 15 fee/pinning controls | [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770) | [`06c96c6284d1c33a771c41d1f9b6ffe533c946bf`](https://github.com/khemisset18/gpubnb/commit/06c96c6284d1c33a771c41d1f9b6ffe533c946bf) |
| VM recovery14incidents +replacement | [43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236) | [`6307538265aef8273447891f445a28531043d1b5`](https://github.com/khemisset18/gpubnb/commit/6307538265aef8273447891f445a28531043d1b5) |
| 12 extra AuxPoW properties | [43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839) | [`c7adde84149250c3a972e570b5df4911b20778ee`](https://github.com/khemisset18/gpubnb/commit/c7adde84149250c3a972e570b5df4911b20778ee) |
| 602-file source attestation; exact historical package only | [43316922937](https://github.com/khemisset18/gpubnb/actions/runs/43316922937) | [`0220aebdd411e018c47a55cfd5bbb974caf1fa25`](https://github.com/khemisset18/gpubnb/commit/0220aebdd411e018c47a55cfd5bbb974caf1fa25) |
| RBF count case PASS retained; input case failed | [43326020199](https://github.com/khemisset18/gpubnb/actions/runs/43326020199) | [`66dadc73cd2beffb90d153dec72c280850ea0b2b`](https://github.com/khemisset18/gpubnb/commit/66dadc73cd2beffb90d153dec72c280850ea0b2b) |
| only corrected RBF input case rerun | [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757) | [`fc2d34c58e0696e48c4490cf758070d861058fc8`](https://github.com/khemisset18/gpubnb/commit/fc2d34c58e0696e48c4490cf758070d861058fc8) |
| 2 funding reorg/refusal/recovery controls | [43760009110](https://github.com/khemisset18/gpubnb/actions/runs/43760009110) | [`e3fbbe6339d2eaecc6bd999daf2d9fe7fb6a1816`](https://github.com/khemisset18/gpubnb/commit/e3fbbe6339d2eaecc6bd999daf2d9fe7fb6a1816) |

## Blocages restants et nature de la suite

| Point | Classe | Situation précise |
| --- | --- | --- |
| Runner macOS retiré | Techniquement corrigeable maintenant | CORRIGÉ ET TESTÉ : DMG construit, job et artefact vérifiés après une première indisponibilité de capacité |
| Dépendances natives absentes des métadonnées d'installateur | Techniquement corrigeable maintenant | CORRIGÉ ET TESTÉ : runtime/Tauri/GLib observés dans les trois archives ; locks conservés |
| Borsh | Dépendant d'une correction officielle non publiée | Données d'avis/scanner à réconcilier, ou graphe compatible réellement corrigé ; protection source déjà présente et testée |
| GLib | Dépendant d'une correction officielle non publiée | Migration coordonnée GTK/Tauri compatible ; conserver le backport source vérifié |
| Picomatch | Dépendant d'une correction officielle non publiée | Version officielle v4 corrigée/compatible et avis associé ; ne pas remplacer une version par une identité fictive |
| Deux hôtes physiques, reboot/coupure, signataire | Dépendant de matériel indisponible | Les VM et signatures logicielles ne prouvent pas ces propriétés physiques |
| SBF/runtime/CPI si retenus pour le chemin financier | Dépendant de l'environnement d'exécution correspondant | Non démontré par les tests hôte ; aucun changement SBF/financier proposé ici |
| Audit indépendant D9 | Dépendant d'un contrôle humain externe | NON RÉALISÉ, hors mission ; n'empêche ni cette décision interne ni les essais privés |
| Profil/risques financiers, merge main/dev, activation | Dépendant de la décision explicite du propriétaire | Aucun effet autorisé ou déclenché ; critères techniques/financiers complets restent à satisfaire |

Aucun autre défaut reproductible corrigible par un petit changement compatible
n'a été établi dans le périmètre examiné. Les trois alertes restent visibles et
bloquantes. DOGE conserve `MARKETPLACE_ONLY`, `newTradesEnabled:false`, aucune route
de règlement, `automaticSettlement:false` et zéro des vingt directions activées,
selon l'inspection de la configuration du dépôt. Aucun état de production n'a été
inspecté ou modifié. Aucun fonds réel, Mainnet, clé utilisateur, déploiement
financier ou merge dans main/dev n'a été utilisé pour cette qualification.
