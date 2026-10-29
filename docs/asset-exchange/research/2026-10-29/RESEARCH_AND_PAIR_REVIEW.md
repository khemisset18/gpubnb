# Lot A — revue des implémentations et des dix paires

État : recherche de code effectuée, validation inter-chaînes non exécutée.
Les versions, 68 fichiers inspectés, URLs immuables, licences et SHA-256 sont
inventoriés dans [SOURCE_INVENTORY.json](SOURCE_INVENTORY.json). Les tests
upstream ont été lus : leur présence ne signifie pas qu'ils ont réussi ici.
Cette revue ciblée n'est ni un audit exhaustif ni une preuve cryptographique.

## Versions effectivement examinées

| Projet | Version et commit | Observation utile |
| --- | --- | --- |
| Dogecoin | v1.14.9, e0a1c157791544e818c901bd9341896965afbf9d | Source de confiance D0 conservée ; aucun nouveau processus DOGE |
| DCRDEX/Bison Wallet | v1.0.5, 37585833528544f80dddd92dcdff10a78ad01e1f | Drivers client/serveur BTC, DOGE, LTC, BCH et moteur HTLC commun |
| DCRDEX développement | fc63460615e8dca83fc19520f32a1cb00be4acfa | XMR ajouté comme portefeuille ; Swap/Redeem/Refund renvoient ErrUnsupported |
| BasicSwap | v0.19.1, de61f913cbe7c9289dcc735df505daa6f8b19385 | Même tête master observée ; adaptateurs des cinq actifs, restrictions par rôle |
| COMIT | 1.0.0-rc.1, a2cc3591b158e6695f318f4b816068cd5a9ad7be | Référence BTC–XMR, états persistés et chemins cancel/refund/punish séparés |
| Komodo DeFi Framework | 9b3fd7026e9e5ad4c8bd2cba5a5499cecba8d957 | URL redirigée vers GLEECBTC ; archive, maintenance annoncée arrêtée depuis avril 2026 |

DCRDEX stable ne contient pas de driver XMR. Sa tête de développement distingue
explicitement le wallet de la capacité de trading : aucune paire XMR ne peut
être déclarée implémentée sur cette seule base.

BasicSwap n'utilise pas un HTLC identique pour tout actif. Son mode adaptor
exige une jambe de script appropriée. DOGE et XMR figurent tous deux dans sa
catégorie interne scriptless. La fonction validateSwapType rejette DOGE→XMR et
XMR→DOGE. Un contrôle hors ligne des deux seules méthodes pures de sélection,
extraites par AST de la source épinglée, confirme ce rejet sur les vingt sens
possibles : [résultats](BASICSWAP_OFFLINE_TYPE_PROBE.json). Aucune initialisation
de wallet, signature, transaction ou connexion n'a eu lieu. Les dix-huit autres
admissions sont seulement des admissions de type, pas des swaps réussis.

## Dix combinaisons, deux sens conservés

Les **vingt fiches détaillées** se trouvent dans
[PAIR_MATRIX_20_DIRECTIONS.json](PAIR_MATRIX_20_DIRECTIONS.json), avec profils
wallet/RPC/signatures/frais, restrictions, disponibilité, tests et lacunes.
Une direction désigne coin_from→coin_to de l'offre ; elle ne désigne pas
nécessairement l'ordre de verrouillage. Le rôle script-capable peut imposer une
inversion du leader et du follower.

| Paire | DCRDEX | BasicSwap | Limite décisive pour GPUbnb |
| --- | --- | --- | --- |
| BTC–DOGE | Code HTLC observé, marché à configurer | Tests de swap/recovery dans extended/test_doge.py, dont sens inversé | DOGE reste D0/D1 ; aucune transaction qualifiée |
| BTC–LTC | Code HTLC observé | Test SELLER_FIRST BTC→LTC en regtest ; mode adaptor distinct à confirmer | Pas d'extrapolation au mode de production ni à MWEB |
| BTC–BCH | Drivers et signature BCH spécifique observés | Chemins adaptor/covenant ; paire exacte non démontrée par notre lecture des tests | ForkID, frais et rôle BCH à qualifier |
| DOGE–LTC | Drivers observés | Chemin autorisé par le validateur ; pas de test exact identifié | Ne pas assimiler admission de type et atomicité |
| DOGE–BCH | Drivers observés | Chemin autorisé, BCH spécifique ; pas de test exact identifié | Pas de recette générique Bitcoin à copier |
| LTC–BCH | Drivers observés | Chemin autorisé ; pas de test exact identifié | Transparence LTC et covenant/sighash BCH à prouver |
| BTC–XMR | Trading XMR absent/partiel | Code et tests btc_xmr + récupération observés | Cryptographie inter-courbes et disponibilité obligatoires |
| DOGE–XMR | Trading XMR absent/partiel | Rejet explicite dans les deux sens | Objectif de paire directe non couvert par ces composants |
| LTC–XMR | Trading XMR absent/partiel | Code et tests ltc_xmr observés | Profils signers, frais, redémarrage et deux rôles non testés chez GPUbnb |
| BCH–XMR | Trading XMR absent/partiel | Tests bch_xmr, sens inversé et remboursements observés | Construction BCH dédiée ; aucune preuve GPUbnb |

« Code observé » indique une implémentation examinée dans un dépôt non archivé,
non une exécution réussie ni une garantie de liquidité. Les classes exactes
requises par la mission figurent dans chaque fiche JSON. Aucune des paires
n'acquiert une nouvelle capacité GPUbnb. Un détour par BTC représenterait deux
swaps et un risque intermédiaire ; il ne résout pas silencieusement une paire
DOGE–XMR atomique directe.

## Composants intéressants et écarts à traiter

DCRDEX : construction/extraction des contrats, audit du contrat contre les
termes, détection du secret dans le spend, réservation des UTXO et suivi des
tips sont de bons points de comparaison. Le moteur BTC prépare des refunds
avant son broadcast ; cela ne prouve pas la persistance indépendante chez
GPUbnb, ni la stabilité du txid DOGE. Le carnet/matching serveur et les wallets
clients forment des limites de confiance distinctes. Les politiques de bonds,
réputation et pénalités upstream ne sont pas reprises.

BasicSwap : transactions de récupération pré-négociées, clés partagées,
OtVES/DLEAG, persistance et réarmement des watchers après redémarrage sont les
axes à auditer. Le code BCH utilise des covenants et une convention de frais
absolus sur certains chemins ; has_segwit() y vaut true pour le routage interne,
sans que BCH possède SegWit. Cela interdit de convertir ce booléen en capacité
consensus GPUbnb. Le messaging SMSG/Particl et les nouveaux transports documentés
Nostr/SimpleX ajoutent chacun configuration, disponibilité et surface d'attaque.
Aucun transport upstream n'est démarré.

COMIT et la publication Gugger décrivent des protocoles avec annulation puis
remboursement et issue tardive alternative. Le paiement tardif à l'autre partie
n'est pas un remboursement du principal d'origine à son propriétaire. Une
indisponibilité prolongée peut donc faire perdre des droits ; ces chemins ne
sont pas adoptés sous une promesse de remboursement universel. Ils ne justifient
aucune pénalité commerciale d'annulation GPUbnb.

KDF est conservé comme référence historique d'interfaces/orderbook/persistance.
Son état archivé et son avis de licence spécifique le disqualifient comme
moteur maintenu choisi par défaut pour cette mission.

## Références protocolaires et limites de recherche

BIP65 et BIP112 décrivent des règles Bitcoin, qui nécessitent leur activation
sur la chaîne cible. BIP125 est une politique de remplacement ; BIP199 est
**Closed**, pas un certificat d'implémentation universelle. Leurs versions et
licences sont épinglées dans l'inventaire.

Herlihy, *Atomic Cross-Chain Swaps*, arXiv:1801.09515v4, apporte le modèle de
coordination et ses hypothèses ; il ne certifie pas les scripts ou réseaux de
GPUbnb. Gugger, ePrint 2020/1126 (révision du 18 novembre 2020), examine le lien
inter-courbes et les signatures chiffrées. Hoenisch/Soriano del Pino,
arXiv:2101.12332v2, expose les limitations des swaps BTC–XMR. Le blog technique
COMIT du 6 octobre 2020 documente une course redeem/refund corrigée, utile comme
contre-exemple à une simplification non auditée.

Sources : https://arxiv.org/abs/1801.09515v4 ;
https://eprint.iacr.org/2020/1126 ; https://arxiv.org/abs/2101.12332v2 ;
https://comit.network/blog/2020/10/06/monero-bitcoin/ .
Les pages officielles BasicSwap/Particl ont été consultées mais leurs annonces
ne sont pas utilisées comme preuve d'une paire ou d'une propriété de sécurité.
L'inventaire de 68 fichiers est traçable ; les dépendances transitives complètes,
la maintenance de chaque composant natif et les preuves formelles indépendantes
restent à examiner avant toute intégration de code externe.

La préparation exacte des binaires/wallets des tests upstream n'a pas été
reproduite ni validée contre l'archive D0 GPUbnb. Les dépendances de packaging
et sous-modules externes non inspectés restent des gaps ; les tests BasicSwap
cités ne sont pas une preuve de compatibilité bit à bit ou RPC avec notre
Dogecoin v1.14.9 qualifié.

### Écart critique de baseline DOGE BasicSwap

La préparation a ensuite été inspectée dans
`basicswap/interface/doge/core.py` : défaut DOGECOIN_VERSION=23.2.1,
core_version_group=23, téléchargement depuis tecnovert/dogecoin et signatures
du fournisseur de ce fork. Ce n'est pas le Dogecoin officiel v1.14.9 de D0.
Les réglages use_csv/use_segwit restent false, mais cela ne prouve pas la
compatibilité RPC/signer de la baseline GPUbnb. Aucune clé, URL de release,
archive ou identité de ce fork n'est adoptée. Pour chaque paire DOGE, le support
upstream reste conditionné à son propre environnement ; son report chez GPUbnb
est explicitement non démontré. Tout changement de nœud/trust route exigerait
une décision séparée, une nouvelle revue et une requalification complète.
