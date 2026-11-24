# Pearl PRL – qualification de la chaîne native du 24 novembre 2026

**Pearl a démontré en Regtest privé le financement d'un HTLC, sa dépense par préimage, son remboursement après panne et la disparition d'un claim confirmé lors d'une réorganisation. DOGE garde l'avance expérimentale sur les politiques de mempool et le signataire externe. La qualification de production PRL reste BLOCKED.** [PR brouillon #399](https://github.com/khemisset18/gpubnb/pull/399) · [Première campagne Regtest](research/2026-11-24/prl-native/regtest-first-excerpt.jsonl) · [Rapport API et PostgreSQL](PEARL_PRL_POSTGRES_NATIVE_2026-11-24.md)

| Élément | Révision exacte |
|---|---|
| Base de #397 | `19055e1a47296d611a950a20361341cc0e7b29f7` |
| Campagne PostgreSQL, première campagne Regtest et réception des résultats d'Exchange | `7dbe541356f59b26e253bbe9e8326194e720d10e` |
| Harnais avec bornes de frais et de dust, build des deux outils Go | `a595d3cf6f6a1ba1ddb112b0de4cdbb4b7bece65` |
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

## Protocole de laboratoire

Une PRL vaut 100 000 000 grains. Le programme Go fabrique des clés éphémères en mémoire pour le financement, le claim, le refund et l'adresse destinataire. Les transactions version 2 sont sérialisées par Pearl. Leur txid est le double SHA-256 de la sérialisation hors témoin. La sortie du contrat est P2TR v1 sur 32 octets, encodée en Bech32m pour l'adresse de laboratoire. Le consensus amont reconnaît également P2MR v2 et les sorties de données. [Transactions](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/wire/msgtx.go) · [Sorties autorisées](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/blockchain/validate.go)

L'arbre Taproot utilise le point interne NUMS de BIP341. La feuille claim exige une préimage de 32 octets, son SHA-256 convenu et une signature Schnorr de la clé claim. La feuille refund exige la hauteur 104 par CHECKLOCKTIMEVERIFY et la signature de la clé refund. Le témoin lie la feuille au contrat. Les signatures comprennent l'octet explicite SIGHASH_ALL. Le remboursement à séquence `0xfffffffe` paie 998 500 grains sur 1 000 000. Le financement réserve 2 000 grains de frais et restitue le change. Les variantes de remplacement utilisent une séquence `0xfffffffd`. [Construction et tests VM](../../asset-exchange/qualification/pearl/native/cmd/fixture/main.go)

**Avant toute soumission de financement**, le signataire exécute le refund dans la VM Pearl et quitte. Le vérificateur Go distinct, sans portefeuille, clé ni RPC, contrôle la chaîne, le prevout, la destination, les montants, le type de sighash, la feuille de refund, le bloc de contrôle et la signature. L'empreinte SHA-256 de l'intention et des transactions publiques est conservée séparément. Le harnais la relit avant financement et après panne. Une copie de la capsule ou un script changé ne constitue pas sa propre racine de confiance. Les capsules publiées contiennent le financement et le remboursement déjà signés pour ces seuls UTXO fictifs. [Vérificateur](../../asset-exchange/qualification/pearl/native/cmd/verifyrefund/main.go) · [Capsule du premier Regtest](research/2026-11-24/prl-native/regtest-material-refund.json)

Le financement du premier scénario provenait du signataire initial, SHA-256 `1e97ff1ae0c836b07f022630ec15ebaca79edfa68f53c05a6c08872fd03b84cf`. Le signataire des scénarios aux seuils a l'empreinte `840984dc2f335707dc61390654ab7614aba0622c280ba43ec9f8a4066614fe0f`. Le vérificateur de remboursement est identique pour ces exécutions, `4ef30d28fdf3fcaa6545ff4f865b6580e793e4a8ac7fd73fb133dc5ca90ffa8b`.

La preuve de récupération s'arrête à l'UTXO confirmé sur la destination choisie avant financement. La clé de cette destination était elle aussi éphémère. La campagne ne démontre donc pas une dépense ultérieure par un bénéficiaire réel, la garde de sa clé, ni la disponibilité d'un dépositaire d'archives indépendant. Le contrôle de la feuille refund ne reconstruit pas à lui seul la feuille claim cachée dans la preuve de Merkle. Le nœud valide séparément le claim complet sur l'autre branche.

## Résultats natifs

Dans la première campagne Regtest, les deux nœuds ont validé la même histoire de 100 blocs avant le premier financement. A a confirmé le claim. B a conservé l'UTXO sur sa branche. Au tip 103, le refund était prématuré. Au tip 104, il était admissible pour le prochain bloc. Après SIGKILL, B a retrouvé son genesis sur disque, a revalidé 104 blocs d'une archive de données publiques et a récupéré le même UTXO. L'envoi des octets présignés a payé 998 500 grains au destinataire convenu. Le bloc 105 a emporté la réorganisation de A. L'UTXO du claim a disparu et le refund est devenu canonique pour les deux processus. [Transactions et hash des blocs](research/2026-11-24/prl-native/regtest-first-excerpt.jsonl)

L'admission native a refusé un refund prématuré, une mauvaise préimage, une séquence temporelle insuffisante dans la transaction, une destination changée après signature, une sortie de 1 grain, des frais nuls et une dépense concurrente. L'appel RPC demandé à une hauteur future a renvoyé le code `-1`. Ces motifs sont contrôlés dans le harnais. La politique standard est explicitement activée par `--rejectnonstd`. Une exécution de diagnostic avec la politique Simnet par défaut a accepté le refund prématuré en mempool. Ce résultat à lui seul ne prouve aucune inclusion dans un bloc valable. [Diagnostic Simnet](research/2026-11-24/prl-native/default-simnet-policy.txt) · [Contrôles d'admission](../../asset-exchange/qualification/pearl/native/qualify.py)

En Simnet, le nœud a rejeté 154 grains de frais et admis 155 pour un claim de 155 vbytes. Sur une sortie P2TR il a rejeté 332 grains et admis 333. Un remplacement à 400 grains a échoué contre une transaction à 500. Celui à 4 000 grains a évincé la transaction originale et a été confirmé. Les cas aux seuils sont soumis à `testmempoolaccept`. Le remplacement positif est aussi soumis à `sendrawtransaction` puis recherché dans le bloc. [Journal Simnet complet](research/2026-11-24/prl-native/simnet.jsonl) · [Politique mempool amont](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/node/mempool/policy.go)

Les trois paquets Go de la version amont, `txscript`, `chaincfg` et `mempool`, passent. Les cas de politique couvrent le graphe d'ancêtres, les conflits directs maximaux, les entrées non confirmées et le plancher de frais sur un état UTXO de test. Les deux tests amont de génération de certificats TLS, `TestNewTLSCertPair` et `TestWriteTLSCertPair`, échouent ici lors de l'énumération des interfaces par Netlink. Le reste de `btcutil` passe. Le RPC du laboratoire utilise un mot de passe éphémère sur loopback. La validation TLS de production demeure ouverte. [Paquets Go](research/2026-11-24/prl-native/upstream-selected.txt) · [Cas de frais amont](research/2026-11-24/prl-native/upstream-fee-policy.txt) · [Échecs TLS](research/2026-11-24/prl-native/upstream-tls.txt) · [Autres cas btcutil](research/2026-11-24/prl-native/upstream-btcutil-portable.txt)

La suite intégrale `node/wire` passe aussi avec la bibliothèque Rust ZK compilée depuis la même révision et les caches de circuits v2 et v1. Les cinq tests de certificats initialement en échec sans la FFI ont donc été réexécutés avec leur dépendance native. [Échec sans FFI](research/2026-11-24/prl-native/go-wire-without-ffi.txt) · [Résultat avec FFI](research/2026-11-24/prl-native/upstream-wire-zkpow.txt)

## Nature des vérifications

| Catégorie | Exécution et portée |
|---|---|
| Statique | Syntaxe de 110 modules, lecture des migrations et des paramètres de consensus, vérification des chemins du diff. |
| Unitaire | Suites Go de Pearl et tests de validation d'Asset Exchange. |
| Doubles de test | Les 343 tests Node incluent des doubles de dépôts et de vérificateurs. Les 94 tests Python d'Exchange utilisent des fixtures hors ligne. |
| PostgreSQL natif | Processus PostgreSQL 16.16, transactions avec des clients séparés et rôles PostgreSQL réels. |
| Blockchain native | `pearld` v1.5.8 sur Regtest, avec PoUW, et séparément sur Simnet, avec le certificat simplifié du protocole. |
| Matériel physique | BLOCKED. Aucun appareil ou écran de confiance testé pour le contrat PRL. |

## Matrice de décision

| Étape | Décision | Propriété démontrée ou preuve encore nécessaire |
|---|---|---|
| P0 – provenance | PASS | Commit signé, release horodatée, empreinte du programme effectivement exécuté. |
| P1 – nœud et réseau | PASS | Deux nœuds officiels sur bases neuves, contrôle de magic, genesis, chaîne, pairs et maturité. |
| P2 – transactions et scripts | PASS | Signatures Schnorr, Taproot, preuve de feuille, CLTV, préimage, sérialisation et mutations vérifiées par la VM et le nœud. |
| P3 – lock, claim, refund | PASS | Financement confirmé après vérification du refund. Claim et refund confirmés sur des branches concurrentes. |
| P4 – frais, mempool et conflits | BLOCKED | Seuils mesurés et remplacement simple démontré. La robustesse du refund à frais fixes sous pression, aux dépendances de paquets et aux limites d'éviction n'est pas qualifiée sur le nœud complet. |
| P5 – réorganisation | PASS | Un claim confirmé est déconnecté par une branche plus longue. Deux répertoires et processus indépendants convergent sur le même UTXO. |
| P6 – récupération | PASS | Dans le modèle testé, un outil séparé et les octets présignés suffisent après perte du signataire, arrêt brutal du nœud et restauration de l'historique public. |
| P7 – API et PostgreSQL | PASS | Contrôles d'autorisation et de rejeu dans les suites Exchange, SQL natif 16.16, privilèges, courses et pertes de client sur cluster jetable. |
| P8 – signataire externe et matériel | BLOCKED | Le signataire logiciel éphémère utilise les primitives natives. Aucune application matérielle ou émulation officielle qualifiée pour les feuilles PRL, le réseau et l'affichage de ce refund. |
| P9 – audit et décision de production | BLOCKED | Revue indépendante, politique de frais de sortie, sécurité opérationnelle et validation matérielle restent ouvertes. |

Une démonstration BitGo de multisignature ou la présence du portefeuille logiciel Oyster ne valide pas l'affichage du réseau, de l'outpoint, du montant, de la destination, des frais et de la hauteur sur un dispositif indépendant. Aucun matériel physique n'a été utilisé. [Oyster](https://github.com/pearl-research-labs/pearl/blob/3db05e0de0ca90c3a043abd927b968cf53bcd4c8/wallet/README.md) · [Profil Pearl de BitGo](https://developers.bitgo.com/docs/pearl)

## Revue STRIDE

| Menace | Contrôle exercé et limite résiduelle |
|---|---|
| Usurpation | Authentification et liaison acteur/objet dans les tests API. Les garde-fous de laboratoire vérifient nom, magic, genesis et empreinte du nœud. Les observateurs dépendent encore du même hôte et du même binaire. |
| Altération | SIGHASH_ALL, vérification indépendante de l'intention, refus des mutations de destination, montant, réseau, préimage ou temporisation. L'opérateur doit conserver un canal indépendant pour l'empreinte et la capsule. |
| Répudiation | Empreintes, txid, hash des blocs, résultats d'idempotence et événements SQL relient les opérations. La perte de la réponse après commit a été exercée. Une conservation externe inaltérable reste à qualifier. |
| Divulgation | Les clés des utilisateurs sont absentes du protocole de test. Les clés de signature éphémères restent dans le processus initial, les capsules sont publiques. La préimage d'un claim devient publique dans son témoin. Les sauvegardes et la télémétrie d'une future exploitation exigent une revue. |
| Déni de service | Rejet des entrées malformées, contrôles de débit de l'API, concurrence SQL, erreur RPC, doubles dépenses, crash et réorganisation exercés. La saturation prolongée et le remboursement en marché de frais défavorable restent ouverts. |
| Élévation de privilèges | Contrôles IDOR/BOLA et sujet/session, requêtes paramétrées, triggers SQL et droits invoker. Un lecteur ne peut écrire. Le compte propriétaire peut administrer son schéma. Les ACL réelles et la séparation des opérateurs demandent une preuve opérationnelle. |

## Comparaison avec DOGE et décision

| Critère | Pearl | Référence DOGE |
|---|---|---|
| Primitives et cycle natif | P2TR/Tapscript, deux dépenses confirmées, clés éphémères et argent fictif. | Dogecoin Core 1.14.9, HTLC et validation native de scripts selon son propre consensus. Même famille de démonstration expérimentale sur deux protocoles distincts. |
| Reprise et observateurs | Perte du processus, restauration de l'historique public, séparation signataire/vérificateur, désaccord puis convergence. | Campagnes de cohérence et de reprise multi-observateurs plus étendues. Pearl couvre le cas borné décrit ici. |
| Frais, conflits et pinning | Seuils d'admission, remplacement simple et suite de politique mempool amont. | Campagnes dédiées sur des graphes de dépendances, nouvelles entrées non confirmées et frontières de remplacement à 100/101. Avance DOGE. |
| Signature externe | Signature logicielle et vérification cryptographique locale. | Application Ledger DOGE sous Speculos et contrôle libdogecoinconsensus, avec onze mutations rejetées. Le rapport DOGE laisse lui aussi D8 physique ouvert. |
| Audit et usage réel | P8 et P9 bloquent la production. | La référence DOGE laisse D9 ouvert. Aucune équivalence globale ni autorisation de règlement réel n'en découle. |

[Référence d'intégration DOGE](DOGE_INTEGRATION_2026-11-15.md) · [Frais et pinning](DOGE_FEE_PINNING_2026-11-11.md) · [Frontières RBF](DOGE_RBF_BOUNDARIES_2026-11-12.md) · [Récupération](DOGE_RECOVERY_CONSISTENCY_2026-11-13.md) · [Signataire émulé et consensus](DOGE_D8_STAGE3_NATIVE_CONSENSUS_2026-11-22.md)

Le registre conserve `MARKETPLACE_ONLY / RESTRICTED`, `identityReady=false`, `newOffersEnabled=false`, `newTradesEnabled=false` et `automaticSettlementSupported=false`. Le harnais est une commande autonome de qualification. La PR reste en brouillon. Le minage GPUbnb et les implémentations des autres actifs sont hors de son diff.
