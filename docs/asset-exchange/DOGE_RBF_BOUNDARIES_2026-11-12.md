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
