# GPUbnb Rentabilité — secours multi-sources automatique

Date de l'étude : novembre 2026. **Uniquement dans la PR #353**, sous \`apps/web/comparateur/\`. Pas de fusion, pas de déploiement du site principal.

## Règle approuvée

À chaque actualisation planifiée **toutes les heures**, interroger **d'abord la source principale**.
Si elle répond correctement avec des données complètes, vérifiées et récentes, elle est retenue.
Sinon, essayer automatiquement les sources de secours en ordre de priorité. Une source de secours ne devient active **que si ses données passent les mêmes validations** (réseau correct, cohérence des blocs, horodatage et récompenses).

**Retour vers la principale :** dès qu'elle répond à nouveau **et réussit la validation** au prochain cycle (au prochain cycle horaire prévu, pas immédiatement à la seconde près), elle redevient prioritaire. Un exploitant n'a pas à sélectionner manuellement un fournisseur.

**Lorsque toutes les sources utilisables d'une crypto échouent :** conserver son **dernier instantané réellement validé** dans KV pendant **24 heures maximum à compter de sa dernière collecte réussie**, afficher « Dernier relevé sauvegardé » + horodatage, puis « Service indisponible » et retirer les chiffres après ce délai. Ne jamais réhorodater des données anciennes.

## Sources de données programmées, sans clé commerciale

| Crypto | Principale | Secours n°1 | Secours n°2 | État |
|---|---|---|---|---|
| **Monero / XMR** | \`monero.rs:18081\` | \`xmr.nodely.dev:18089\` | \`xmr.hostingwire.net\` (candidat public) | **Au moins 2 nœuds distincts concordants obligatoires** |
| **Ethereum Classic / ETC** | Blockscout \`etc.blockscout.com/api/eth-rpc\` | \`rpc.etcmc.xyz\` | \`etc.etcdesktop.com\` | Essai séquentiel, retour automatique au principal |
| **Ravencoin / RVN** | \`api.ravencoinexplorer.com\` | *Non validé* | *Non validé* | Sauvegarde de 24 h si indisponible |
| **Ergo / ERG** | Mesures manuelles | — | — | Aucun fournisseur automatique fiable configuré |
| **Flux / FLUX** | Mesures manuelles | — | — | Aucun fournisseur automatique fiable configuré |

Ne pas présenter RVN, ERG et FLUX comme disposant de plusieurs sources automatiques indépendantes. Nous ne branchons pas un RPC inventé pour remplir une case.

### Sécurité Monero : corroboration plutôt qu'une seule valeur

Les trois adresses correspondent à **des opérateurs distincts**, mais la disponibilité d'un endpoint reste variable.

- Obtenir un \`get_info\` depuis une adresse HTTPS fixe, une hauteur synchronisée en **mainnet**, et \`get_last_block_header\`.
- Les deux premiers nœuds sains doivent **se mettre d'accord sur le hash du bloc à une même hauteur** (si les têtes diffèrent de 1 à 3 blocs, demander le hash du bloc commun). S'ils divergent, tester le troisième.
- Sans **deux confirmations indépendantes**, le système **refuse une nouvelle publication**, conserve le dernier relevé vérifié pendant maximum 24 h puis masque la rentabilité.
- Une fois le quorum trouvé, obtenir 30 en-têtes consécutifs depuis un nœud de la paire ; vérifier continuité/hauteur/hash de pointe/récompenses, sans jamais transmettre clés, portefeuilles ou données personnelles.
- Deux nœuds indépendants ne constituent **pas** une preuve cryptographique que leurs données sont authentiques. Les valeurs restent des estimations.

### Sécurité Ethereum Classic

- Rejouer la même séquence de validation sur **chaque** RPC successif : \`eth_chainId\` doit répondre **61 / 0x3d** et \`eth_syncing\` doit indiquer \`false\`.
- Demander les **33 derniers blocs** pour calculer 32 intervalles valides et un taux moyen.
- Vérifier \`parentHash\`, \`number\`, les timestamps, le bloc final récent, l'algorithme Etchash et la subvention de base, sans inclure fictivement les frais ou le MEV.
- Si un fournisseur rate-limit, répond 403/429/5xx, ne supporte pas les requêtes de bloc en lot ou renvoie une autre chaîne, le système l'ignore et essaie la source suivante.
- Quand Blockscout revient, il est réessayé **en premier** au cycle suivant : récupération automatique, pas de verrouillage de secours.

### Ravencoin : ne pas maquiller la couverture

L'API RavencoinExplorer documente publiquement les blocks et l'estimation de hashrate, et permet une consultation sans authentification avec une politique de **fair use**. Les explorateurs alternatifs existent, mais nous n'avons **pas encore vérifié** un second endpoint proposant tous les champs nécessaires, une réponse récente et des droits d'usage adaptés. Nous conservons donc le mécanisme des **24 heures**, sans promettre un basculement indépendant RVN.

### Limites commerciales et d'exploitation

- Toutes ces sources sont opérées par des **tiers**, parfois avec des quotas et des conditions de « fair use ». Une API publique gratuite n'accorde **pas nécessairement le droit** de republier ses données sur GPUbnb. La documentation Nodely indique de contacter l'opérateur pour les charges commerciales importantes.
- Le planning prévu est une collecte **toutes les heures**, soit **24 cycles par jour**. Les secours sont contactés seulement si nécessaire, à l'exception des confirmations indépendantes nécessaires au quorum Monero.
- Aucune clé payante ni licence commerciale n'est achetée. Ne pas dépasser les limites publiées ; en cas de 429, ne pas contourner le quota en ouvrant des centaines de nouveaux endpoints.
- L'URL de chaque source est fixe et autorisée en liste blanche, HTTPS obligatoire et redirections refusées ; temps d'attente et taille des réponses bornés.
- Les tests actuels simulent des données et des pannes. **Aucun essai complet sur les endpoints en conditions de production n'a encore validé la compatibilité, les conditions commerciales ou le bon déroulement sur Cloudflare.** L'activation ne doit pas être annoncée comme opérationnelle avant ces tests.

## Pour vérifier

\`\`\`bash
cd apps/web/comparateur
npm test
\`\`\`

- \`tests/public-sources.test.mjs\` : principale saine, panne de la principale, secours n°1 et n°2, retour vers la principale, mauvais chain ID, désaccord entre nœuds Monero, refus des historiques incohérents.
- \`tests/backup-24h.test.mjs\` : dernier relevé non réhorodaté, sauvegarde 24 h et expiration.
- \`/api/status\` expose par crypto la date, la source et \`fallback: true/false\` lorsqu'un relevé est présent.

## Sources documentaires

- Monero monero.rs : https://monero.rs/ — nœud public HTTPS sans compte, service best-effort.
- Nodely Monero : https://nodely.io/docs/monero — nœuds mainnet et conditions de fair use ; voir restrictions commerciales.
- Nœud Monero candidat indépendant : https://monero.fail/ — disponibilité/SSL et droit d'usage à confirmer.
- ETC officiel : https://ethereumclassic.com/build/networks — Blockscout mainnet.
- ETCMC : https://status.etcmc-monitor.org/docs — endpoint public \`https://rpc.etcmc.xyz\`, quotas par IP.
- ETC Desktop : https://www.ethereumclassic.org/network/endpoints/ — liste publique des RPC mainnet et secours.
- RavencoinExplorer : https://api.ravencoinexplorer.com/docs.html — accès sans clé, fair-use et schémas des blocs.
- Cloudflare Workers : https://developers.cloudflare.com/workers/platform/limits/ — quotas de l'offre gratuite et déclencheurs Cron.

**Aucune autre partie de GPUbnb n'est modifiée. PR brouillon, aucune fusion sans accord explicite.**
