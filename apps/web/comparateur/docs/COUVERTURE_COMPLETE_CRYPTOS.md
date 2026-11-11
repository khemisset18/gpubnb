# GPUbnb Rentabilité — catalogue complet, 14 cryptomonnaies

Vérification : novembre 2026. **Cette liste est propre au comparateur \`apps/web/comparateur/\` dans la PR #353**. Les modules GPUbnb Host et les profils de minage existants ont été consultés en lecture seule, mais pas modifiés. Une monnaie affichée dans le comparateur **n'est PAS automatiquement installable, exploitable ou déjà activée par GPUbnb Host**.

## Sources internes recoupées

1. **GPUbnb Host desktop** : \`apps/host-desktop/src/main.ts\` répertorie **XMR, PRL, ALPH, KAS, ETC, CFX, RVN, NEOX**. PRL, KAS et NEOX n'ont **pas** de profil de minage prêt à lancer dans ce catalogue. Le champ \`hardwareValidated\` n'est renseigné que pour certains modèles.
2. **Page web du minage** : \`apps/web/mining.js\` répertorie **XMR, RVN, ETC, ERG, FLUX**. Ce module configure des ressources et ne constitue pas notre source de données économiques.
3. **Catalogue de profils natifs** : \`apps/host-desktop/src-tauri/src/mining_catalog.rs\` mentionne aussi **BEAM et CTXC**, plusieurs profils \`enabled:false\`, et quelques profils \`enabled:true\`. Les autorisations d'exécution natif restent entièrement contrôlées par Host.
4. **Demande explicite du propriétaire** : ajouter **BTC et ZEC**, absents des catalogues ci-dessus.

## Ce que calcule le comparateur

| Crypto | Algorithme | Matériel pertinent | Formule du comparateur | Réseau auto gratuit |
|---|---|---|---|---|
| **XMR – Monero** | RandomX | CPU, avec ASIC spécialisés existants | Difficulté + récompense + H/s mesurés | **Prototype** sources publiques en quorum, 24 h de repli, aucun service déployé |
| **PRL – Pearl** | PearlHash, Proof of Useful Work (PoUW) | GPU, charge de calcul IA | **Projection de gains PRL réellement observés dans un pool**, par durée mesurée | **Non** : ne pas remplacer par un faux hashrate SHA/KawPoW |
| **ALPH – Alephium** | Blake3 | ASIC dominant | Part de réseau, récompense *totale du réseau toutes chaînes confondues* et blocs correspondants | Non, mesures manuelles |
| **KAS – Kaspa** | kHeavyHash | ASIC dominant | Part de réseau avec H/s ASIC | Non, mesures manuelles |
| **ETC – Ethereum Classic** | Etchash | GPU / ASIC | H/s réseau, blocs, récompense mineur seulement | **Prototype** RPC publics principal + secours |
| **CFX – Conflux** | Octopus | GPU | Modèle PoW théorique, mais **Tree-Graph exige des statistiques de récompenses validées**, pas un simple temps supposé | Non, mesures manuelles |
| **RVN – Ravencoin** | KawPoW | GPU | H/s réseau + mineur + récompense moyenne | **Prototype** un fournisseur public |
| **NEOX – Neoxa** | KawPoW | GPU | H/s réseau + **uniquement 20 %** de la subvention totale versés aux mineurs (part proportionnelle effective) | Non, mesures manuelles |
| **ERG – Ergo** | Autolykos v2 | GPU | H/s + récompense mineur réelle après les règles de réémission | Non, mesures manuelles |
| **FLUX – Flux** | FluxHash / famille Equihash | GPU | Sol/s + **récompense mineur PoW**, hors FluxNodes | Non, mesures manuelles |
| **BEAM – Beam Mimblewimble** | BeamHash III | GPU | Sol/s, pas un hashrate KawPoW | Non, mesures manuelles |
| **CTXC – Cortex** | Cuckatoo32 | GPU à VRAM suffisante | Graph/s, pas H/s ni Sol/s | Non, mesures manuelles |
| **BTC – Bitcoin** | SHA-256 | **ASIC spécialisé** | H/s réseau + ASIC, frais et coûts énergétiques | Non, mesures manuelles |
| **ZEC – Zcash** | Equihash (200,9) | **ASIC spécialisé** | Sol/s réseau + ASIC Equihash 200,9 | Non, mesures manuelles |

Les champs de mesure ne sont **pas** préremplis avec des rendements inventés : sans données fiables ou saisie volontaire, **aucun chiffre de rentabilité** n'est calculé.

## Projections, limites et transparence

Le moteur produit les quantités estimées en crypto par jour, mois (30 j) et an (365 j). Le cours crypto/EUR est **manuel** tant qu'aucune source de prix à droits commerciaux compatibles n'est validée. Le bénéfice net tient compte des watts saisis, de la durée quotidienne, du coût en €/kWh et du pourcentage des frais de pool.

Les estimations **ASIC** demandent les watts et le hashrate propres à l'ASIC, jamais ceux de la carte graphique sélectionnée. Une machine SHA-256 n'est pas compatible avec l'Equihash Zcash, ni avec Blake3 ou kHeavyHash.

**Cas Pearl :** plutôt que de traiter les calculs IA Pearl comme du hashrate réseau générique (ce qui est trompeur), le comparateur utilise \`PRL bruts observés par GPU / heures de minage mesurées\`. Cette projection d'un historique de pool n'est **pas** une estimation de la probabilité future d'un bloc, ni une rémunération garantie ; pour un solo mineur la variance peut être extrême. Si le pool annonce un paiement déjà net de frais, mettre les frais de pool du calculateur à **0 %** pour ne pas soustraire deux fois.

**Cas Neoxa :** les mineurs ne touchent que **20 % de la récompense** ; 60 % vont aux smartnodes et 20 % au projet. La saisie \`récompense mineur / bloc\` doit être la part mineur, et non la subvention totale.

**Cas Alephium :** 16 chaînes (4 groupes), compter une seule fois les blocs et le taux de réseau dans le dénominateur.

**Cas Bitcoin / Zcash / Kaspa / Alephium :** la rentabilité sur GPU ou CPU n'est généralement pas représentative du minage ASIC dominant. Leur présence dans le comparateur ne les ajoute pas comme profils exécutables GPUbnb Host.

**Cas BEAM :** ici « BEAM » désigne Beam Mimblewimble, pas le jeton de jeu homonyme.

## Disponibilité et maintenance

Le plan d'automatisation séparé sur Cloudflare prévoit une tentative de mise à jour **toutes les deux heures**. Seuls **XMR, RVN, ETC** disposent à ce jour de collecteurs de blockchain publique expérimentaux. Les autres monnaies attendent un adaptateur ou un flux autorisé avant d'afficher des données réseau automatiques. **Il serait inexact de promettre une automatisation des 14 monnaies à ce stade.** Aucune source publique n'offre de garantie de disponibilité ou de redistribution commerciale sans conditions.

Les sources de secours sont configurées **pour XMR et ETC** seulement ; RVN n'a pas encore de source secondaire indépendante validée. En cas de panne de toutes les sources disponibles, la dernière mesure validée reste exploitable **24 h maximum** depuis sa collecte, puis « Service indisponible ».

## Tests et déploiement

\`\`\`bash
cd apps/web/comparateur
npm test
\`\`\`

Contrôles : 14 entrées uniques (dont 13 dans le panneau multi-crypto + le panneau XMR), unités algorithmiques cohérentes, passage ASIC jusqu'à 20 kW, rentabilité PRL fondée exclusivement sur observations du pool, impossibilité d'appliquer la formule PoW classique à PRL, validation de frais et de valeurs invalides.

**Aucune intégration, aucun minage, aucun accès à un portefeuille ou un appareil d'un utilisateur** n'est réalisé par ce comparateur. Pas d'ajout d'outils aux autres modules ; **aucune fusion sans accord explicite du propriétaire**.

## Références de protocole consultées

- Pearl, official : https://help.pearlresearch.ai/hc/en-us/articles/49191239541905-How-mining-on-Pearl-works
- Pearl et Bitcoin : https://help.pearlresearch.ai/hc/en-us/articles/49190498708113-How-Pearl-differs-from-Bitcoin
- Zcash : https://zcash.readthedocs.io/en/master/rtd_pages/zcash_mining_guide.html
- Kaspa : https://wiki.kaspa.org/mining
- Alephium : https://docs.alephium.org/mining/
- Neoxa : https://neoxa.net/mining/
- Beam : https://www.beam.mw/mining
- Conflux : https://f2pool.zendesk.com/hc/en-us/articles/22914747306521-How-to-mine-Conflux
