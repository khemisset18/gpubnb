# DOGE : reprendre les méthodes existantes — 11 novembre 2026

La recherche porte sur le code et les tests de DCRDEX, BasicSwap, decred/atomicswap et Dogecoin Core. Les versions examinées sont fixées dans research/2026-11-11/reference-index.json. Les descriptions commerciales ne constituent pas une preuve de sécurité ou de qualification.

| Référence examinée | Comportement constaté dans les sources | Application au travail GPUbnb |
| --- | --- | --- |
| DCRDEX, client/asset/btc/btc.go, Refund et refundTx ; adaptateur client/asset/doge/doge.go | Vérifie la sortie disponible, construit le remboursement à partir du montant réel, calcule les frais, refuse un remboursement non économique ou sous le seuil dust, conserve la transaction avant diffusion pour les nouvelles tentatives | Vérifier montant/script/sortie avant remboursement ; réutiliser les mêmes octets après une réponse perdue ; contrôler montant final et frais |
| decred/atomicswap, README, commande refund | Prévoit de reconstruire un remboursement après un problème de frais ou de modification de l'identifiant de financement | Tester une reconstruction liée à la sortie réelle lorsque l'ancienne transaction est refusée ; ne pas confondre nouvelle signature et retransmission |
| BasicSwap, interface DOGE, interface BTC et tests DOGE | Calcule des frais à partir d'une taille de transaction ; teste les frais réellement payés ; possède un plafond de taux avant construction ; configure ses tests DOGE sans CSV ni SegWit | Conserver les unités exactes, vérifier taille/montant payé et plafond ; ne pas importer une capacité Bitcoin non prouvée sur DOGE |
| Dogecoin Core 1.14.9, doc/fee-recommendation.md et validation.cpp | Distingue recommandation de frais, politique de relais, seuils dust et minimum dynamique du mempool | Mesurer le vrai rejet natif et la vraie admission ; ne pas prendre une valeur fixe de test pour une politique de frais de production |

Ces références montrent des méthodes et des scénarios existants. Leur code a été examiné ; leurs suites complètes n'ont pas été exécutées dans cette intervention. Leurs résultats ne sont pas transférés automatiquement à GPUbnb. La preuve recherchée est l'exécution du scénario correspondant dans notre environnement isolé.

## Scénario ajouté à la suite existante

La suite de diagnostics compilés contre les implémentations inchangées de Dogecoin reçoit un troisième cas :

1. Activer BIP65 en Regtest privé et financer un contrat HTLC avec 100 DOGE fictifs ; vérifier le montant et le script dans la vue réelle des sorties.
2. Construire et admettre un remboursement à 0,01 DOGE de frais. Le retirer du mempool de test pour isoler une hausse de frais d'un remplacement RBF.
3. Provoquer une éviction déterministe avec une seule entrée synthétique non admise ; constater le refus natif du remboursement initial, exactement pour mempool min fee not met.
4. Recalculer et signer un remboursement sous un plafond de 1 DOGE. Conserver la sortie de financement, la destination, le délai et la séquence. Vérifier le montant net, le seuil dust et le minimum natif mesuré.
5. Exiger l'admission native puis l'inclusion dans un bloc et constater la sortie de contrat dépensée ainsi que la sortie de remboursement disponible.

La montée de frais est déterministe et bornée ; elle ne représente pas un remplissage organique du réseau. Le nouveau remboursement est signé avec une clé éphémère encore disponible, comme dans une reconstruction par portefeuille. La récupération sans aucune clé après crash reste couverte uniquement par le remboursement déjà sauvegardé ; aucun réajustement de frais sans signataire n'est prétendu.

Le binaire est un diagnostic recompilé distinct de D0. Il utilise les fonctions réelles d'admission, de script, de mempool et de validation des blocs. Aucun code d'implémentation amont n'est modifié. Les trois cas restent limités à 1594 blocs synthétiques au total, 1354 par fixture, deux entrées synthétiques au total, une à la fois, et aux plafonds existants CPU/mémoire/temps. Les diagnostics n'activent aucune route financière de production.

## Références exactes

- https://github.com/decred/dcrdex/blob/fc63460615e8dca83fc19520f32a1cb00be4acfa/client/asset/btc/btc.go
- https://github.com/decred/dcrdex/blob/fc63460615e8dca83fc19520f32a1cb00be4acfa/client/asset/doge/doge.go
- https://github.com/decred/atomicswap/blob/fdc473d3510233396a43c89ce38ff41d1ec2b456/README.md
- https://github.com/basicswap/basicswap/blob/d9313b20fc131251b50a4cf1cbcabeefbb006656/basicswap/interface/doge/doge.py
- https://github.com/basicswap/basicswap/blob/d9313b20fc131251b50a4cf1cbcabeefbb006656/basicswap/interface/btc/btc.py
- https://github.com/basicswap/basicswap/blob/d9313b20fc131251b50a4cf1cbcabeefbb006656/tests/basicswap/extended/test_doge.py
- https://github.com/dogecoin/dogecoin/blob/e0a1c157791544e818c901bd9341896965afbf9d/doc/fee-recommendation.md

Résultat natif vérifié : PASS, run [43005573333](https://github.com/khemisset18/gpubnb/actions/runs/43005573333), commit d'exécution 9fb396839eefc8cdc47028d6f8e0aecf516752cf, harnais figé 578a23cda6cda31d664b096457f405d4cd666b9e. Trois cas sélectionnés et 60 assertions passent, dont 34 pour le nouveau scénario de remboursement. Les 246 autres cas amont ne sont pas exécutés par ce run. Les cinq gardes Python passent.

L'ancien remboursement paie 1 000 000 koinu (0,01 DOGE) ; le minimum dynamique mesuré pour le nouveau remboursement est 32 708 662 koinu ; le budget de test choisi est 100 000 000 koinu (1 DOGE), qui est aussi le plafond explicite. Les 9 900 000 000 koinu restants (99 DOGE) sont présents dans la sortie de remboursement après le bloc 1354. Ce scénario éprouve un budget fixe ; il ne prétend pas choisir automatiquement les frais minimaux optimaux en production.

L'archive 13847319900 a pour SHA256 3a556f5dc86084184234c6e2c3b315834d7a21f27b61995686137b4818a6c8ea, identique au digest d'upload. Tous les digests internes sont vérifiés. Les trois fichiers d'implémentation amont conservent leurs digests d'origine ; le fichier de test correspond au harnais publié. Binaire diagnostic : 21043a8f6cc74d9650d2ca39f2bb923144bfd1158e2a098ad0b532c0c0b62c7c. Métriques, provenance et journal Boost borné : audits/evidence/doge-refund-fees-20261111.

La qualification financière complète reste BLOCKED : ce résultat démontre la reconstruction native avec signataire disponible, pas encore une route de production, une récupération sans signataire, un remplacement RBF déjà en mempool ou une propagation entre plusieurs nœuds. Le déclencheur automatique temporaire est retiré après la capture des preuves.
