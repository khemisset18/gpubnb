# DOGE — dossier de revue du 12 novembre 2026

**Décision : candidat de laboratoire documenté, qualification complète BLOCKED.**
Les trois priorités natives demandées ont été exécutées et leurs archives
vérifiées. Aucun résultat ne constitue une certification externe. Ce dossier
fige les entrées à examiner ; il n'est pas un manifeste d'activation.

## Sources à examiner

Base conservée : [PR #354](https://github.com/khemisset18/gpubnb/pull/354),
`a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`.

| Incrément | PR | Commit de preuve / source à examiner |
| --- | --- | --- |
| Frais, RBF, pinning | [#356](https://github.com/khemisset18/gpubnb/pull/356) | `26e27eb06bd22b7aa029c5b60e307c54138993df` |
| Récupération sur VM distinctes | [#357](https://github.com/khemisset18/gpubnb/pull/357) | `dfc072becc46252c38b81dde25fcc302f40a52c0` |
| Nouvelles limites AuxPoW | [#360](https://github.com/khemisset18/gpubnb/pull/360) | `0576aadcfa217496e0ac4a49d19564e0c5ba424e` |
| Rust, revue séparée | [#358](https://github.com/khemisset18/gpubnb/pull/358) | `d09996050e5aebc1be8db8698c38d7ea991929fa` |

Les commits de preuve postérieurs à une exécution ne sont pas présentés comme
des commits exécutés. Les identités exactes de chaque exécution et de son
harnais sont dans [evidence-index.json](audits/doge-review-20261112/evidence-index.json),
avec les empreintes des trois index détaillés et de leurs archives Actions.
PR #344/#349/#350/#351 et les anciennes preuves restent conservées par #354.

## Résultats effectivement obtenus

| Expérience native | PASS / FAIL / SKIP dans le périmètre sélectionné | Mesures et limites |
| --- | --- | --- |
| [Frais/pinning 43108343770](https://github.com/khemisset18/gpubnb/actions/runs/43108343770) | 15 / 0 / 0 | 488 RPC, 1362 blocs ; pression réelle sur un mempool privé de 5 MB ; 0,99 DOGE récupéré sans les clés originales |
| [VM distinctes 43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236) | 14 incidents + 1 remplacement de VM / 0 / 0 | Trois jobs Ubuntu 24.04 et trois identités de démarrage ; 0,99 DOGE confirmé sur les deux nœuds de récupération ; aucun redémarrage sur place prétendu |
| [AuxPoW 43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839) | 12 nouvelles propriétés / 0 / 0 ; réorganisation PASS | 16 rejets sur deux nœuds, 4 limites valides ; 133 RPC, 8 nouveaux blocs, 1355 blocs publics réutilisés ; aucune signature/transaction diffusée |
| D3 conservé, [43060202035](https://github.com/khemisset18/gpubnb/actions/runs/43060202035) | 4 cas sélectionnés, 2357 assertions PASS | Deux cas de chaîne et deux cas de primitives ; 249 cas amont non sélectionnés |
| Rust, [43310845271](https://github.com/khemisset18/gpubnb/actions/runs/43310845271) | 8 gardes, 3 régressions optimisées, 7 tests Anchor hôte, 506 tests desktop hôte PASS | Compilation Tauri GTK/WebKit Linux PASS ; aucun résultat SBF ni GUI/IPC complet revendiqué |

Les 174 tests logiciels de #354 restent des résultats historiques. Les
incréments ont exécuté les suites concernées : 24/12/21/24 dans le job frais,
31/12/22/24 dans le producteur VM, puis 37/12/22/24 dans le job AuxPoW
(laboratoire / signataire / récupération / watchers). Les 95 tests D2 sont
une suite distincte des 95 gardes combinées du dernier job ; ces nombres ne
doivent pas être additionnés comme des nouvelles propriétés natives.

L'échec initial de pression [43107629845](https://github.com/khemisset18/gpubnb/actions/runs/43107629845)
est conservé : 64 transactions n'atteignaient pas le plafond de 5 MB. La
correction a porté le budget à 80, sous les plafonds inchangés de 96 fixtures et
800 RPC. Le second run a atteint l'éviction à la transaction 77. Aucun rejet
natifs n'a été supprimé pour obtenir PASS.

Les rejets exacts comprennent `txn-mempool-conflict`, `insufficient fee`,
`mempool min fee not met` et les six motifs de consensus AuxPoW détaillés dans
[DOGE_AUXPOW_BOUNDARIES_2026-11-11.md](DOGE_AUXPOW_BOUNDARIES_2026-11-11.md).
Les deux encodages malformés produisent le code RPC -1, distinct d'un rejet de
consensus. Les octets RPC finaux ignorés ne font pas partie du bloc accepté.

## Profil candidat figé pour la revue

[candidate-profile.json](audits/doge-review-20261112/candidate-profile.json)
décrit le profil `DOGE-1.14.9-LEGACY-P2SH-CLTV-REGTEST-CANDIDATE-1`, ses paramètres
et les SHA256 de 22 fichiers. Il ne modifie aucun registre de capacités.
La sortie est P2SH legacy ; le secret fait 32 octets et utilise SHA256 ; les
deux clés publiques compressées sont distinctes. Claim et refund utilisent
SIGHASH_ALL, version 1, séquence `0xfffffffe` ; la branche refund impose CLTV.
Le codec garde ses marqueurs historiques de préparation et ne devient pas un
interpréteur ni une approbation cryptographique.

La récupération exige les octets exacts du financement et son ancrage confirmé
dans la chaîne active. Une mutation du TXID legacy invalide l'ancienne échelle
de remboursements. Le montant d'entrée est vérifié séparément : la signature
legacy ne le couvre pas. Les montants sont des entiers en koinu ; le taux est
exprimé par 1000 octets sérialisés avec arrondi supérieur. Une à huit signatures
préexistantes peuvent couvrir des frais croissants sous le plafond autorisé.

La séquence choisie n'autorise pas RBF. Un remboursement encore présent garde
ses octets, même après baisse du minimum. Une alternative n'est sélectionnée
que si les anciennes variantes sont absentes et le financement confirmé
disponible. Quand toute l'échelle est insuffisante, la récupération refuse sans
diffusion. Une nouvelle signature ou un budget différent demande un signataire
et de nouveaux termes autorisés. Aucune échelle finie ne garantit des frais
arbitraires ; CLTV est une borne de début, pas une date d'expiration.

Le reçu indépendant et le paquet durable doivent exister avant financement.
Les VM de récupération n'ont ni checkout serveur, ni base Exchange, ni ancien
dossier de nœud, ni clé originale. Les données publiques permettent de
reconstituer des services blockchain privés puis sont revalidées nativement.
Le troisième job remplace entièrement la VM ; il ne prouve pas un reboot du
même système ni une indépendance des hôtes physiques.

## État des phases et critères encore requis

| Phase | État complet | Éléments acquis | Critère restant avant PASS |
| --- | --- | --- | --- |
| D0 | PASS, route source reconstruite conservée | Archive/SBOM/provenance et binaires figés | La route distincte précompilée GPG n'est pas qualifiée |
| D1 | PASS, identité Regtest privée figée | Genesis/version/activation vérifiés | Aucun transfert de qualification à un réseau public |
| D2 | BLOCKED | Catalogue de 24 scénarios, contrôles de script/politique et revue technique interne | Approbation cryptographique indépendante du profil exact ; décision explicite sur toutes ses hypothèses |
| D3 | BLOCKED | Activation 1350/1351, hauteur/temps/MTP, six modes sighash et mutation legacy | Validation des prérequis D2 et des règles finales de profil ; pas de signature alternative activée |
| D4 | BLOCKED | Financement/claim/refund natifs, persistance préalable, panne/reprise/retry identique | Acceptation du profil, du signataire et de l'intégration finale ; laboratoire distinct d'un service financier de production |
| D5 | BLOCKED | 15 scénarios natifs de frais/pinning, politique réellement mesurée | Acceptation du plafond et du risque d'épuisement ; limites de nombre de remplacements et de nouvel input non confirmé seulement revues dans les sources |
| D6 | BLOCKED | Huit anciens contrôles + douze propriétés nouvelles, forks/P2P/watchers et réorganisations | Revue de complétude AuxPoW et des hypothèses adversariales ; corpus fini distinct d'un fuzzing exhaustif |
| D7 | BLOCKED | Récupération et incidents sur VM distincte ; absence des clés et du backend ; remplacement de VM | Reboot réel sur place et indépendance physique NOT_TESTED ; revue du protocole et des dépendances de confiance |
| D8 | BLOCKED | Contrôle logiciel des termes/digests/octets et signatures publiques | Approbation des termes réellement affichés ; matériel/firmware indisponibles NOT_TESTED, sans déclaration de compatibilité |
| D9 | BLOCKED | Dossier technique, empreintes et paquet source reproductible préparés | Audit externe qualifié, traitement des constats, validations et signatures de décision indépendantes |

La décision d'une phase ne se déduit pas du nombre de tests verts. Aucun champ
historique `nativeExecutorImplemented=false` d'une ancienne proposition hors
ligne n'est utilisé pour évaluer le nouvel exécuteur manuel. Les anciennes
propositions restent des instantanés et ne donnent aucune autorisation actuelle.

## Menaces DOGE à soumettre aux évaluateurs

Les frontières générales restent dans [THREAT_MODEL.md](THREAT_MODEL.md) et
[THREAT_REGISTER.md](THREAT_REGISTER.md). Ce complément relie les attaques DOGE
à leurs observations et aux risques résiduels.

| Menace et précondition | Impact | Prévention / détection / récupération testée | Preuve et risque résiduel / gate |
| --- | --- | --- | --- |
| Contrepartie modifie le script, le rôle, la sortie ou les termes après signature | Détournement ou contrat non récupérable | Codec strict, digests attendus séparément, relecture des octets et signature publique ; refus avant diffusion | D2 + 12 tests de politique signataire ; affichage humain/matériel à approuver, D2/D8 |
| Financement legacy non confirmé ou TXID malléé | Signatures de remboursement inutilisables | Liaison des octets/outpoint/montant, financement confirmé ; refus de rebinding silencieux | D3 + incident parent non confirmé ; reorg reste possible, D3/D4 |
| Opérateur ou panne perd le dossier avant le lock | Perte de la voie de récupération | Écriture exclusive, fsync fichier/répertoire, relecture et reçu indépendant pré-lock | D4/VM ; utilisateur doit conserver le reçu hors de l'attaquant, D7 |
| Attaquant réécrit paquet et manifeste ensemble | Exécution de mauvais code ou termes | Reçu conservé hors paquet, allowlist fermée et bornes avant exécution ; refus du paquet modifié | VM + vérificateur source lié aux objets Git ; compromission initiale de CI hors preuve, D7/D9 |
| Pic de frais, éviction ou descendant économique hostile | Remboursement retardé | Minimum natif, signatures préexistantes plafonnées ; variante exacte si pending ; refus de remplacement interdit | 15 cas frais ; couverture finie, aucun droit de forcer les mineurs, D5 |
| Réponse RPC perdue, processus arrêté ou doublon | Action répétée ou état trompeur | Identité des octets, journal atomique, observation active-chain ; confirmé retourne ALREADY_CONFIRMED sans diffusion | Reprise/VM ; panne électrique physique non testée, D4/D7 |
| RPC obsolète, partition ou chaîne concurrente | Fausse finalité / progression prématurée | Deux nœuds natifs et watchers distincts ; UNKNOWN/UNCERTAIN bloque ; ancrages revérifiés | Réorganisations frais/VM/AuxPoW ; deux nœuds privés ne prouvent pas un quorum public anti-éclipse, D6 |
| Preuve AuxPoW malformée ou limite mal interprétée | Acceptation invalide ou blocage | Mutations dérivées des tests Core, parent work suffisant isolant chaque motif, contrôle positif du même contexte | 8 anciens + 12 nouveaux cas ; branches/parseurs non exhaustifs, D6 |
| Signataire absent ou demande confuse | Nouvelle signature impossible / autorisation altérée | Digests de termes/requête séparément fiables, plafond/destination/réseau/délai liés ; aucune clé de secours | Politique logicielle et VM sans signataire ; matériel et écran réel non qualifiés, D8 |
| Dépendance vulnérable / archive substituée | Mémoire, RNG ou chaîne d'approvisionnement compromise | Archives/pins/licences, correctifs sources Rust sélectionnés réellement, régressions optimisées, provenance | Rust #358 : trois alertes strictes restantes et runtime SBF non testé, D9 |

## Références et adaptation

Dogecoin Core `e0a1c157791544e818c901bd9341896965afbf9d` (MIT), DCRDEX
`fc63460615e8dca83fc19520f32a1cb00be4acfa` (Blue Oak 1.0), BasicSwap
`d9313b20fc131251b50a4cf1cbcabeefbb006656` (MIT) et Decred AtomicSwap
`fdc473d3510233396a43c89ce38ff41d1ec2b456` (ISC) sont figés par source et licence.
Voir [les méthodes existantes](DOGE_REFERENCE_IMPLEMENTATIONS_2026-11-11.md)
et [le complément AtomicSwap](audits/doge-review-20261112/atomicswap-source-review.json).

Le code Bitcoin AtomicSwap exige encore le portefeuille pour recréer une
signature, utilise une séquence 0 et une structure de clés différente. Il
n'est donc pas importé tel quel dans la récupération sans clés. Son snapshot
ne contient ni outil DOGE ni fichiers `*_test.go` ; aucune suite amont de ce
projet n'a été présentée comme une validation GPUbnb.

## Rust et sécurité générale

#358 sélectionne réellement les backports GLib/Rand par les patches Cargo.
Les noms/versions et algorithmes restent identiques. Les fichiers vendus sont
reconstruits et comparés aux archives et correctifs amont ; aucune exemption
Trivy n'est ajoutée. Les trois plateformes desktop passent leurs tests/lint.

La CI stricte [43310845432](https://github.com/khemisset18/gpubnb/actions/runs/43310845432)
échoue encore sur `borsh 0.10.4 / GHSA-fjx5-qpf4-xjf2`,
`glib 0.18.5 / GHSA-wrw7-89jp-8q8g` et
`rand 0.7.3 / GHSA-cq8v-f236-94qc`. Les deux backports testés ne rendent pas le
scan propre. Pour Borsh, l'écart entre le correctif ZST publié et la plage
machine reste à résoudre. Le runtime financier SBF et le parcours GUI/IPC
complet restent NOT_TESTED. Aucun scan n'est masqué par cette documentation.
Les correctifs API/MinIO et leurs preuves antérieures sont conservés dans #354.

## Consommation du dossier et procédure de revue

Le workflow existant `asset-exchange-source-artifact.yml` construit deux fois
le même paquet et le même SPDX puis compare leurs octets. Le consommateur
sur un runner distinct vérifie les empreintes, la fermeture du périmètre,
chaque blob Git attendu et les attestations de provenance/SBOM. Il inclut le
caller manuel exact. Ce paquet couvre Asset Exchange et les documents DOGE ;
il exclut les fichiers racine Cargo, les sources vendues Rust et GPUbnb Core.
La revue Rust séparée garde son commit et ses preuves propres. Le consommateur
CI n'est pas un auditeur humain indépendant.

Pour une revue reproductible :

1. Retenir séparément le commit, l'arbre et les SHA256 du paquet, puis utiliser
   le vérificateur de ce commit. Ne pas traiter le digest fourni uniquement
   par un paquet non fiable comme une authentification.
2. Vérifier les fichiers de `candidate-profile.json` et les index natifs.
   Examiner les archives Actions originales et leurs attestations avant leur
   expiration ; ne conserver dans git que les index bornés autorisés.
3. Pour AuxPoW, le vérificateur stdlib fourni lit l'archive épinglée et recalcule
   Merkle/Scrypt/encodages et la cohérence des observations, sans démarrer de
   nœud. Les transactions signées et journaux RPC complets restent dans Actions.
4. Examiner les 24 scénarios D2 et chaque catégorie d'observation ; vérifier
   le profil, les unités de frais, la malleabilité et la récupération de bout
   en bout. Une validation native n'est pas une signature de revue.
5. Sur une vraie autre machine, reprendre le protocole consommateur exact du
   job `independent-vm` avec les seules allowlists/recettes publiées, puis
   réaliser séparément le reboot sur place et relever les identités hôte/boot.
   Les effets restent limités au Regtest privé et aux plafonds déjà définis.
6. Faire signer par des évaluateurs externes qualifiés le périmètre, les
   constats, corrections, risques acceptés et critères phase par phase.
   Aucun évaluateur ni approbation n'est inventé dans ce dossier.

Les suites natives réussies n'ont pas été relancées pour ce travail de
conditionnement. Aucun push/PR/schedule ne déclenche les effets blockchain.
Les 20 directions restent désactivées, DOGE reste MARKETPLACE_ONLY et les
contrôles de settlement restent fermés. Un audit et une décision d'activation
seraient des opérations distinctes. Aucun merge main/dev ni déploiement.
