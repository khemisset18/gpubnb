# DOGE — cohérence RPC et financement réorganisé

Base : PR #361, commit `cdb3e24759ed501b0e304dc15f58aaaedacb78f3`,
arbre `90b95a6063b975c4bcaa1e34955aa950f0acdfa2`. Les preuves précédentes
restent conservées. Aucun échange n'est activé ; D2–D9 reste BLOCKED.

## Défauts reproduits et correction

Le contrôle précédent refusait plusieurs remboursements confirmés, mais
acceptait plusieurs variantes en attente ou une variante confirmée et une
autre en attente pour le même outpoint. Il pouvait également accepter un
remboursement actif avec un financement non confirmé, ou des observations
déclarant sa sortie de financement encore non dépensée malgré le remboursement.

Un défaut distinct concernait un état possible après réorganisation : si le
remboursement restait en mempool mais son financement perdait ses confirmations,
la retransmission était permise, malgré la précondition de financement confirmé.

La correction refuse les observations contradictoires et exige un financement
ancré dans la chaîne active avant toute retransmission, y compris PENDING.
Un état pending avec financement non confirmé peut toujours être observé ;
il n'autorise plus de diffusion. Aucun nouveau signataire ni ajustement de frais
n'est introduit. La vérification des signatures et les termes pré-signés restent inchangés.

Six tests ciblés donnent initialement **1 PASS / 5 FAIL / 0 SKIP**. Le contrôle
de deux variantes confirmées passait déjà. Après correction, les **28 tests de
récupération PASS / 0 FAIL / 0 SKIP**, avec vraies signatures publiques OpenSSL,
validation du paquet autonome et assertions de zéro diffusion sur les refus.
Les identités et empreintes sont conservées dans
[software-result.json](research/2026-11-13/recovery-consistency/software-result.json).
Ces cas utilisent des réponses RPC contrôlées ; ils ne sont pas présentés comme
des observations de contradictions permises par un nœud Dogecoin honnête.

## Régression native ciblée à exécuter

Une extension bornée de l'exécuteur existant réutilisera le paquet public
épinglé du run VM `43111959236`. Le bundle parent, déjà signé mais non financé
dans cette chaîne initiale, pourra être financé après son CLTV 1355, puis
réorganisé d'un bloc : financement et remboursement restent ainsi tous deux
valides en mempool. Le processus autonome devra observer cet état mais refuser
sa retransmission sans appel sendrawtransaction. Après rétablissement de
l'ancrage, il devra retransmettre les mêmes octets et confirmer sur les deux nœuds.

Ce contrôle parent retient **0,98 DOGE** pour 0,01 DOGE de frais depuis une
sortie de 0,99 DOGE ; il est distinct de la preuve antérieure de récupération
de 0,99 DOGE depuis 1 DOGE. Aucun nouvel argent, clé ou signature n'est nécessaire.
Statut natif actuel : **NOT_TESTED**. Le test sera manuel, isolé et limité à
deux nouveaux blocs, avec révalidation native des 1355 blocs publics conservés.
Les anciennes suites réussies ne seront pas sélectionnées de nouveau.

Les instantanés et profils de #361 restent associés à leurs commits exacts.
Cette correction est une nouvelle révision à examiner, pas une réattribution
des anciens runs à du code non exécuté. Audit externe, matériel, reboot réel
et autres limites demeurent explicitement non qualifiés.

Le mode exécutable `recovery-funding-reorg` appartient au laboratoire D6 existant,
sélectionné uniquement par `recovery-consistency` sur la branche dédiée et un
événement manuel du dépôt exact. Il interdit AuxPoW RPC, horloge artificielle
et tout signataire. Son budget est de 400 RPC, 8 invocations autonomes et deux
transactions publiques déjà signées. Le reçu [source-index.json](research/2026-11-13/recovery-consistency/source-index.json)
fige les sources préparées et la référence amont de `gettxout`.
Les gardes couvrent aussi les 768 combinaisons du routage appelant et 48
combinaisons du nouveau mode appelé. Le contrôle des quatre étapes natives
doit rester sans autorisation de règlement, y compris avec une confirmation.

## Premier essai natif et correction de préparation

Le run [43486987680](https://github.com/khemisset18/gpubnb/actions/runs/43486987680)
est **FAIL**, avant toute propriété ciblée : attente du relais du financement.
Le [reçu](research/2026-11-13/recovery-consistency/first-native-result.json)
retient 86 RPC, zéro nouveau bloc, une admission native sur A et aucun
remboursement diffusé. Les deux nœuds déclaraient réellement
`initialblockdownload=true` à la hauteur 1355, après rejeu du paquet ancien.
La source amont épinglée limite l’âge du tip à 24h et suspend les requêtes
d’inventaire transactionnel pendant cet état.

L’ordre est corrigé : admission du financement sur A, minage de son bloc
déjà prévu et relais ordinaire de ce bloc, puis vérification de la sortie
de synchronisation initiale sur les deux nœuds avant le remboursement.
Aucune horloge, politique, limite ni validation native n’est modifiée ;
le budget reste deux blocs et le scénario de réorganisation est identique.

## Deuxième essai : motif de refus trop spécifique dans le diagnostic

Le run [43487873755](https://github.com/khemisset18/gpubnb/actions/runs/43487873755)
est **FAIL** après un bloc : sortie IBD sur les deux nœuds, remboursement en
attente avec financement confirmé, puis financement et remboursement en attente
après rollback. Les observations autonomes attestent `fundingConfirmed=true`
puis `false`. L’attente du message de refus est incorrecte : `invalidateblock`
conserve 1356 en-têtes avec 1355 blocs actifs, et le contrôle préexistant
`nodeSynchronized` intervient avant le nouveau garde de financement.
Le [reçu](research/2026-11-13/recovery-consistency/second-native-result.json)
conserve cet échec ; son archive ne contient pas le JSON du refus effectif.

Le diagnostic exige désormais ces hauteurs et le motif exact du contrôle
d’en-têtes existant. L’ordre et les exigences de `recovery_core` ne changent pas.
Cette régression native teste le refus global et la reprise après restauration ;
elle **n’isole pas** le nouveau garde de financement. Le test logiciel ciblé,
avec hauteurs d’en-têtes et de blocs égales, isole ce nouveau garde. Aucun
contrôle préexistant n’est déplacé pour obtenir un motif de refus particulier.
