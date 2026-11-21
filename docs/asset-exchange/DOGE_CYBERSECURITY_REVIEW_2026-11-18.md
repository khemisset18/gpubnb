# DOGE — revue interne de cybersécurité, finalisée le 18 novembre 2026

> Instantané historique. Les alertes ci-dessous sont résolues dans le
> [candidat consolidé du 21 novembre](DOGE_INTERNAL_CANDIDATE_2026-11-21.md),
> dont les 12 workflows réussissent. L'ancien échec reste conservé à son SHA.

**DOGE — VALIDATION TECHNIQUE INTERNE : FAIL.** Un nouveau défaut de cohérence
RPC a été corrigé et testé, en logiciel et dans le laboratoire privé existant.
Les trois constats du scanner strict restent bloquants. Aucun résultat interne
n'est présenté comme un audit externe indépendant ou une qualification financière
complète. Aucun auditeur n'a été recherché ou attendu pour ce travail.

Le correctif et les essais ci-dessous ont été obtenus le 17 novembre. Les états
GitHub et sources officielles ont été recontrôlés le 18 novembre, sans répétition
des essais réussis à conditions inchangées.

Cette revue reprend la PR [#376](https://github.com/khemisset18/gpubnb/pull/376)
à `3a482ed02eb1374520aaeb4540dbf1c36e362d8a`, avec quatre revues internes
réparties entre Borsh, GLib, Picomatch et les frontières de récupération DOGE,
puis une revue d'intégration du correctif et des preuves. Le nouveau code est
publié au commit [`624e9f7f0a6eb09f731e1a1db25bca306506a508`](https://github.com/khemisset18/gpubnb/commit/624e9f7f0a6eb09f731e1a1db25bca306506a508),
arbre `3c888f0e6f9118f97f449735d01ac16fede946f7` avant ajout de ce dossier.

## Défaut reproduit et correction

Une réponse RPC pouvait annoncer une transaction confirmée dans un bloc à
hauteur 1357, alors que le tip et les en-têtes annoncés restaient à 1356.
Le contrôle existant vérifiait une profondeur positive et la correspondance de
`getblockhash`, sans rapprocher la hauteur et les deux profondeurs du tip observé.
Le reproducer logiciel obtenait `UTXO_AVAILABLE`, `fundingConfirmed:true` puis
un appel de diffusion simulé, malgré cette contradiction.

Le correctif lie désormais l'ancre au même tip : hauteur entière entre zéro et
le tip, profondeurs transaction/en-tête entières et égales à `tip-height+1`.
Les gardes préexistants de chaîne active, tip stable, financement, conflits,
termes financiers et signature restent en place. Aucun RPC, méthode autorisée,
budget, format de transaction, frais ou signature n'est ajouté ou modifié.
Une observation devenue incohérente pendant la lecture est refusée ; elle ne
reçoit pas de confirmation par défaut.

Après correction, `observe` et `rebroadcast` refusent le reproducer avec
**zéro appel de diffusion**. Les trois nouvelles méthodes de test couvrent les
ancres futures/négatives, les profondeurs/types incohérents et des observations
cohérentes à plusieurs hauteurs. La fixture RPC des tests annonce maintenant les
profondeurs correspondant réellement à son tip, au lieu d'une valeur constante
contradictoire.

Le risque établi concerne la cohérence RPC et la disponibilité de la récupération.
Le nœud réel continue de vérifier ses transactions : aucun vol, nouvelle signature,
transaction arbitraire ou règlement indu n'a été démontré. Le reproducer réutilise
un ancien bundle public : aucune clé utilisateur, clé nouvelle ou requête native.

## Validation affectée, sans répétition des campagnes inchangées

| Contrôle | Résultat et preuve |
| --- | --- |
| Nouvelles régressions avant correction | 3 méthodes : 1 passait, 2 échouaient ; 20 sous-cas FAIL et 2 erreurs de type conservés |
| Nouvelles régressions après correction | 3 PASS / 0 FAIL / 0 SKIP |
| Récupération logicielle complète affectée | 33 PASS / 0 FAIL / 0 SKIP |
| Laboratoire D6 / politique / signataire logiciel | 45 / 14 / 12 PASS, zéro échec/skip |
| Régression native ciblée | [44185056368](https://github.com/khemisset18/gpubnb/actions/runs/44185056368) SUCCESS ; 2 scénarios PASS / 0 FAIL / 0 SKIP sélectionné |
| Préflights logiciels du job natif | 45 D6 +12 signataire +33 récupération +24 watchers PASS, aucun échec/skip |
| Intégrité du runtime autonome | Zipapp reproduit localement depuis les sources intégrées ; SHA identique aux trois preuves cleanroom natives |

Les [reçus avant/après et six journaux](research/2026-11-17/cyber-review/rpc-anchor-fix-result.json)
conservent les sommes exactes. Les suites natives VM, AuxPoW, RBF et pression de
frais déjà réussies n'ont pas été relancées. La reprise du scénario reorg est
justifiée par le changement du cœur effectivement utilisé ; ce n'est pas une
répétition à conditions inchangées.

L'exécution native utilise la branche de laboratoire existante de la PR #364,
avec harnais figé [`7d884845657368c28d8ec5c56f8a01d0a3dad814`](https://github.com/khemisset18/gpubnb/commit/7d884845657368c28d8ec5c56f8a01d0a3dad814)
et commit exécuté [`e9291dfcbeaa287291f530df8bb8f5c527161650`](https://github.com/khemisset18/gpubnb/commit/e9291dfcbeaa287291f530df8bb8f5c527161650).
Les trois fichiers corrigés sont identiques à ceux de 624e9f7f. Le seul delta
entre harnais et exécution est son épingle dans le workflow manuel existant ;
les gardes de branche/dépôt, sources, méthodes et ressources ne sont pas élargis.

L'[archive14373961441](https://github.com/khemisset18/gpubnb/actions/runs/44185056368/artifacts/14373961441)
a été téléchargée et vérifiée : SHA256
`2e60e7e535f7bcf4cd1d1476a8c98ebac12954229ebd757c4cc304e2cfd3a609`.
Les huit sommes internes et les compteurs natifs concordent : **177 appels client,
173 reçus par les daemons (117/56), quatre tentatives de disponibilité**, deux
blocs et six invocations autonomes, sous les limites400/2/8. Le remboursement
synthétique de 0,98 DOGE est confirmé sur les deux nœuds, avec les mêmes octets
pré-signés. Zéro clé/signature nouvelle, zéro diffusion pendant le refus,
zéro progression/règlement des watchers.

Le nouveau refus de profondeur est isolé en logiciel. Dans le scénario natif
de rollback, le garde d'avance d'en-têtes refuse toujours en premier ; sa priorité
n'est pas modifiée. Les jobs natifs non sélectionnés restent SKIP, pas PASS.
Le [reçu natif vérifié](research/2026-11-17/cyber-review/native-result.json)
fixe ces limites et les preuves cleanroom.

## Recherches officielles et autres dépôts

| Sujet | Constat nouveau vérifié | Décision |
| --- | --- | --- |
| Borsh 0.10.4 | Correctif ZST officiel toujours présent. RustSec/OSV fixent0.10.4 ; événements machine GitHub incohérents. Même Anchor 0.32.3 garde Borsh ^0.10.3 ; Anchor 1.2.2 passe à Borsh 1 avec migration des interfaces Solana. Cinq parents actifs utilisent encore Borsh 0.10.4. | Conserver la protection et les tests existants ; pas de migration financière majeure pour contourner un avis contradictoire. [Reçu](research/2026-11-17/cyber-review/borsh-review.json) |
| GLib 0.18.5 | Backport officiel intact. Tauri 2.12.7, Wry 0.57.2, Tao 0.37.2 et WebKitGTK 2.0.2 publiés restent liés à GTK/GLib 0.18. La migration coordonnée demeure non publiée. | Aucun petit correctif stable compatible trouvé ; conserver le backport vérifié. [Reçu](research/2026-11-17/cyber-review/glib-review.json) |
| Exemple GLib réel | [Editkin#29](https://github.com/Hao0321/Editkin/pull/29), commit6010f2b76dbb1c49f77d5fdfddafed5f61744c86 : 15 crates de 7 dépôts officiels épinglées aux PR ouvertes, GTK 0.19/GLib 0.22. Son [run36682270509](https://github.com/Hao0321/Editkin/actions/runs/36682270509) comporte un build/audit/smoke natif Linux réussi. | Piste technique expérimentale réelle, pas une migration stable publiée ni une preuve Windows/macOS/Trivy de GPUbnb. Aucun résultat de cet autre projet n'est promu en PASS ici. |
| Picomatch 4.0.5 | Dernier officiel4.0.7, sans nouvelle version corrigée. GitHub a retiré GHSA-fc5q-39xc-vjpf le 18 novembre à 15:38:56UTC. Les propositions237/238 examinées le 17 novembre ont été appliquées hors dépôt à la source officielle, sans modifier la version, pour 21 observations bornées. |237 change la correspondance de littéraux cités et les captures ;238 laisse deux cas échantillonnés dépasser la limite de temps. Aucun patch incompatible n'est adopté. npm ne signale plus l'avis retiré ; Trivy le signale encore. [Reçu du prototype17novembre](research/2026-11-17/cyber-review/picomatch-review.json) |

L'exemple Editkin ne masque pas la version GLib dans son manifeste examiné, mais
requiert une migration coordonnée de sources non publiées et une qualification
propre à chaque plateforme. Dire qu'aucune solution technique n'existe serait
inexact ; la limite établie est l'absence de petite migration officielle stable
compatible, déjà qualifiée pour notre candidat.

Pour Picomatch, un patch appliqué seulement après installation ne couvrirait pas
les builds utilisant déjà `npm ci --ignore-scripts`. Une identité falsifiée ou
un correctif partiel ne constitue pas une résolution. Aucun nouvel avis, aucune
exemption, exclusion, rétrogradation ou réduction de seuil n'est appliqué.

### Mise à jour officielle du18 novembre et base Trivy fraîche

Le [retrait officiel de l'avis Picomatch](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
explique la disparition du constat dans npm. Le job `desktop-security` du
[run44184744507](https://github.com/khemisset18/gpubnb/actions/runs/44184744507)
repris le 18 novembre termine **SUCCESS** : npm 0 constat à toutes sévérités,
régressions Vite et build réels, 506 tests natifs PASS, zéro échec/ignoré.
Le lockfile et les versions installées sont inchangés. Ce résultat ne représente
pas la publication d'un correctif de source Picomatch.

Le job Trivy strict, repris séparément sur le même code, reste **FAIL :
Borsh MEDIUM, GLib MEDIUM, Picomatch HIGH**. Il avait restauré un cache du17
novembre ; une contre-vérification locale a donc téléchargé Trivy 0.76.2 depuis
sa release officielle, vérifié son checksum officiel, puis téléchargé sa base
officielle dans un répertoire initialement vide.

Cette base fraîche est datée du18 novembre à 13:03:23UTC, antérieure au retrait
GHSA de15:38:56UTC ; elle a été téléchargée à 18:42:04UTC. Le scan de toutes les
sévérités, dépendances de développement incluses et sans ignorer les correctifs
indisponibles, retrouve **exactement les trois mêmes constats**, exit1. Le retard
ne peut donc pas être résolu en supprimant simplement le cache CI. Aucune base,
version de package, règle d'exclusion ou gate n'a été altérée. Les métadonnées
de la base n'établissent pas une date garantie de correction par son éditeur.

Les [sources officielles fraîches](research/2026-11-18/cyber-review/fresh-official-summary.json),
la [comparaison des résultats CI](research/2026-11-18/cyber-review/security-current-result.json)
et le [scan sans cache préalable](research/2026-11-18/cyber-review/fresh-db-scan-result.json)
conservent versions, dates, commandes et empreintes. Le premier téléchargement
local n'avait pas commencé faute de répertoire temporaire par défaut ; sa trace
est conservée et l'essai avec un répertoire temporaire dédié a abouti. Ce réglage
d'environnement local n'est pas une modification du produit.

Les mesures bornées du17 novembre restent des observations de complexité et de
compatibilité, sans preuve d'une route distante exploitable dans GPUbnb. Le
graphe les situe dans les outils de développement ; aucune utilisation directe
de Picomatch dans les sources applicatives frontend/Rust examinées n'a été
trouvée. Le retrait d'un avis ne transforme pas ces mesures en correctif, ni le
constat d'un scanner en preuve d'exploitation de l'application.

## Vérification intégrée du candidat exécutable

Les résultats ci-dessous portent sur 624e9f7f, avec les reprises ciblées du18
novembre. Les annulations macOS initiales sont conservées dans les reçus : aucun
runner n'avait acquis ces jobs. Seuls les jobs en échec/annulés et affectés par
les nouvelles données ont fait l'objet d'une demande de reprise ; les campagnes
DOGE natives inchangées restent conservées.

| Workflow | Résultat final observé |
| --- | --- |
| [Foundation44184744584](https://github.com/khemisset18/gpubnb/actions/runs/44184744584) | SUCCESS, avec les nouvelles régressions de récupération |
| [Rust workspace44184744499](https://github.com/khemisset18/gpubnb/actions/runs/44184744499) | SUCCESS : source GLib, graphe actif, tests Anchor/hôte et compilation Tauri Linux |
| [Solana44184744453](https://github.com/khemisset18/gpubnb/actions/runs/44184744453) | SUCCESS sur Linux, Windows et macOS |
| [Host desktop44184744468](https://github.com/khemisset18/gpubnb/actions/runs/44184744468) | SUCCESS |
| [Workspace44184744594](https://github.com/khemisset18/gpubnb/actions/runs/44184744594) | SUCCESS |
| [MinIO/S3 44184744472](https://github.com/khemisset18/gpubnb/actions/runs/44184744472) | SUCCESS ; image, signature, provenance et essais S3 conservés |
| [Installateurs44184744520](https://github.com/khemisset18/gpubnb/actions/runs/44184744520) | SUCCESS Windows/Linux/macOS arm64 ; reprise du seul job macOS précédemment annulé |
| [Windows preflight44184744365](https://github.com/khemisset18/gpubnb/actions/runs/44184744365) | SUCCESS après retrait officiel de l'avis npm ; Agent/Host tunnel, tests/lint, construction et vérification NSIS passent |
| [CI44184744507](https://github.com/khemisset18/gpubnb/actions/runs/44184744507) | FAIL uniquement sur security-static-analysis ; npm/Desktop, API, Agent, contrat hôte, production-gates et dependency-audit SUCCESS |

Les trois archives d'installateurs du candidat ont été téléchargées et vérifiées :
[macOS14457684191](https://github.com/khemisset18/gpubnb/actions/runs/44184744520/artifacts/14457684191),
[Windows14374680975](https://github.com/khemisset18/gpubnb/actions/runs/44184744520/artifacts/14374680975)
et [Linux14374451068](https://github.com/khemisset18/gpubnb/actions/runs/44184744520/artifacts/14374451068).
Les sommes ZIP, 5/1/8 fichiers de bundle, signatures de format UDIF/PE/DEB, locks
et métadonnées avec desktop-runtime/Tauri/vrai vendor GLib correspondent au
candidat. Il s'agit de preuves de construction/intégrité, sans affirmation
d'installation ou de GUI ni de qualification physique D7.

Leur révision synthétique GitHub `a0e6202c1646d503d46ad1a05498fc5f2d84414a`
possède directement le même arbre Git `3c888f0e6f9118f97f449735d01ac16fede946f7`
que 624e9f7f, comparaison d'objets Git et non déduction d'un diff trois points.
Le [reçu des installateurs](research/2026-11-18/cyber-review/installers-current-result.json)
et le [bilan machine de la qualification](research/2026-11-18/cyber-review/result.json)
conservent les identités exactes.

## Décision et grille conservée

| Élément | Résultat actuel |
| --- | --- |
| DOGE transactions / remboursement | PASS dans le profil Regtest synthétique conservé |
| DOGE récupération et refus RPC | PASS logiciel33 tests et régression native 2 cas du nouveau cœur |
| DOGE RBF/frais / AuxPoW | PASS des preuves bornées historiques, conservées sans relance |
| Sécurité Rust | FAIL : Borsh MEDIUM et GLib MEDIUM au [scan44184744507](https://github.com/khemisset18/gpubnb/actions/runs/44184744507) |
| Sécurité Desktop | Gate Trivy FAIL sur Picomatch HIGH ; job npm/Desktop SUCCESS depuis le retrait officiel GHSA, sans changement du lockfile |
| CI complète / qualification interne | FAIL sur les gates obligatoires, malgré les essais fonctionnels positifs |
| Audit externe indépendant D9 | NON RÉALISÉ, hors mission ; n'empêche pas les essais privés |

Les archives strictes et npm du17 novembre ont été téléchargées et vérifiées,
avec trois constats filesystem et quatre entrées npm transitives de Picomatch.
Leur [reçu historique](research/2026-11-17/cyber-review/strict-security-result.json)
est conservé. Les nouvelles archives du18 novembre attestent toujours trois
constats Trivy et désormais zéro constat npm ; leurs identités sont distinctes.

| Critère complet | État | Preuve / limite restante |
| --- | --- | --- |
| D0 | PASS limité | Route source D0 historique ; précompilé GPG distinct non choisi |
| D1 | PASS limité | Identité privée Regtest, recontrôlée pendant la nouvelle exécution |
| D2 | BLOCKED | Matrice historique recevable ; profil/signataire/matériel plus larges que les prédicats |
| D3 | BLOCKED | 2357 assertions historiques ; prérequis du profil final non clos |
| D4 | BLOCKED | Claim/refund natifs et récupération ciblée passent ; intégration financière finale non qualifiée |
| D5 | BLOCKED | Frais/RBF bornés passent ; échelle finie, plafond et risque financier distincts |
| D6 | BLOCKED | AuxPoW/watchers conservés ; nouveau reorg/refus/reprise PASS, sans couverture exhaustive revendiquée |
| D7 | BLOCKED | VM historiques et cœur actuel ciblé ; machines physiques/reboot/coupure NOT_TESTED |
| D8 | BLOCKED | Politique logicielle PASS ; matériel/firmware/affichage/déconnexion NOT_TESTED |
| D9 | BLOCKED | Sécurité interne FAIL ; audit indépendant NON RÉALISÉ hors mission ; activation séparée |

Les détails et identités des preuves historiques sont dans le
[dossier de qualification précédent](DOGE_INTERNAL_QUALIFICATION_2026-11-17.md).
Son constat «191 sources inchangées» est un instantané antérieur : cette nouvelle
correction change précisément trois fichiers, tandis que **188 restent identiques**
au manifeste. Le programme financier, Cargo.lock, les signatures/transactions,
MinIO/S3, le backport GLib et les paramètres du profil restent inchangés.
Le [delta de sources](research/2026-11-17/cyber-review/source-delta.json) est explicite.

Restes : réconciliation des données officielles Borsh ; migration GLib stable
compatible ; prise en compte du retrait GHSA Picomatch dans la base Trivy officielle ;
matériel physique et signataire indisponibles ; SBF/runtime/CPI non démontrés
par les tests hôte si retenus pour le chemin financier ; audit indépendant D9
hors mission. Profil/risques financiers, merge et activation restent des décisions
explicites distinctes. Aucun Mainnet, fonds réel, clé utilisateur, activation des
vingt directions, déploiement financier, nouvelle fonctionnalité ou nouvelle PR.
