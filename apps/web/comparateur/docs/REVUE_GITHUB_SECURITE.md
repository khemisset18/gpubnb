# Audit GitHub : projets libres utiles à GPUbnb Rentabilité (novembre 2026)

## Règle d'architecture

**Ne copier aucun code source, binaire, benchmark ou donnée depuis un dépôt tiers sans analyse de licence adaptée.** Les liens ici ne sont que des références techniques et de sécurité. Les collecteurs et moteurs GPUbnb créés dans cette PR sont écrits indépendamment. Tout reste sous \`apps/web/comparateur/\`.

Une licence « open source » n'équivaut pas à « sans obligations », et un logiciel qui mine peut cacher des **frais/dons de développeur** ou nécessiter des privilèges système. Notre comparateur **ne télécharge pas, n'installe pas et ne lance aucun mineur**.

## Dépôts vérifiés

| Projet officiel | Domaine qui nous intéresse | Licence GitHub annoncée | À retenir pour GPUbnb |
|---|---|---|---|
| [xmrig/xmrig](https://github.com/xmrig/xmrig) | RandomX, benchmarks CPU, interfaces de mesure | GPL-3.0 | Architecture des mesures réelles H/s, fenêtres d'échantillonnage, algorithmes nommés. **Ne pas réutiliser la base de benchmarks publique sans droits spécifiques**. Le README annonce un **don par défaut de 1 %** du temps de minage, non « zéro frais ». |
| [RavenCommunity/kawpowminer](https://github.com/RavenCommunity/kawpowminer) | Benchmarks GPU KawPoW/OpenCL/CUDA | GPL-3.0 | Différencier unités, époque/DAG, GPU et version du mineur. Éviter toute redistribution des binaires ou inclusion de code GPL dans le comparateur sans étude. |
| [RavenProject/Ravencoin](https://github.com/RavenProject/Ravencoin) | Nœud RVN, RPC blockchain, coinbase, getnetworkhashps | MIT | Favoriser des RPC de nœuds auto-hébergés, bloqués en loopback. Vérifier l'API sur la version officielle installée. |
| [etclabscore/core-geth](https://github.com/etclabscore/core-geth) | Nœud ETC, eth_chainId 61, bloc/ difficulté / timestamp | LGPL-3.0 | Recommandation pour les observateurs ETC. Le README avertit de n'installer que les versions du dépôt officiel et de **vérifier les SHA-256** des archives. |
| [ergoplatform/ergo](https://github.com/ergoplatform/ergo) | Nœud Ergo, Autolykos v2, règles d'émission | GitHub : CC0-1.0 (vérifier par fichier et dépendances) | Contrôler difficulté, réémission EIP-27 et récompenses effectivement attribuées avant d'automatiser ERG. |
| [RunOnFlux/flux](https://github.com/RunOnFlux/flux) | Console/ API Flux, interaction avec daemon Flux | AGPL-3.0 | **C'est une interface de gestion Flux, pas une API libre de rentabilité à recopier.** Éviter d'intégrer son code dans GPUbnb ; étudier seulement les RPC du daemon et la part PoW de la récompense. |
| [minernl/miningcore](https://github.com/minernl/miningcore) | Pool Stratum, mesures et frais de pools | MIT (GitHub) | Pas un simple catalogue de benchmarks ; requiert infra pool. Son README annonce un **don intégré de 0,1 % par récompense de bloc** ; ne pas installer juste pour obtenir des chiffres. |
| [oliverw/miningcore](https://github.com/oliverw/miningcore) | Ancien backend de pool, méthodes PoW/paiements | MIT | Dépôt **archivé** ; ne pas baser un backend de production sur un projet non maintenu. |

**Important** : les labels SPDX ci-dessus proviennent de la métadonnée GitHub et doivent être comparés aux fichiers de licence et aux dépendances avant tout téléchargement/distribution. Les crédits éventuels, attribution, obligations GPL/LGPL/AGPL et modifications de source dépendent de l'utilisation. **Nous ne vendons ni n'incorporons ces dépôts actuellement.**

## Bonnes idées à reprendre de façon indépendante

1. **Benchmark mesuré** : unité et algorithme par appareil, horodatage, durée d'échantillon, watts à la prise ; ne pas confondre TDP et consommation réelle du rig.
2. **Nœud isolé** : RPC avec écoute uniquement sur \`127.0.0.1\` ou socket privée. Pas de SSH, RPC ou credentials de minage distribués au navigateur. Pas de \`0.0.0.0\`, pas de \`rpcallowip=*\`.
3. **Chain ID / consensus** : vérifier mainnet, synchronisation, hash/parent/hauteur, horodatage, fenêtres de blocs, reorgs, reward mineur vs reward réseau.
4. **Fail closed** : si un nœud est indisponible ou la source trop ancienne, **aucun rendement indiqué comme live**. Même règle pour toute erreur de devise ou d'algorithme.
5. **Licences et origine** : seuls les jeux de données dont GPUbnb détient les droits sont publiables. Un dépôt public n'est pas une licence pour aspirer ses benchmarks.
6. **Respect des utilisateurs** : aucune collecte automatique, aucun accès à GPUbnb Host ou à leurs machines ; futures contributions uniquement avec consentement explicite vérifié et contrôles anti-fraude.
7. **Moteur sans code tiers** : conserver nos propres bibliothèques \`pow-yield.mjs\`, \`monero-direct.mjs\` et \`owned-benchmarks.mjs\`, sans \`npm install\` ni paquets payants.

## Travail original ajouté

### Base de mesures GPUbnb

- \`lib/owned-benchmarks.mjs\` valide les hashrates, unités, algorithmes, watts à la prise, durée minimale 5 minutes, appareil unique, date et consentement.
- Des champs étrangers tels qu'adresse IP, email, adresse de wallet, numéro de série ou mot de passe **ne passent pas** dans l'objet publié.
- Les contributions externes *ne sont pas acceptées automatiquement*. Le consentement ne peut pas être vérifié par un simple booléen dans un fichier JSON ; la première version accepte exclusivement des mesures opérateur/laboratoire de GPUbnb, pas des uploads anonymes.
- \`data/owned-benchmarks.json\` est un fichier **vide**. Nous n'empruntons **aucune** valeur des bases de benchmarks tiers.

**Limites** : le format JSON ne prouve pas cryptographiquement un benchmark. Un responsable GPUbnb devra approuver une mesure et en conserver une preuve privée hors du site public. Le champ \`watts\` représente **le rig complet à la prise**, pas un TDP constructeur ; ne pas mélanger les deux dans les classements. Le champ \`consentToPublish\` requis pour valider localement est supprimé du fichier public car il ne constitue pas une preuve d'accord.

### Vérifications proposées avant production

\`\`\`bash
node --test apps/web/comparateur/tests/*.test.mjs
\`\`\`

Puis vérifier les scripts RPC sur des **nœuds de test que nous contrôlons**, leur journalisation, les permissions de fichiers, les réponses anormales, les rollbacks de chaîne et les nouvelles versions de logiciel. Les tests ne remplacent pas un audit du déploiement réel.

## Décision

GPUbnb doit **s'inspirer des protocoles et des méthodes**, pas prendre le code et les données brutes d'autres projets. Le chemin le moins dépendant est : **mesures volontaires que nous réalisons + propre nœud blockchain + calcul propriétaire + cours EUR manuel**. Cela évite un abonnement de données mais n'annule pas les dépenses de matériel, énergie et hébergement.

Tous les résultats restent en **PR brouillon**. Fusion, déploiement, lancement de mineur, installation de nœud et interactions avec le site principal nécessitent un accord explicite.
