# Pearl PRL – qualification de la chaîne native, 24 et 25 novembre 2026

**Pearl a démontré en Regtest privé le financement d'un HTLC, sa dépense par préimage, son remboursement après panne et la disparition d'un claim confirmé lors d'une réorganisation. DOGE garde l'avance expérimentale sur les politiques de mempool et le signataire externe. La qualification de production PRL reste BLOCKED.** [PR brouillon #399](https://github.com/khemisset18/gpubnb/pull/399) · [Première campagne Regtest](research/2026-11-24/prl-native/regtest-first-excerpt.jsonl) · [Rapport API et PostgreSQL](PEARL_PRL_POSTGRES_NATIVE_2026-11-24.md)

| Élément | Révision exacte |
|---|---|
| Base de #397 | `19055e1a47296d611a950a20361341cc0e7b29f7` |
| Campagne PostgreSQL, première campagne Regtest et réception des résultats d'Exchange | `7dbe541356f59b26e253bbe9e8326194e720d10e` |
| Harnais avec bornes de frais et de dust, build des deux outils Go | `a595d3cf6f6a1ba1ddb112b0de4cdbb4b7bece65` |
| Bénéficiaire distinct et observateurs avec des politiques de relais différentes | `f0bd9f3c82c4154a3e30dcbd9b1191d1cfe3c7cf` |
| Service API et dépôt PostgreSQL réel après redémarrage du processus | `cc30275e1634dc3f5c64262a996fade99506edf0` |
| Vérificateur des frais et refus du financement si un observateur exige davantage | `2fe74e7caa4a24ae19a4a937c178896564da5213` |
| Pearl Research Labs | `v1.5.8` à `3db05e0de0ca90c3a043abd927b968cf53bcd4c8` |

Les PR précédentes ont été consultées à leurs têtes respectives. [#391, 44ebb52](https://github.com/khemisset18/gpubnb/pull/391) · [#392, 5f3d5db](https://github.com/khemisset18/gpubnb/pull/392) · [#393, b8d5501](https://github.com/khemisset18/gpubnb/pull/393) · [#395, d7e1e70](https://github.com/khemisset18/gpubnb/pull/395) · [#396, 056e28f](https://github.com/khemisset18/gpubnb/pull/396) · [#397, 19055e1](https://github.com/khemisset18/gpubnb/pull/397)

## Provenance et identité

La signature Git du commit vérifie avec la clé GitHub Web Flow `968479A1AFF927E37D1A566BB5690EEEBB952194`. L'attestation de release GitHub lie le dépôt, le tag, le commit, le manifeste et l'archive Linux. Vérification locale de l'enveloppe DSSE, de la chaîne du certificat de signature et de l'horodatage RFC 3161 avec les racines récupérées par le client GitHub via TUF. Elle établit l'identité du diffuseur et l'intégrité des octets. Une reconstruction indépendante et reproductible de l'intégralité du binaire publié reste à démontrer. [Release officielle](https://github.com/pearl-research-labs/pearl/releases/tag/v1.5.8) · [Vérification](research/2026-11-24/prl-native/release-verification.txt) · [Empreintes des binaires](research/2026-11-24/prl-native/provenance.txt)

| Réseau | Magic RPC | Octets sur le fil | Genesis | HRP | Port P2P |
|---|---|---|---|---|---|
| Mainnet | `50524c4d` | `4d4c5250` | `a18d3093b7ff618f0cdd073fa3d10374e2e0105fe7ef53ff48b55f41c58dadd7` | prl | 44108 |
| Testnet | `50524c31` | `314c5250` | `10f0be7be9950f74021d0f7c62989d1e2541c4d46f3c95b74e61679864b43d18` | tprl | 44110 |
| Testnet2 | `50524c32` | `324c5250` | `b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96` | tprl | 44112 |
| Regtest | `50524c52` | `524c5250` | `78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832` | rprl | 18444 |
| Simnet | `50524c53` | `534c5250` | `78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832` | rprl | 18555 |
| Signet par défaut | `40cf030a` | `0a03cf40` | `2fef231e6125467452c9fb569e2f78c9dd534d04111fcf2cd28d9d0e93b00f34` | tprl | 38333 |

Les six lignes sont extraites du code compilé de la version épinglée. Seuls Regtest et Simnet ont été démarrés. Ils partagent le HRP **et le genesis**. Chaque processus vérifie aussi le nom RPC, la magic, la hauteur initiale et le nombre de pairs. Le RPC écoute sur loopback. L'unique cible P2P sortante est un port local réservé sans écoute. Les deux observateurs valident eux-mêmes les octets échangés par le harnais via `submitblock`. Regtest produit et valide les certificats PoUW du binaire officiel. Simnet utilise le certificat simplifié prévu par Pearl. [Paramètres extraits](research/2026-11-24/prl-native/network-parameters.txt) · [SolveBlock amont](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/blockchain/solve.go) · [Isolation](../../asset-exchange/qualification/pearl/native/private_node.py)

[Commandes complètes de reproduction](research/2026-11-24/prl-native/REPRODUCE.md)

La transaction signée n'embarque pas la magic réseau. Dans un contrôle hors ligne, attribuer ensemble l'étiquette et la magic Simnet à une capsule Regtest a conservé la validité de sa signature et le même txid. L'engagement de préparation a changé. Le harnais complet a alors refusé la capsule avant même de lancer un nœud. Ce contrôle précise pourquoi il faut conserver l'engagement par une voie indépendante. [Contrôle de liaison réseau](research/2026-11-24/prl-native/network-binding.txt)

## Protocole de laboratoire

Une PRL vaut 100 000 000 grains. Le programme Go fabrique des clés éphémères en mémoire pour le financement, le claim, le refund et l'adresse destinataire. Les transactions version 2 sont sérialisées par Pearl. Leur txid est le double SHA-256 de la sérialisation hors témoin. La sortie du contrat est P2TR v1 sur 32 octets, encodée en Bech32m pour l'adresse de laboratoire. Le consensus amont reconnaît également P2MR v2 et les sorties de données. [Transactions](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/wire/msgtx.go) · [Sorties autorisées](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/blockchain/validate.go)

L'arbre Taproot utilise le point interne NUMS de BIP341. La feuille claim exige une préimage de 32 octets, son SHA-256 convenu et une signature Schnorr de la clé claim. La feuille refund exige la hauteur 104 par CHECKLOCKTIMEVERIFY et la signature de la clé refund. Le témoin lie la feuille au contrat. Les signatures comprennent l'octet explicite SIGHASH_ALL. Le remboursement à séquence `0xfffffffe` paie 998 500 grains sur 1 000 000. Le financement réserve 2 000 grains de frais et restitue le change. Les variantes de remplacement utilisent une séquence `0xfffffffd`. [Construction et tests VM](../../asset-exchange/qualification/pearl/native/cmd/fixture/main.go)

**Avant toute soumission de financement**, le signataire exécute le refund dans la VM Pearl et quitte. Le vérificateur Go distinct, sans portefeuille, clé ni RPC, contrôle la chaîne, le prevout, la destination, les montants, le type de sighash, la feuille de refund, le bloc de contrôle et la signature. L'empreinte SHA-256 de l'intention et des transactions publiques est conservée séparément. Le harnais la relit avant financement et après panne. Une copie de la capsule ou un script changé ne constitue pas sa propre racine de confiance. Les capsules publiées contiennent le financement et le remboursement déjà signés pour ces seuls UTXO fictifs. [Vérificateur](../../asset-exchange/qualification/pearl/native/cmd/verifyrefund/main.go) · [Capsule du premier Regtest](research/2026-11-24/prl-native/regtest-material-refund.json)

Le financement du premier scénario provenait du signataire initial, SHA-256 `1e97ff1ae0c836b07f022630ec15ebaca79edfa68f53c05a6c08872fd03b84cf`. Le signataire des scénarios aux seuils a l'empreinte `840984dc2f335707dc61390654ab7614aba0622c280ba43ec9f8a4066614fe0f`. Le vérificateur de remboursement est identique pour ces exécutions, `4ef30d28fdf3fcaa6545ff4f865b6580e793e4a8ac7fd73fb133dc5ca90ffa8b`.

Les premiers scénarios se terminaient à l'UTXO confirmé sur la destination éphémère du signataire de la fixture. La campagne du 25 novembre ajoute un processus bénéficiaire distinct ainsi qu'une dépense de cet UTXO. La disponibilité d'un dépositaire d'archives indépendant et la garde à long terme des clés restent ouvertes. Le contrôle de la feuille refund ne reconstruit pas à lui seul la feuille claim cachée dans la preuve de Merkle. Le nœud valide séparément le claim complet sur l'autre branche. [Signataire du bénéficiaire](../../asset-exchange/qualification/pearl/native/cmd/recipient/main.go)

## Résultats natifs

Dans la première campagne Regtest, les deux nœuds ont validé la même histoire de 100 blocs avant le premier financement. A a confirmé le claim. B a conservé l'UTXO sur sa branche. Au tip 103, le refund était prématuré. Au tip 104, il était admissible pour le prochain bloc. Après SIGKILL, B a retrouvé son genesis sur disque, a revalidé 104 blocs d'une archive de données publiques et a récupéré le même UTXO. L'envoi des octets présignés a payé 998 500 grains au destinataire convenu. Le bloc 105 a emporté la réorganisation de A. L'UTXO du claim a disparu et le refund est devenu canonique pour les deux processus. [Transactions et hash des blocs](research/2026-11-24/prl-native/regtest-first-excerpt.jsonl)

L'admission native a refusé un refund prématuré, une mauvaise préimage, une séquence temporelle insuffisante dans la transaction, une destination changée après signature, une sortie de 1 grain, des frais nuls et une dépense concurrente. L'appel RPC demandé à une hauteur future a renvoyé le code `-1`. Ces motifs sont contrôlés dans le harnais. La politique standard est explicitement activée par `--rejectnonstd`. Une exécution de diagnostic avec la politique Simnet par défaut a accepté le refund prématuré en mempool. Ce résultat à lui seul ne prouve aucune inclusion dans un bloc valable. [Diagnostic Simnet](research/2026-11-24/prl-native/default-simnet-policy.txt) · [Contrôles d'admission](../../asset-exchange/qualification/pearl/native/qualify.py)

En Simnet, le nœud a rejeté 154 grains de frais et admis 155 pour un claim de 155 vbytes. Sur une sortie P2TR il a rejeté 332 grains et admis 333. Un remplacement à 400 grains a échoué contre une transaction à 500. Celui à 4 000 grains a évincé la transaction originale et a été confirmé. Les cas aux seuils sont soumis à `testmempoolaccept`. Le remplacement positif est aussi soumis à `sendrawtransaction` puis recherché dans le bloc. [Journal Simnet complet](research/2026-11-24/prl-native/simnet.jsonl) · [Politique mempool amont](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/mempool/policy.go)

Les trois paquets Go de la version amont, `txscript`, `chaincfg` et `mempool`, passent. Les cas de politique couvrent le graphe d'ancêtres, les conflits directs maximaux, les entrées non confirmées et le plancher de frais sur un état UTXO de test. Les deux tests amont de génération de certificats TLS, `TestNewTLSCertPair` et `TestWriteTLSCertPair`, échouent ici lors de l'énumération des interfaces par Netlink. Le reste de `btcutil` passe. Le RPC du laboratoire utilise un mot de passe éphémère sur loopback. La validation TLS de production demeure ouverte. [Paquets Go](research/2026-11-24/prl-native/upstream-selected.txt) · [Cas de frais amont](research/2026-11-24/prl-native/upstream-fee-policy.txt) · [Échecs TLS](research/2026-11-24/prl-native/upstream-tls.txt) · [Autres cas btcutil](research/2026-11-24/prl-native/upstream-btcutil-portable.txt)

La suite intégrale `node/wire` passe aussi avec la bibliothèque Rust ZK compilée depuis la même révision et les caches de circuits v2 et v1. Les cinq tests de certificats initialement en échec sans la FFI ont donc été réexécutés avec leur dépendance native. [Échec sans FFI](research/2026-11-24/prl-native/go-wire-without-ffi.txt) · [Résultat avec FFI](research/2026-11-24/prl-native/upstream-wire-zkpow.txt)

## Nature des vérifications

| Catégorie | Exécution et portée |
|---|---|
| Statique | Syntaxe de 111 modules JavaScript sur le code final, lecture des migrations et des paramètres de consensus, contrôle du diff. |
| Unitaire | Suites Go de Pearl et tests de validation d'Asset Exchange. |
| Doubles de test | Les 343 tests Node incluent des doubles de dépôts et de vérificateurs. Les 94 tests Python d'Exchange utilisent des fixtures hors ligne. |
| PostgreSQL natif | PostgreSQL 16.16, droits et transactions avec des clients séparés, puis service d'offres et pilote Node sur le cluster jetable. |
| Blockchain native | `pearld` v1.5.8 sur Regtest, avec PoUW, et séparément sur Simnet, avec le certificat simplifié du protocole. |
| Signataire logiciel distinct | Processus bénéficiaire éphémère sans clé du HTLC. Une transaction présignée par ce processus dépense le refund après confirmation. |
| Matériel physique | BLOCKED. Aucun appareil ou écran de confiance testé pour le contrat PRL. |

## Confirmation indépendante des bornes en Regtest

Une nouvelle chaîne Regtest et une nouvelle paire de signataires de claim/refund ont reproduit les bornes observées en Simnet avec des certificats PoUW natifs. Le financement de 1 000 000 grains a été confirmé à la hauteur 101. Le nœud a refusé 154 grains et accepté 155 grains de frais pour 155 vbytes. La frontière de dust P2TR se situe entre 332 et 333 grains dans cette configuration. Le remplacement à 400 grains a été rejeté, celui à 4 000 a évincé la dépense à 500 grains, puis a été confirmé. [Journal Regtest intégral](research/2026-11-24/prl-native/regtest-edges.jsonl)

| Preuve sur la nouvelle chaîne | Valeur exacte |
|---|---|
| Engagement du refund conservé avant financement | `e482b538ef45e4828a9c1107eb687613165e5adb6184427edec9a568b26ff94c` |
| Financement | `dcb07db152c09ff3fa519a1f50d1e8adc3dd7520264b2e4b7e71fec285869edb` |
| Claim confirmé sur la branche A | `92b1d0cb4f6e97a214d4d0617fd564ccca828c99442c712794a19ee04b1bf0d0` |
| Refund confirmé sur B et adopté par A | `3ba1063fd54bfd20b77c5507a38527e81e522162fc25dfd6a9298d18df18f08e` |
| Bloc 105 commun après la réorganisation | `1ceaf9205670f832f96fb4233d0da7f983f3e48339c268a578c052f9727c89e3` |

La préparation avait perdu la connexion RPC à la hauteur 21 et le processus est sorti par SIGKILL. La cause du signal n'a pas été établie. Un nœud neuf a revalidé les 21 blocs et l'engagement, puis repris la génération. L’environnement a été relancé après le bloc 99. Un dernier processus a revalidé ces 99 blocs avant de produire le bloc 100 le 25 novembre, toujours sans le signataire. Ce premier incident de préparation est distinct de l'arrêt brutal injecté volontairement à la hauteur 104 dans la qualification. Pour ce dernier, le nœud redémarré a retrouvé la hauteur 0 et a revalidé 104 blocs. Un essai de répétition du scénario initial a perdu son processus, puis sa relance autonome a également abouti, avec un autre tip et le même refund présigné. [Incident initial](research/2026-11-24/prl-native/regtest-edge-preparation-interrupted.txt) · [Reprise de la préparation](research/2026-11-24/prl-native/regtest-edge-preparation-resumed.jsonl) · [Tentative interrompue](research/2026-11-24/prl-native/regtest-initial-repeat-failure.txt) · [Répétition du premier scénario](research/2026-11-24/prl-native/regtest-repeated.jsonl) · [Index des blocs](research/2026-11-24/prl-native/prepared-block-index.json)

## Bénéficiaire distinct et budgets de frais, 25 novembre

Le nouveau bénéficiaire communique uniquement son script P2TR au constructeur du HTLC. Dans son propre processus, il vérifie que la transaction de remboursement lui paie précisément 998 500 grains, signe une dépense de cette sortie et quitte. Son engagement et celui du refund sont conservés séparément avant financement. Après panne et réorganisation, deux nœuds ont confirmé 996 500 grains sur sa seconde destination, avec 2 000 grains de frais. La transaction avait été autorisée avant financement. La capacité de signer une nouvelle autorisation après une panne ou d'en vérifier l'affichage sur un appareil physique reste à tester. [Préparation Regtest](research/2026-11-25/prl-native/regtest-prepare.jsonl) · [Campagne PoUW](research/2026-11-25/prl-native/regtest.jsonl) · [Campagne Simnet](research/2026-11-25/prl-native/simnet.jsonl)

| Pièce de la première campagne Regtest avec bénéficiaire | Identifiant |
|---|---|
| Financement de 1 000 000 grains | `7de9968af526b656f28f55f86c74bb34a7d09ad172334cabace80e3d6509c2c8` |
| Remboursement de 998 500 grains au bloc 105 | `38899aeec15c8cbe970311eb34beff7516607a95722bf5c90d977a6ccb013e4a` |
| Bloc 105 de cette campagne | `d4e2c98113d880a7893ae43d0411b1eb808c1c4c5026959cfa174cffcab48e0b` |
| Dépense présignée du bénéficiaire au bloc 106 | `d67ec761de8979cf16704c2862f53961e77c4ee39fd7c121053dfb90b83808fe` |
| Bloc 106 de cette campagne | `864458980b0d2a63e9a186abddaba130eff7cd7827633cb2aede9baaa03a6ff8` |

Le remboursement vérifié avant financement pèse 138 vbytes et paie 1 500 grains. Les résultats ci-dessous concernent les politiques réellement configurées sur `pearld` v1.5.8. Lorsque la politique était déjà exigeante avant financement, le nouveau harnais a arrêté l'essai avant diffusion dès le désaccord entre A et B. Lorsque le nœud à politique élevée a reçu le bloc 105 construit ailleurs, il l'a validé conformément aux règles de consensus. [Devis du vérificateur](research/2026-11-25/prl-native/verified-fee-quotes.jsonl) · [Refus avant financement en Regtest](research/2026-11-25/prl-native/regtest-fee-summary.txt) · [Contrôle Simnet](research/2026-11-25/prl-native/simnet-fee-summary.txt)

| Plancher de relais (grains/kvB) | Frais exigés pour 138 vbytes | Décision observée |
|---:|---:|---|
| 1 000 | 138 | Deux observateurs autorisent l'essai. Refund et dépense du bénéficiaire confirmés. |
| 11 000 | 1 518 | Financement refusé si B annonce ce seuil à l'origine. Au moment de la récupération sur une chaîne déjà financée, le refund seul est refusé en mempool. |
| 20 000 | 2 760 | Même refus préventif et même refus du refund en mempool. |

Au seuil de 11 000, le parent et son enfant paient ensemble 3 500 grains pour 250 vbytes, au-dessus des 2 750 grains calculés pour la paire. L'appel `testmempoolaccept` a renvoyé un refus de frais pour le parent, puis `missing-inputs` pour l'enfant. Le serveur a retourné `-32601 Method not found` pour `submitpackage`. Ce couple ne fournit donc pas de voie de relais démontrée sur ce nœud. **FAIL** pour la disponibilité du refund fixe sous ces deux politiques. Le refus de financer protège quand la hausse est visible à l'avance. La sortie en cas de hausse après financement reste **BLOCKED**. [Regtest au seuil initial de 11 000](research/2026-11-25/prl-native/regtest-fee-11000.jsonl) · [Regtest au seuil initial de 20 000](research/2026-11-25/prl-native/regtest-fee-20000.jsonl) · [Cycle complet et changement de politiques](research/2026-11-25/prl-native/regtest-fee-1000.jsonl)

Le vérificateur hors ligne a validé les deux capsules publiées et rejeté les entrées tronquées ou trop longues, un second objet JSON, un champ inconnu, une valeur changée ou un script de destination différent. Le destinataire logiciel a refusé une demande pour un autre bénéficiaire et une étiquette de réseau public. Une empreinte du bénéficiaire altérée a interrompu le harnais avant toute ouverture d'un nœud. [Contrôles des entrées](research/2026-11-25/prl-native/public-inputs.txt) · [Contrôle des engagements](research/2026-11-25/prl-native/recipient-commitment-negative.txt)

Le point de reprise exact au bloc 104 et une continuation publique jusqu'au bloc 106 sont livrés avec un lecteur autonome. Le lecteur utilise les blocs, la capsule de refund et la dépense présignée du bénéficiaire. Il lance un nouveau nœud sans portefeuille. Dans cet essai indépendant, le bloc 106 a pour hash `bf16d0b53ac9fb1d00f39bffc90058c7ea0ebe82fc9d751eda7464306b78b0c2`. Un autre nœud neuf a ensuite revalidé passivement les mêmes 106 blocs et retrouvé les mêmes 996 500 grains sur la sortie du bénéficiaire. [Archives et reproduction](research/2026-11-25/prl-native/README.md) · [Récupération](research/2026-11-25/prl-native/public-regtest-recovery.jsonl) · [Rejeu passif](research/2026-11-25/prl-native/public-regtest-replay.jsonl)

## Matrice de décision

| Étape | Décision | Propriété démontrée ou preuve encore nécessaire |
|---|---|---|
| P0 – provenance | PASS | Commit signé, release horodatée, empreinte du programme effectivement exécuté. |
| P1 – nœud et réseau | PASS | Deux nœuds officiels sur bases neuves, contrôle de magic, genesis, chaîne, pairs et maturité. |
| P2 – transactions et scripts | PASS | Signatures Schnorr, Taproot, preuve de feuille, CLTV, préimage, sérialisation et mutations vérifiées par la VM et le nœud. |
| P3 – lock, claim, refund | PASS | Financement confirmé après vérification du refund. Claim et refund confirmés sur des branches concurrentes. |
| P4 – frais, mempool et conflits | BLOCKED | Seuils et remplacement simple démontrés. FAIL pour le relais du remboursement à 1 500 grains sous les deux politiques élevées. Le garde-fou couvre les seuils visibles avant financement. Une hausse ultérieure, les limites d'éviction et les dépendances de transactions restent à couvrir pour garantir une sortie. |
| P5 – réorganisation | PASS | Un claim confirmé est déconnecté par une branche plus longue. Deux répertoires et processus indépendants convergent sur le même UTXO. |
| P6 – récupération | PASS | Au seuil couvert, le refund est confirmé après arrêt brutal et restauration de l'historique public. Un bénéficiaire distinct a autorisé à l'avance une dépense de sa sortie, confirmée par deux nœuds. |
| P7 – API et PostgreSQL | PASS | Refus de trois acceptations historiques via le dépôt PostgreSQL, contrôles SQL directs et reprise d'une requête applicative signée avec un unique résultat durable après redémarrage. |
| P8 – signataire externe et matériel | BLOCKED | Le bénéficiaire logiciel détient une clé distincte et sa dépense aboutit dans le laboratoire. L'affichage de confiance du réseau, des feuilles PRL, des frais et de la destination reste à vérifier sur un appareil compatible. |
| P9 – audit et décision de production | BLOCKED | Revue indépendante, politique de frais de sortie, sécurité opérationnelle et validation matérielle restent ouvertes. |

Une démonstration BitGo de multisignature ou la présence du portefeuille logiciel Oyster ne valide pas l'affichage du réseau, de l'outpoint, du montant, de la destination, des frais et de la hauteur sur un dispositif indépendant. Aucun matériel physique n'a été utilisé. [Oyster](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/wallet/README.md) · [Profil Pearl de BitGo](https://developers.bitgo.com/docs/pearl)

## Revue STRIDE

| Menace | Contrôle exercé et limite résiduelle |
|---|---|
| Usurpation | Authentification et liaison acteur/objet dans les tests API. Les garde-fous de laboratoire vérifient nom, magic, genesis et empreinte du nœud. Les observateurs dépendent encore du même hôte et du même binaire. |
| Altération | SIGHASH_ALL, vérification indépendante de l'intention, refus des mutations de destination, montant, réseau, préimage ou temporisation. L'opérateur doit conserver un canal indépendant pour l'empreinte et la capsule. |
| Répudiation | Empreintes, txid, hash des blocs, résultats d'idempotence et événements SQL relient les opérations. La perte de la réponse après commit a été exercée. Une conservation externe inaltérable reste à qualifier. |
| Divulgation | Les clés des utilisateurs sont absentes du protocole de test. Les clés de signature éphémères restent dans le processus initial, les capsules sont publiques. La préimage d'un claim devient publique dans son témoin. Les sauvegardes et la télémétrie d'une future exploitation exigent une revue. |
| Déni de service | Tailles d'entrées bornées, refus du second objet JSON, contrôles API, concurrence SQL, erreur RPC, crash et réorganisation exercés. Deux politiques locales refusent le refund à frais fixes. La disponibilité en cas de hausse après financement reste ouverte. |
| Élévation de privilèges | Contrôles IDOR/BOLA et sujet/session, requêtes paramétrées, triggers SQL et droits invoker. Un lecteur ne peut écrire. Le compte propriétaire peut administrer son schéma. Les ACL réelles et la séparation des opérateurs demandent une preuve opérationnelle. |

## Comparaison avec DOGE et décision

| Critère | Pearl | Référence DOGE |
|---|---|---|
| Primitives et cycle natif | P2TR/Tapscript, deux dépenses confirmées, clés éphémères et argent fictif. | Dogecoin Core 1.14.9, HTLC et validation native de scripts selon son propre consensus. Même famille de démonstration expérimentale sur deux protocoles distincts. |
| Reprise et observateurs | Restauration sur blocs publics, refund puis dépense présignée d'un bénéficiaire distinct, désaccord sur le claim puis convergence. | Campagnes de cohérence et de reprise multi-observateurs plus étendues. Pearl couvre le cas borné décrit ici. |
| Frais, conflits et pinning | Seuils d'admission, remplacement simple, deux politiques élevées et observation d'un couple parent/enfant sur le nœud natif. | Campagnes dédiées sur des graphes de dépendances, nouvelles entrées non confirmées et frontières de remplacement à 100/101. Avance DOGE. |
| Signature externe | Outil logiciel séparé pour le bénéficiaire, contrôle cryptographique indépendant et confirmation de la dépense. | Application Ledger DOGE sous Speculos et contrôle libdogecoinconsensus, avec onze mutations rejetées. Le rapport DOGE laisse lui aussi D8 physique ouvert. |
| Audit et usage réel | P8 et P9 bloquent la production. | La référence DOGE laisse D9 ouvert. Aucune équivalence globale ni autorisation de règlement réel n'en découle. |

[Référence d'intégration DOGE](DOGE_INTEGRATION_2026-11-15.md) · [Frais et pinning](DOGE_FEE_PINNING_2026-11-11.md) · [Frontières RBF](DOGE_RBF_BOUNDARIES_2026-11-12.md) · [Récupération](DOGE_RECOVERY_CONSISTENCY_2026-11-13.md) · [Signataire émulé et consensus](DOGE_D8_STAGE3_NATIVE_CONSENSUS_2026-11-22.md)

Le registre conserve `MARKETPLACE_ONLY / RESTRICTED`, `identityReady=false`, `newOffersEnabled=false`, `newTradesEnabled=false` et `automaticSettlementSupported=false`. Le harnais est une commande autonome de qualification. La PR reste en brouillon. Le minage GPUbnb et les implémentations des autres actifs sont hors de son diff.
