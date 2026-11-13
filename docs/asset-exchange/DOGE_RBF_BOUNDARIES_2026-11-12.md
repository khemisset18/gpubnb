# DOGE RBF — limites natives complémentaires

Base de revue : PR #361 `cdb3e24759ed501b0e304dc15f58aaaedacb78f3`,
arbre `90b95a6063b975c4bcaa1e34955aa950f0acdfa2`. La source locale a cet arbre
exact, même lorsque son identifiant de commit local diffère. Les preuves
#354/#356/#357/#360/#361 sont conservées. Les suites natives réussies ne sont
pas sélectionnées de nouveau.

Deux points D5 étaient encore documentés par lecture seule des sources : la
limite de nombre de remplacements et l'ajout d'une nouvelle entrée non confirmée.
Cet incrément adapte les cas `test_too_many_replacements` et
`test_new_unconfirmed_inputs` de `qa/rpc-tests/replace-by-fee.py` au commit
Dogecoin 1.14.9 `e0a1c157791544e818c901bd9341896965afbf9d`.
Les sources, hypothèses, licence MIT et bornes sont dans
[source-index.json](research/2026-11-12/rbf-boundaries/source-index.json).

## Contrôles préparés

| Cas | Rejet attendu | Contrôle positif exigé |
| --- | --- | --- |
| 101 transactions directement conflictuelles | `too many potential replacements`, code natif 64 ; les 101 originales restent présentes | Un candidat correctement recalculé/signé remplace exactement 100 originales ; la 101e reste présente |
| Nouvelle entrée non confirmée | `replacement-adds-unconfirmed`, code natif 64 ; parent et originale restent présents | Après inclusion du seul parent dans un bloc, les mêmes octets déjà signés sont acceptés et remplacent l'originale |

Il s'agit de politique mempool, pas de consensus. Le code 64 est celui du
`CValidationState` natif : aucun code RPC -26 n'est prétendu sans appel RPC.
Les transactions utilisent des entrées/sorties P2PK standard, la sérialisation
et les signatures natives, des UTXO confirmés réels et le mempool global de
Dogecoin. Chaque signature est vérifiée par l'interpréteur natif avant le
test de politique, y compris pour le candidat refusé avant `CheckInputs`.
Aucune entrée `addUnchecked` ni baisse des frais/standardness/limites n'est utilisée.

L'opt-in `0xfffffffd` est un contrôle diagnostique. Le profil de récupération
HTLC reste `0xfffffffe`, sans RBF. Cet incrément ne modifie ni son code ni ses
capacités et ne constitue pas une nouvelle preuve de remboursement HTLC.

## Exécuteur et bornes

La troisième suite `gpubnb_rbf` est enregistrée par le préparateur existant,
sans changement d'implémentation amont. Les suites `gpubnb_policy` et `gpubnb_d3`
restent inchangées et non sélectionnées. Le même binaire de diagnostic est
compilé depuis les sources et dépendances officielles déjà épinglées ; son
identité reste distincte de D0.

La sélection `rbf-boundaries` de l'entrée manuelle `workspace-reliability`
appelle uniquement ce diagnostic sur la branche exacte
`asset-exchange/doge-rbf-boundaries-20261112`, dépôt et ID attendus.
Les autres jobs DOGE excluent explicitement ce choix. Aucun push, PR, schedule,
main/dev ni autre dépôt ne peut exécuter ces effets natifs. La source du harnais
est figée avant le lancement, puis comparée à l'exécution, workflow appelé inclus.

Le processus est placé dans un namespace réseau neuf, UP loopback seulement,
avec environnement vidé et limites CPU 180 s, mur 240 s, mémoire 2 GiB et
fichier 64 MiB. Il ne démarre ni wallet, RPC ni listener P2P. Les clés de
fixture sont éphémères en mémoire, jamais incluses dans les artefacts.

Bornes des deux cas : 481 blocs privés au total (240 + 241), 241 par fixture,
101 entrées mempool, 101 inputs par transaction, 103 fixtures signées et
302 signatures au maximum par cas, 103 appels d'admission au maximum par cas.
Le contrôle attendu totalise 106 fixtures signées, 306 signatures et 107 appels
d'admission. Chaque borne est contrôlée dans le code de test ; chaque marqueur
positif/négatif et les deux cas PASS sont requis par le collecteur.

## État de vérification

13 gardes logiciels PASS, 0 FAIL, 0 SKIP, dont refus de source sale/altérée,
ajout de troisième suite avant toute mutation, refus d'une observation native
incomplète et contrôle indépendant de 768 combinaisons de routage et 48 du
workflow appelé. Le préparateur a également été appliqué au checkout amont
exact : seule l'inscription Makefile et les trois fichiers de tests sont ajoutés.
La compilation locale n'est pas revendiquée : les en-têtes Boost n'y sont pas
installés. La compilation complète et les deux nouveaux cas restent
**NOT_TESTED** jusqu'au lancement manuel isolé.

Les archives complètes restent dans Actions ; seuls métriques, motifs et
empreintes bornés seront ajoutés après vérification. La qualification D5 et
D2–D9 reste **BLOCKED** jusqu'à satisfaction et revue de tous les critères.
La limite de frais pré-signés, l'audit externe, les essais matériels et les
autres limites du dossier #361 ne sont pas annulés par ces deux contrôles.


## Premier résultat natif et correction du 13 novembre

Le run manuel [43326020199](https://github.com/khemisset18/gpubnb/actions/runs/43326020199)
a compilé correctement le diagnostic, puis terminé en **FAIL** : le contrôle
100/101 remplacements passe avec **2853 assertions**, le contrôle de nouvelle
entrée échoue sur une hauteur de bloc restée à 240 au lieu de 241. Le rejet
non confirmé est vérifié avant cet échec, mais le cas complet reste FAIL.
Le [reçu du premier run](research/2026-11-12/rbf-boundaries/first-run-result.json)
conserve les identités, empreintes et observations réelles.

La fixture amont construit initialement son coinbase avec les frais de tout
le mempool, puis remplace la liste de transactions du bloc. Notre sélection
manuelle du seul parent conservait donc les frais de l'original non sélectionné.
La correction retire temporairement l'original pendant cette construction,
confirme le parent avec les validations natives inchangées, puis réadmet
exactement la même originale signée avant de réessayer le candidat inchangé.
Cela ajoute un appel d'admission, sans nouvelle signature : 3 fixtures,
4 signatures et 5 admissions pour ce cas. Aucun contrôle de bloc n'est relâché.

La reprise sélectionne uniquement ce cas : `rbf-input`, filtre
`gpubnb_rbf/new_input_unconfirmed_then_confirmed`, au plus 241 blocs.
Le cas 100/101 réussi n'est pas relancé ; son code et ses helpers ont été
comparés octet pour octet et restent inchangés. Les 14 gardes logiciels passent,
avec 768 combinaisons de routage caller et 64 du workflow appelé. Le résultat
natif de cette reprise reste NOT_TESTED jusqu'à son exécution manuelle.

## Résultat de la reprise ciblée du 13 novembre

Le run manuel [43484240757](https://github.com/khemisset18/gpubnb/actions/runs/43484240757),
exécution `fc2d34c58e0696e48c4490cf758070d861058fc8` et harnais
`e084af94b3792c7d675756a62067d44effe3a4a0`, est **PASS**. Le seul cas
sélectionné passe ses **73 assertions**, avec rejet natif code64
`replacement-adds-unconfirmed`, puis acceptation des octets signés identiques
après confirmation du parent et réadmission de l’original identique.
Trois fixtures, quatre signatures, cinq admissions et 241 blocs ; zéro RPC/P2P.
Les 254 autres cas Boost sont non sélectionnés, dont le cas 100/101 déjà réussi.

Le [reçu vérifié](research/2026-11-12/rbf-boundaries/retry-result.json)
conserve l’archive, le binaire distinct de D0, les empreintes des sources et
les namespaces UP loopback avant/après. Les deux propriétés ciblées disposent
donc chacune d’une preuve native PASS ; le premier échec reste conservé et
les anciennes suites ne sont pas relancées. Cela ne qualifie pas D2–D9,
ne prouve pas P2P ni le remboursement HTLC complet. Statut global **BLOCKED**.
