# GPUbnb · 5 cryptomonnaies minables — moteur indépendant, sans API commerciale

**Situation : 11 novembre 2026.** Cette extension n'est présente que dans \`apps/web/comparateur/\` sur la PR #353. Rien n'est fusionné ou déployé.

## Cryptos constatées dans la configuration existante de GPUbnb

La page actuelle \`apps/web/mining.js\` propose des profils pour XMR, RVN, ETC, ERG et FLUX. Ce fichier **n'a pas été touché** : le tableau sert seulement de périmètre fonctionnel à notre comparateur.

| Crypto | Algorithme | Minage | Calcul de rentabilité | Collecteur depuis notre nœud |
|---|---|---|---|---|
| Monero (XMR) | RandomX | CPU favorisé | quantité de XMR + prix EUR manuel | Préparé via \`monerod\` local, 30 blocs |
| Ravencoin (RVN) | KawPoW | GPU | quantité de RVN + prix EUR manuel | **Prototype** \`ravend\` local, 32 blocs + \`getnetworkhashps\` |
| Ethereum Classic (ETC) | Etchash | GPU / ASIC | quantité de ETC + prix EUR manuel | **Prototype** Core-Geth ETC local (chain ID 61), 32 blocs + ECIP-1017 |
| Ergo (ERG) | Autolykos v2 | GPU | quantité de ERG + prix EUR manuel | **Non implémenté** : récompenses/réémission et difficulté à valider avant toute mesure automatique |
| Flux (FLUX) | FluxHash / Equihash* | GPU | quantité de FLUX + prix EUR manuel | **Non implémenté** : la part PoW destinée aux mineurs doit être isolée des récompenses FluxNodes |

*GPUbnb possède aujourd'hui un ancien profil appelé « ZelHash ». La terminologie et la compatibilité du logiciel mineur avec la version actuelle de Flux doivent être revalidées AVANT lancement réel du minage, sans modifier le module de minage ici.*

**Statut réel** : les calculs génériques des quatre cryptos GPU ont été ajoutés et vérifiés avec des jeux de données synthétiques. Les collecteurs RVN et ETC **n'ont pas été testés contre des nœuds réels** ; ne pas les présenter comme des données live prêtes pour la production. XMR a un outil de collecte existant, non déployé.

## Logique mathématique commune : part du réseau

Pour une configuration et un algorithme précis, si nous avons des mesures fiables :

\`\`\`text
part_du_reseau = (hashrate_appareil × nombre_appareils) / hashrate_reseau
blocs_mines_esperes_par_jour = part_du_reseau × (86400 / secondes_moyennes_par_bloc) × (heures_par_jour / 24)
coins_par_jour = blocs_mines_esperes_par_jour × recompense_mineur_par_bloc
brut_EUR_par_jour = coins_par_jour × prix_coin_EUR_saisi_manuellement
cout_energie_EUR_par_jour = watts_par_appareil × appareils × heures / 1000 × EUR_par_kWh
net_EUR_par_jour = brut_EUR - frais_pool_EUR - cout_energie_EUR
mensuel = journalier × 30 ; annuel = journalier × 365
\`\`\`

Pour Monero, le module spécialisé utilise directement la difficulté, la récompense par bloc et le hashrate. Les autres monnaies utilisent leur **hashrate réseau** et un **temps moyen par bloc observé** (pas une constante universelle).

**IMPÉRATIF :** GPU et réseau doivent utiliser **le même algorithme et les mêmes unités** : \`H/s\` pour RVN, ETC, ERG ; \`Sol/s\` pour Flux. Les H/s de RandomX ne se comparent pas aux H/s de KawPoW, et encore moins aux Sol/s de Flux.

## D'où viennent les données ?

En mode gratuit, seul notre propre logiciel (ou une saisie manuelle) fournit les chiffres :
- **Hashrate de l'appareil** : uniquement une mesure réelle pour le bon algorithme (aucun catalogue de hashrates tiers recopié).
- **Hashrate réseau, intervalle et récompense mineur** : saisis manuellement dans la page, ou générés côté serveur par un nœud local validé.
- **Cours en euros** : uniquement saisi manuellement. Les blockchains ne donnent pas un cours de marché XMR, RVN, ETC, ERG ou FLUX en EUR.
- **Coûts** : électricité, consommation, frais et nombre d'appareils déjà saisis dans le calculateur GPUbnb.

Un résultat **sans cours fiat** est affiché en coins minables théoriquement, sans net en euros. Un résultat sans mesures réseau ou sans hashrate mesuré reste vide.

Les quantités et bénéfices sont des **espérances théoriques**, pas des paiements garantis : rentabilité réelle affectée par frais, minage solo vs pool, variance, blocs orphelins, fees/MEV, liquidité de la monnaie, prix, matériel et interruptions. Ne jamais présenter cela comme une promesse de revenu.

## Collecteur expérimental ETC : données depuis Core-Geth LOCAL

Node.js 22+, client **ETC mainnet** synchronisé sur \`127.0.0.1:8545\`. Aucune dépendance à un fournisseur tiers de benchmarks.

\`\`\`bash
node apps/web/comparateur/tools/build-etc-snapshot.mjs
\`\`\`

L'outil interroge \`eth_chainId\` (61 / \`0x3d\`), \`eth_syncing\` (false), \`eth_blockNumber\`, puis \`eth_getBlockByNumber\` sur 33 blocs. Il rejette une séquence discontinue et un bloc final périmé. Il calcule la moyenne du travail des 32 intervalles, et **uniquement la subvention de base ETC** selon ECIP-1017 : départ 5 ETC, réduction 20 % tous les 5 millions de blocs. Les **frais de transaction, les récompenses d'oncles et le MEV ne sont pas inclus** : estimation prudente, pas revenu complet.

Ce script exige un nœud local opérationnel, et ne déploie ni n'installe celui-ci.

## Collecteur expérimental RVN : données depuis ravend LOCAL

Node.js 22+, client **RVN mainnet** synchronisé sur \`127.0.0.1:8766\`. La connexion RPC utilise uniquement des identifiants définis **dans l'environnement privé** du processus, jamais dans le JS public ni dans Git.

\`\`\`bash
# définir RVN_RPC_USER et RVN_RPC_PASSWORD dans l'environnement local privé
node apps/web/comparateur/tools/build-rvn-snapshot.mjs
\`\`\`

L'outil lit \`getblockchaininfo\`, \`getnetworkhashps\` (fenêtre de 120 blocs), \`getblockhash\` et \`getblock\` (verbosity 2) sur 33 blocs. Il valide la continuité, la présence du coinbase et ses sorties monétaires, puis utilise la moyenne des 32 récompenses RVN réellement observées **incluant les éventuels frais natifs de bloc**. Il ne peut pas garantir une moyenne exacte des périodes futures.

> Important : ne pas exposer le RPC ou les identifiants du nœud sur Internet. Les chemins et valeurs RPC doivent être validés avec la version locale de \`ravend\`. Le collecteur n'a pas encore été exécuté contre un daemon réel.

## Flux : précaution supplémentaire

Le protocole attribue une fraction de la rémunération aux **opérateurs FluxNodes**. Le champ \`minerRewardCoins\` attend la part réelle **reçue par un mineur PoW**, pas la subvention totale annoncée. N'utiliser \`Sol/s\` que pour la **version actuelle de l'algorithme FluxHash** et mesurer les performances réellement compatibles. Ne pas inférer une récompense mineur à partir d'un simple chiffre de supply totale.

## Ergo : précaution supplémentaire

Le protocole Ergo et sa réémission EIP-37, les frais et la storage rent nécessitent une lecture précise du revenu mineur. Il existe bien des routes de nœud local (port 9053), mais l'adaptateur réseau doit être testé avant toute activation ; **le mode manuel est la seule option actuellement implémentée**.

## Contrat de données statiques

Le fichier \`data/pow-reseaux.json\` reste **vide et volontairement non live** dans le dépôt :

\`\`\`json
{ "schemaVersion": 1, "networks": [] }
\`\`\`

Chaque collecteur peut y écrire une observation validée avec : \`coin\`, \`algorithm\`, \`unit\`, \`networkRate\`, \`blockSeconds\`, \`minerRewardCoins\`, \`blockHeight\`, \`collectedAt\`, \`blockTimestamp\`, \`methodology\`, \`source: "own-node"\`, \`network: "mainnet"\`, \`schemaVersion: 1\`.

Le comparateur accepte seulement des valeurs valides, **de moins de 20 minutes** et provenant du pipeline de publication du propriétaire. Les scripts de collecte lisent des nœuds locaux mais le fichier produit ne sera visible sur le site qu'après **publication de l'instantané sur l'hébergement**, à mettre en place séparément et uniquement après tests.

Les deux scripts écrivent par renommage atomique et doivent être exécutés **séquentiellement**, pas simultanément, pour éviter qu'un collecteur écrase les données de l'autre.

### Vérifications sans service externe

\`\`\`bash
node --test apps/web/comparateur/tests/*.test.mjs
\`\`\`

Les nouveaux tests ciblent l'exactitude des unités, du résultat net, des réseaux erronés, des échantillons invalides, des dates périmées et des règles de récompense.

**Il n'y a aucun abonnement, aucun accès tiers commercial et aucune clé API payante dans cette PR.** Les nœuds et la collecte ont cependant un **coût réel d'exploitation** et les outils de nœud sont régis par leurs licences logicielles. L'objectif « aucune facture de données externes » est possible, mais **pas zéro coût d'infrastructure ni couverture automatique immédiate des cinq monnaies**.

## Documentation technique utilisée

- Profils internes GPUbnb : \`apps/web/mining.js\` (consulté, non modifié).
- Monero PoW : https://web.getmonero.org/get-started/mining/
- Ravencoin : https://ravencoin.org/pools/ et source RPC https://github.com/RavenProject/Ravencoin/blob/master/src/rpc/blockchain.cpp
- Ethereum Classic : https://ethereumclassic.com/research/supply et https://ethereumclassic.com/mining
- Ergo node REST et mineurs : https://docs.ergoplatform.com/node/swagger/ et https://www.ergoblockchain.org/docs/miners
- Flux API et partage récompenses : https://docs.runonflux.io/fluxapi/daemon/ et https://new.runonflux.io/nodes

## Garantie de périmètre

La PR **ne modifie rien en dehors de** \`apps/web/comparateur/\`. Aucun déploiement, aucune fusion. Avant toute modification de production, accord explicite du propriétaire.
