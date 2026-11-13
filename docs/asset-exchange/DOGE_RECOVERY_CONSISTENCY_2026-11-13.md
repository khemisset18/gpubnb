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
