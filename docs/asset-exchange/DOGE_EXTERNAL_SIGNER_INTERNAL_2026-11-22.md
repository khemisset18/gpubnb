# DOGE — candidat interne et signataire externe, 22 novembre 2026

> Complément : la [revue des dernières versions officielles de Trust Wallet](TRUST_WALLET_DOGE_REVIEW_2026-11-22.md)
> conserve les versions publiées, l'authentification du CRX et le blocage du
> fournisseur de signature DOGE. Elle ne modifie pas le code qualifié ci-dessous.

**Adaptateur externe logiciel : PASS dans la portée mesurée ci-dessous.**
**DOGE — VALIDATION TECHNIQUE INTERNE COMPLÈTE : BLOCKED.**
Le transport, l'appairage et le journal logiciel manquants sont maintenant
implémentés et testés. D8 matériel et le gel du profil D2 restent bloqués : aucun
driver d'appareil, firmware, écran physique ou combinaison matérielle compatible
n'a été qualifié. Cette condition appartient au profil existant ; elle n'est pas
ajoutée après les essais. L'audit indépendant D9 est **NON RÉALISÉ, hors mission**
et n'a empêché aucune correction ni aucun essai privé.

Ce bilan actualise le [dossier du 21 novembre](DOGE_INTERNAL_CANDIDATE_2026-11-21.md).
Les résultats antérieurs gardent leur SHA et leurs limites. Les instantanés de
préparation du 22 novembre et le README préparatoire du contrôleur précèdent
l'exécution native ; le résultat réel de cette exécution est consigné ici.

## Candidat exact et intégration

| Identité | Valeur vérifiée |
| --- | --- |
| PR | [#376](https://github.com/khemisset18/gpubnb/pull/376), ouverte et brouillon, aucune fusion |
| Harnais relu H | [ad2c374a6b5129fc7fb422ec3eb7d578ee92715c](https://github.com/khemisset18/gpubnb/commit/ad2c374a6b5129fc7fb422ec3eb7d578ee92715c) |
| Candidat d'exécution E | [68ca4f72db340053d0208424ddba0235a57052d1](https://github.com/khemisset18/gpubnb/commit/68ca4f72db340053d0208424ddba0235a57052d1) |
| Arbre commun H/E | `afcf418adda6bcad73131598e9fe39116dac38ee` |
| Merge virtuel testé par GitHub | `abc05e271bf814bc7e1e95bea771a7b41b04c86b`, arbre identique à E ; aucune fusion réelle |
| Parent de E | H seul ; commit d'autorisation sans changement d'arbre |
| Nouveau contrôle natif | [45045597033](https://github.com/khemisset18/gpubnb/actions/runs/45045597033), job [137279395249](https://github.com/khemisset18/gpubnb/actions/runs/45045597033/job/137279395249), SUCCESS |

Le présent dossier et ses copies de preuves sont ajoutés **après** les essais,
dans un commit documentaire. Ils ne sont pas prétendus présents dans E ou dans
son archive source. Le code exécutable et les workflows restent ceux de E.
La tête documentaire et sa CI sont identifiées dans la description de la PR.

Aucun fonds réel, Mainnet, clé d'utilisateur, déploiement financier, fusion
main/dev ou activation des 20 directions. Le registre financier et ses refus
existants sont inchangés. Le nouveau contrôle ne démarre même pas de nœud.

## Bilan demandé

| Élément | Résultat | Portée et preuves |
| --- | --- | --- |
| DOGE transactions | PASS | Cas synthétiques et natifs bornés du profil candidat ; 3 nouveaux remboursements vérifiés par C ABI |
| DOGE remboursement | PASS | Claim/refund historiques conservés ; 3 nouvelles signatures acceptées et 3 mutations exactes rejetées |
| DOGE récupération | PASS | 40 tests du cœur actuel ; reprise native déjà acquise ; récupération publique du nouveau journal sans paquet signataire/clé/RPC |
| DOGE RBF / frais | PASS | Matrices existantes, 100/101 remplacements, pinning et plafond ; aucune garantie à frais arbitraires |
| DOGE AuxPoW | PASS | Preuves natives existantes conservées ; 51 tests logiciels D6 réussis dans la nouvelle CI |
| Sécurité Rust | PASS | Graphe corrigé conservé ; Trivy strict zéro constat sur E |
| Sécurité Desktop | PASS | Audits, Rust trois OS, Tauri et installateurs Linux/Windows/macOS réussis |
| CI complète | PASS | 14 workflows SUCCESS, 43 jobs SUCCESS ; 5 jobs natifs manuels SKIP, jamais comptés PASS |
| Qualification interne complète | BLOCKED | D2/D8 matériel et prérequis de phase non satisfaits |
| Audit indépendant | NON RÉALISÉ | Hors mission ; distinct de toute auto-évaluation |

Ces PASS fonctionnels ne qualifient pas un lancement financier. Le profil reste
`DOGE-1.14.9-LEGACY-P2SH-CLTV-REGTEST-CANDIDATE-1`, `CANDIDATE_NOT_APPROVED`.

## Ce qui a été réellement développé et corrigé

L'adaptateur [external_signer.py](../../asset-exchange/wallet-agent/dogecoin/external_signer.py)
réutilise les schémas, digests, transactions et vérifications cryptographiques
existants. Il épingle un zipapp externe par SHA256 et taille, un rôle public
de remboursement et des reçus de termes/requête conservés indépendamment.
Le transport utilise Python `-I -S`, une copie privée en lecture seule, un
répertoire vide, un environnement minimal, des pipes bornés et un délai borné.
Ce sont des séparations de processus, pas une isolation OS/réseau du signataire.

Le journal privé fsynce `IN_FLIGHT` **avant** l'appel au signataire. Une tentative
incertaine refuse toute réémission automatique. `COMPLETE` ne devient durable
qu'après vérification publique des signatures et une seconde observation de
hauteur. Une reprise complète rend les mêmes transactions publiques, sans
nouvelle signature. La récupération conserve la hauteur d'acceptation originale :
la date limite d'une nouvelle signature n'expire pas un remboursement déjà signé.

La [CLI](../../asset-exchange/wallet-agent/dogecoin/external_cli.py) fournit
`pair`, `review`, `sign`, `recover`. `sign` réutilise les gardes D0/Regtest et
`online_context` du cœur inchangé, avec deux observations de hauteur et un budget
maximal de 16 RPC ; elle ne diffuse rien. `recover` ne nécessite ni paquet, ni
clé, ni RPC et écrit le format de bundle durable existant. Le chemin positif
CLI a été testé avec une source de hauteur **modélisée**, pas présenté comme un
nouvel essai CLI connecté à un daemon. Le refus hors namespace privé a été
vérifié par un véritable sous-processus.

Un défaut de schéma du nouveau code a été reproduit : l'égalité Python pouvait
normaliser `True` et `1.0` en version `1`. Six sous-cas échouaient avant correction.
La réutilisation du validateur strict existant ferme la faille pour l'envoi,
le cache et la récupération. Les erreurs de fsync du répertoire parent,
le nettoyage des fichiers temporaires et les erreurs de sous-processus CLI
ont aussi été corrigés et vérifiés. Les sorties d'erreur ne réexposent pas
les arguments privés du contexte RPC.

Les 44 nouvelles méthodes de test passent, sans échec ni skip. La Foundation
exécute **60 tests wallet** (16 conservés + 44 nouveaux), **40 recovery** et
**51 D6**, tous réussis. Les trois nouvelles frontières SIGKILL utilisent une
poignée de main explicite : après intention durable, après réponse avant
complétion, puis après complétion durable avant retour. La reprise refuse les
deux états incertains et récupère le dernier sans signer de nouveau.
Un SIGKILL du broker au milieu du transport ne garantit pas l'arrêt de tous
ses descendants ; aucune garantie de confinement de processus n'est inventée.

L'implémentation est POSIX et les nouvelles preuves logicielles sont Linux.
Un signataire Windows/macOS n'est pas qualifié par les builds du Desktop.
Le logiciel de fixture n'est pas un signataire de production ; son approbation
est une assertion de test, pas une confirmation humaine sur un écran physique.

## Nouveau résultat natif, sans répéter les anciens scénarios

Le run [45045597033](https://github.com/khemisset18/gpubnb/actions/runs/45045597033)
vérifie les identités et attestations D0/D1 déjà acquises, puis extrait seulement
la bibliothèque consensus de l'archive D0 épinglée. Dans un namespace Linux
distinct contenant uniquement loopback UP, il crée deux clés de fixture jetables
après les contrôles de provenance/ABI et lance un signataire logiciel enfant.
Le paquet ne contient aucune clé privée ; le parent ne signe pas.

| Mesure native | Résultat observé |
| --- | --- |
| Remboursements produits par le broker | 3 entrées acceptées par `libdogecoinconsensus`, flags 517 = P2SH/DERSIG/CLTV |
| Contrôles négatifs | 3 refus ; chaque transaction correspond exactement à son remboursement avec sortie augmentée de 1 koinu après signature |
| Signatures | 3, revérifiées publiquement après téléchargement |
| Reconstruction du paquet | Octets et sources identiques au paquet exécuté, sans clé privée nécessaire |
| Nœuds / RPC / blocs / diffusions | 0 / 0 / 0 / 0 |
| Nettoyage | Deux chemins de clés supprimés avant conservation des preuves publiques ; pas de promesse d'effacement physique |
| Préflights du contrôleur | 13 PASS, aucune bibliothèque native chargée ni clé créée par ces préflights |
| Hauteur | Constante synthétique 1353, explicitement pas une observation de chaîne |
| Financement / mempool / finalité / matériel | Non démontrés par ce nouveau contrôle ; aucun PASS correspondant attribué |

La C ABI contrôle le script d'une entrée, pas la disponibilité d'un UTXO,
la politique mempool, les confirmations ou la finalité contre une chaîne.
Le financement sérialisé est une fixture à outpoint synthétique. Les preuves
historiques correspondantes restent attribuées à leurs propres scénarios.

L'artefact [14763397067](https://github.com/khemisset18/gpubnb/actions/runs/45045597033/artifacts/14763397067)
a été téléchargé : SHA256 du ZIP, CRC, SHA des membres et rapport vérifiés.
ZIP : `4ff7d334296754788641dbb39212dfa585a5bf4b55e08b030352d24fc0c248af`.
Rapport natif : `21e76e8d80be62ed041903c3a00739d738aa8ef700989d105b7ab56f176c7b7e`.
Le [rapport natif public](research/2026-11-22/external-signer/broker-consensus-report.json)
et le [reçu de revérification](research/2026-11-22/external-signer/native-verified-result.json)
sont conservés avec les reçus de provenance. Le contrôleur refuse aussi une
substitution de contrôle négatif non liée au remboursement correspondant.

Le workflow natif exige E, son seul parent H et l'égalité complète de leurs
arbres, des actions officielles épinglées et des permissions en lecture seule.
Le présent ajout sous `docs/` ne sélectionne pas ce workflow et n'autorise
aucune répétition des scénarios natifs déjà réussis.

## Sécurité et CI intégrée

Les corrections précédentes sont conservées : Anchor 1.2.2/Borsh 1.8.0,
GTK 0.19.0/GLib 0.22.11 via les 15 pins coordonnés officiels, suppression de
Rand 0.7, correctif source GLib, protections Borsh et MinIO/S3. Aucun lock,
scanner, seuil, exclusion ou source de base de vulnérabilités n'est modifié
par l'adaptateur. Trivy strict et les deux audits npm donnent zéro constat.

| Constat officiel | Traitement effectif conservé |
| --- | --- |
| [Borsh GHSA-fjx5-qpf4-xjf2](https://github.com/advisories/GHSA-fjx5-qpf4-xjf2) | La contradiction RustSec/OSV versus événements machine GitHub est documentée dans le bilan du 21 ; le graphe actif utilise Borsh 1.8.0, sans exemption |
| [GLib GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) | Versions corrigées disponibles ; migration coordonnée déjà testée. [Tauri 16170](https://github.com/tauri-apps/tauri/pull/16170) encore ouverte/brouillon lors de la recherche du 22 ; aucune migration partielle incompatible forcée |
| [Picomatch GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) | Avis officiellement retiré le 18 novembre ; aucun numéro de version corrigée inventé, aucune alerte masquée |
| [Effect GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw) | Correctif officiel 3.22.1 et override limité à Prisma/config 6.19.3 déjà qualifiés |

| Workflow de E | Résultat |
| --- | --- |
| [CI PR 45045603023](https://github.com/khemisset18/gpubnb/actions/runs/45045603023) | SUCCESS, 7 jobs |
| [CI push 45045596919](https://github.com/khemisset18/gpubnb/actions/runs/45045596919) | SUCCESS, 7 jobs distincts, aucun double comptage de scénario natif |
| [Foundation 45045602845](https://github.com/khemisset18/gpubnb/actions/runs/45045602845) | SUCCESS : Core, DOGE, wallet, récupération |
| [MinIO/S3 45045602869](https://github.com/khemisset18/gpubnb/actions/runs/45045602869) | SUCCESS : roundtrip et migration réels, chacun 1 PASS / 0 SKIP |
| [Fiabilité 45045603021](https://github.com/khemisset18/gpubnb/actions/runs/45045603021) | SUCCESS : 10 passes API, 25 passes Agent ; 5 jobs natifs manuels SKIP |
| [API mining 45045602911](https://github.com/khemisset18/gpubnb/actions/runs/45045602911) | SUCCESS |
| [Deployment readiness 45045603014](https://github.com/khemisset18/gpubnb/actions/runs/45045603014) | SUCCESS : validations/builds, aucun déploiement |
| [Desktop 45045602892](https://github.com/khemisset18/gpubnb/actions/runs/45045602892) | SUCCESS : frontend, Rust Linux/macOS/Windows, sécurité et provenance |
| [Solana récupération 45045602922](https://github.com/khemisset18/gpubnb/actions/runs/45045602922) | SUCCESS, trois OS |
| [Rust/GTK 45045602844](https://github.com/khemisset18/gpubnb/actions/runs/45045602844) | SUCCESS, espace de travail réel et contrôles de provenance |
| [Anchor SDK 45045602908](https://github.com/khemisset18/gpubnb/actions/runs/45045602908) | SUCCESS, hôte trois OS et comparaison SBF privée |
| [Installateurs 45045603032](https://github.com/khemisset18/gpubnb/actions/runs/45045603032) | SUCCESS, Linux x64, Windows x64, macOS ARM64 ; builds de développement non signés |
| [Windows complet 45045602896](https://github.com/khemisset18/gpubnb/actions/runs/45045602896) | SUCCESS, installateur, agent autonome et tunnel embarqués |
| [Natif externe 45045597033](https://github.com/khemisset18/gpubnb/actions/runs/45045597033) | SUCCESS, six observations C ABI décrites ci-dessus |

API : 708 tests recensés, **706 PASS / 0 FAIL / 2 SKIP** ; PostgreSQL et Redis
prêts. Les deux cas S3 exclus de ce job passent séparément avec MinIO ; ils ne
sont pas réétiquetés PASS dans le job API. Les reçus
[CI](research/2026-11-22/external-signer/ci-result.json),
[extraits de logs](research/2026-11-22/external-signer/ci-log-excerpts.json) et
[artefacts](research/2026-11-22/external-signer/artifact-verification.json)
conservent les IDs, SHA et résultats réels.

## D0–D9 : état individuel

Les preuves détaillées et les SHA historiques complets restent dans le dossier
du 21 novembre. Aucun ancien scénario natif inchangé n'a été relancé pour
produire le présent dossier.

| Critère | Résultat technique acquis | État complet et preuve principale |
| --- | --- | --- |
| D0 — outils | PASS limité à la route source | [40866305437](https://github.com/khemisset18/gpubnb/actions/runs/40866305437), archive `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8` ; attestations revérifiées dans le nouveau run |
| D1 — identité | PASS dans le laboratoire autorisé | [40892872892](https://github.com/khemisset18/gpubnb/actions/runs/40892872892) ; namespace privé du nouveau run vérifié ; pas de nouveau réseau public |
| D2 — profil | PASS des 32 cas natifs / 24 prédicats et politique | **BLOCKED** pour le gel, §7 du profil : compatibilité matérielle D8 manquante ; [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068), [43005573333](https://github.com/khemisset18/gpubnb/actions/runs/43005573333) |
| D3 — timelocks/signatures | PASS borné, 2357 assertions, six sighashes | **BLOCKED** pour clôture finale par D2 ; [43060202035](https://github.com/khemisset18/gpubnb/actions/runs/43060202035), 4 cas sélectionnés, 249 non sélectionnés non qualifiés |
| D4 — financement/claim/refund | PASS des cas décrits et refus RPC cohérents | **BLOCKED** pour clôture finale par D2 ; [43052066409](https://github.com/khemisset18/gpubnb/actions/runs/43052066409), [44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431), [44652078768](https://github.com/khemisset18/gpubnb/actions/runs/44652078768) ; nouveau C ABI limité au script |
| D5 — RBF/frais/pinning | PASS borné, plafond et refus sûr | **BLOCKED** pour clôture du profil ; [43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770), [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757), 100/101 ; ancien FAIL conservé |
| D6 — AuxPoW/reorg | PASS borné natif et 51 tests logiciels actuels | **BLOCKED** pour clôture du profil ; [43074060943](https://github.com/khemisset18/gpubnb/actions/runs/43074060943), [43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839) ; 12 retours d'erreur AuxPoW revus |
| D7 — récupération/crash | PASS des essais décrits, 40 tests, 17 interruptions historiques + 3 nouvelles frontières broker | **BLOCKED** pour clôture finale par prérequis du profil ; [43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236), 15 incidents VM attribués à leur ancienne source ; deux preuves natives du cœur actuel conservées |
| D8 — signataires | **PASS logiciel borné**, 60 tests wallet, 13 préflights et nouveau C ABI | **BLOCKED matériel** : driver/appareil/firmware/affichage/déconnexion non qualifiés ; [45045597033](https://github.com/khemisset18/gpubnb/actions/runs/45045597033) ne remplace pas ces essais |
| D9 — dossier/revue | PASS du dossier interne dans la portée des preuves | **BLOCKED complet** par prérequis D0–D8 ; audit indépendant **NON RÉALISÉ, hors mission** ; activation distincte non autorisée |

Les H7.* physiques préparés sont supplémentaires ; aucune coupure secteur
n'est ajoutée comme nouveau critère D7 obligatoire. Les anciennes preuves de
modèles bornés et leur correspondance revue restent celles du dossier du 21 :
aucune preuve universelle ni équivalence mécanisée au code n'est revendiquée.

## Sources, intégrité et procédures restantes

Le runtime recovery reste `ab6221fb209ac05316a37d9b17beb26ad45317b125dd0c1866abf3d3240a1c8b`,
le zipapp keyless `690a26f739217fb19701b5dc5ee3c6abac747b28e3ebaf7014c29897806c3f73`
et la source financière Rust `ffaa27c11cc7873282a85b05f2cfc0bcd8a6b8baba3154575596225b5faa8b41`.
Leur code, les locks, la politique et les anciennes gardes natives restent
inchangés par cet incrément. Le GUI Linux réel déjà acquis n'est pas répété
pour des octets Desktop identiques ; la nouvelle CI reconstruit les trois OS.

L'archive source de **E** a été construite deux fois à l'identique avec le
builder inchangé, puis vérifiée avec le vérificateur existant :
**770 fichiers** ; archive `74a4ede56545db7746a995809222dce2228d514e772ee92f1fa310593d20b5f7` ;
SPDX `7386e28d9b2cb6eb726246465b5fc1533db3dc09836943c1339a638ca2826ae9`.
Portée : `asset-exchange/**`, `docs/asset-exchange/**`, workflows Asset Exchange
et workspace-reliability. Ce n'est pas une archive de tout le dépôt.
Aucune nouvelle attestation GitHub/OIDC n'est revendiquée pour cette archive
locale ; les attestations D0 réutilisées sont distinctes.
[Reçu de reconstruction](research/2026-11-22/external-signer/source-result.json),
[vérification](research/2026-11-22/external-signer/source-verification.log) et
[empreintes des preuves](research/2026-11-22/external-signer/SHA256SUMS) sont conservés.

La recherche sur les firmwares officiels est épinglée dans la
[préparation du 22](research/2026-11-22/external-signer/preparation.md).
Les sources examinées ne démontrent pas le profil complet DOGE Regtest legacy
P2SH-HTLC/CLTV avec revue physique de tous les termes. Cela ne signifie pas
qu'aucun appareil ne peut produire une signature DOGE mathématiquement valide.
Un simple support du nom de monnaie ou Miniscript Bitcoin ne satisfait pas D8.

La [procédure H8.1–H8.5](DOGE_D7_D8_PROCESS_AND_HARDWARE_2026-11-20.md)
reste reproductible : choisir un appareil dédié et un firmware épinglé,
utiliser uniquement une nouvelle seed jetable, comparer les termes sur l'écran,
tester mutations et déconnexions, conserver reçus/images/logs publics.
L'ancien constat « transport logiciel NOT_IMPLEMENTED » de cette procédure
est remplacé par le présent résultat ; le driver matériel reste absent.
L'adaptateur refuse aujourd'hui les profils matériels non déclarés. Les
émulateurs officiels examinés n'ont pas été exécutés ; ils ne démontreraient
pas à eux seuls un écran ou une confirmation physiques.

| Condition restante | Catégorie et action concrète |
| --- | --- |
| Driver et firmware du profil exact | Correction logicielle possible après choix d'une cible réellement compatible ; les firmwares officiels examinés ne fournissent pas la preuve complète. Nécessite une cible et éventuellement un travail firmware spécifique, pas une modification cosmétique du broker |
| D8 appareil/écran/déconnexion | Matériel indisponible dans les environnements fournis ; modèle, firmware, appareil de test et opérateur requis avant les essais H8.* |
| Gel D2 et clôture des phases dépendantes | Dépendent des preuves D8 puis de la décision explicite d'approuver le profil ; aucune approbation présumée |
| Migration GTK entièrement publiée et stable | Dépend des releases officielles coordonnées Tauri/Wry/Tao ; ne bloque plus les essais internes de l'ensemble épinglé déjà corrigé et testé |
| Audit indépendant D9 | Contrôle humain externe NON RÉALISÉ et hors mission ; ne bloque pas les autres travaux internes |
| Merge, déploiement financier, activation | Dépendent d'une décision explicite du propriétaire ; non exécutés |

Aucun défaut reproductible encore observé dans le périmètre logiciel testé
n'est laissé volontairement en échec. Les dépendances matérielles et de profil
restent visibles ; elles ne sont pas transformées en PASS par auto-déclaration.
