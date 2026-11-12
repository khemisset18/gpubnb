# GPUbnb · Renseignement autonome de la rentabilité Monero

Cette fonctionnalité se trouve **uniquement dans** \`apps/web/comparateur/\`. Aucune modification de GPUbnb Host, de la marketplace, du backend de réservation, du minage de machine ou du site public principal.

## Ce qui est utilisable sans compte, abonnement ou API externe

La section **« Estimez le rendement Monero sans API payante »** propose :
1. Sélection GPU/CPU existante, prix électrique, durée, puissance et nombre d'appareils existants.
2. Saisie d'un **hashrate RandomX mesuré** (H/s pour 1 appareil) : aucun hashrate n'est inventé à partir du seul nom du CPU/GPU.
3. Deux modes de données réseau :
   - **Automatique depuis votre propre nœud Monero** : si un fichier \`data/monero-reseau.json\` frais est publié par la tâche décrite ci-dessous, calcul sur une moyenne des **30 derniers blocs**.
   - **Manuel** : saisie de la difficulté réseau et de la récompense (XMR/bloc), sans présentation comme « temps réel ».
4. Résultats XMR théoriques **jour, mois (30 j), an (365 j)**. L'affichage EUR nécessite **un cours XMR/EUR saisi manuellement**, avec déduction des frais de pool et de l'électricité.
5. En l'absence de données, le site affiche « Nœud indisponible » et des tirets ; il n'invente ni profits ni cours.

Formule théorique : \`XMR/jour ≈ H/s × (heures × 3600) × nombre d'appareils / difficulté × récompense moyenne\`.
Cela suppose difficulté et récompense constantes et ignore la variance du minage et les blocs orphelins. Le résultat est une espérance mathématique, pas une garantie. Le rendement du minage solo réel est extrêmement variable ; un pool réduit la variance mais prélève des frais.

## Activer l'observation réseau sans payer un fournisseur

Prérequis **non fournis avec cette PR** : une machine autorisée à exécuter un nœud Monero **MAINNET synchronisé**. Les exigences de stockage, d'énergie, de réseau et de maintenance restent à la charge de l'opérateur ; l'absence d'abonnement à une API n'implique pas un coût d'exploitation nul.

1. Installer et synchroniser \`monerod\` en utilisant les instructions officielles : https://www.getmonero.org/downloads/ et https://docs.getmonero.org/interacting/monerod-reference/
2. Laisser son JSON-RPC **uniquement sur 127.0.0.1:18081**. Ne jamais exposer le port 18081 à Internet. Le script rejette un nœud non synchronisé, en bootstrap non fiable, sur testnet ou stagenet.
3. Sur **la même machine**, dans une copie du dépôt, exécuter avec Node.js 22 ou plus :

\`\`\`bash
node apps/web/comparateur/tools/build-monero-snapshot.mjs
node --test apps/web/comparateur/tests/*.test.mjs
\`\`\`

4. Le script collecte \`get_info\`, \`get_last_block_header\` puis \`get_block_headers_range\` sur 30 blocs. Il vérifie continuité/hauteur/chaîne, absence de bloc orphelin, récompenses et difficulté, puis écrit **atomiquement** \`data/monero-reseau.json\`. Si la lecture échoue, il ne publie pas un instantané frais fictif.
5. Sur un serveur autorisé, relancer **côté serveur** environ toutes les cinq minutes (cron, conteneur ou tâche hébergée). Copier/publier **seulement ce JSON vérifié** vers l'hébergement statique du comparateur. Ce n'est pas un service de fond démarré par cette PR.
6. Le navigateur refuse les données si elles ont plus de **20 minutes** ou sont futures de plus de cinq minutes ; la date du dernier bloc doit rester cohérente. Le client les recharge toutes les cinq minutes.

**Aucun nœud Monero n'a été déployé, aucun benchmark matériel réel n'a été collecté, aucune tâche cron n'a été activée.** Par défaut, le fichier \`data/monero-reseau.json\` fourni avec la PR indique explicitement « indisponible ».

## Contrat public du fichier

\`\`\`json
{
  "schemaVersion": 1,
  "coin": "XMR",
  "algorithm": "RandomX",
  "network": "mainnet",
  "source": "own-monero-node",
  "collectedAt": "<horodatage UTC réel>",
  "blockTimestamp": "<horodatage réel du dernier bloc>",
  "blockHeight": 3500000,
  "sampleBlocks": 30,
  "difficulty": 600000000000,
  "rewardXmr": 0.6,
  "quality": "estimated-from-30-blocks"
}
\`\`\`

**Ceci illustre uniquement la structure attendue ; les chiffres ci-dessus sont fictifs et NE DOIVENT PAS être publiés comme un instantané de réseau.** Seul \`build-monero-snapshot.mjs\` doit générer le fichier exploité publiquement.

## Vérification

\`\`\`bash
node --test apps/web/comparateur/tests/monero-feed.test.mjs
node --test apps/web/comparateur/tests/monero-direct.test.mjs
node --test apps/web/comparateur/tests/model.test.mjs
\`\`\`

Les tests vérifient notamment les cas d'absence de nœud, de nœud non synchronisé, de faux réseau, de réponses non fiables, de hauteur de blocs incohérente, de données périmées ou futures, et l'absence de valeur en euros sans prix manuel.

Sources techniques officielles :
- https://docs.getmonero.org/rpc-library/monerod-rpc/ (get_info, get_last_block_header, get_block_headers_range)
- https://docs.getmonero.org/technical-specs/ (RandomX, difficulté, récompense et durée des blocs)

## Prochaines extensions strictement limitées au comparateur

- Créer une base de **benchmarks consentis et mesurés**, sans extraction de données sous licence tierce. En l'absence de benchmark mesuré, conserver le champ H/s manuel.
- Après une première expérimentation Monero, développer un adaptateur distinct pour RVN, ETC, ERG, avec le protocole et les vraies mesures correspondants.
- Afficher les prix fiat automatiquement **uniquement après validation d'une source de prix autorisant clairement cet usage commercial**, ou rester sur le prix manuel.

**Ne pas fusionner la PR sans accord explicite du propriétaire.**
