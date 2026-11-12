# GPUbnb Rentabilité — Secours automatique pendant 24 heures

Cette règle n'affecte **que** \`apps/web/comparateur/\` sur la PR #353, non fusionnée. Elle ne modifie aucun module du site principal.

## Besoin utilisateur

Si un service public est temporairement en panne, donne une réponse invalide, dépasse son quota ou renvoie des données suspectes, **ne pas effacer immédiatement le dernier résultat validé**. Le conserver pendant **24 h maximum, comptées à partir de sa collecte initiale**. Après 24 h, afficher **« Service indisponible »** plutôt que continuer à présenter des rendements dépassés.

## Comportement prévu

| Moment depuis la dernière collecte réussie | Affichage |
|---|---|
| Dernier relevé récent (moins de 75 min), service fonctionnel | Réseau public actualisé + heure de la mesure |
| Source en panne, dernière mesure de moins de 24 h | **Dernier relevé sauvegardé** + date/heure d'origine |
| Dernier relevé entre 75 min et 24 h (même si la source ne signale pas la panne) | **Dernier relevé sauvegardé** + date/heure d'origine |
| Plus de 24 h sans nouvelle collecte valide | **Service indisponible**, valeurs automatiques masquées |
| Aucun relevé valide jamais enregistré | **Service indisponible** pour le réseau, ou **mode manuel** pour les revenus non connectés |

La valeur n'est **jamais** réhorodatée après un échec. Une suite de pannes ne peut donc pas conserver une mesure pendant plus de 24 heures. La date affichée est **celle de la dernière collecte réussie**, pas l'heure d'actualisation de la page.

## Implémentation

- **Cloudflare Worker** \`edge/worker.mjs\`, cadence horaire répartie (XMR :17, ETC :27, RVN :37 UTC) définie dans \`wrangler.jsonc\`. Chaque monnaie XMR, RVN et ETC dispose d'une clé KV indépendante.
- **Échec d'une source** : aucune écriture dans la clé du dernier bon relevé. Les autres cryptomonnaies continuent indépendamment.
- **Nouvelle mesure validée** : écriture de l'instantané et durée de vie KV \`expirationTtl: 86400\` secondes. La validation **à chaque lecture** bloque les valeurs âgées de plus de 24 heures, y compris en présence d'un cache KV ou d'une suppression retardée.
- **API de diagnostic** \`/api/status\` : \`fresh\`, \`saved\`, \`unavailable\` ; indique l'heure d'origine et l'âge. Ne contient aucun secret.
- **Navigateur** : le panneau XMR et RVN/ETC affichent le libellé « Dernier relevé sauvegardé » et les horodatages. Si la connexion au Worker tombe momentanément, la page ouverte conserve elle aussi en mémoire son dernier relevé validé **sans dépasser 24 h**.
- **Tableau principal des gains** \`app.js\` : même politique de conservation si un flux de revenus autorisé est un jour branché ; délai borné par \`model.js\`. Aucun flux commercial n'est activé aujourd'hui.
- **Saisie manuelle** : indépendante de la disponibilité du service automatique. Les champs saisis par l'utilisateur ne sont jamais présentés comme une mesure temps réel.
- **ERG et FLUX** : pour l'instant en réseau manuel ; aucun service automatisé crédible n'est affirmé.

## Tests

\`\`\`bash
cd apps/web/comparateur
npm test
\`\`\`

Le fichier \`tests/backup-24h.test.mjs\` teste le dernier résultat à 23 h 59, à exactement 24 h, puis à 24 h + 1 ms ; les erreurs de collecte ne modifient pas \`collectedAt\`, l'API conserve les résultats pendant la fenêtre puis les cache, et les indicateurs basculent de \`fresh\` à \`saved\` puis \`unavailable\`.

\`tests/model.test.mjs\` contrôle également l'expiration des rendements bruts au-delà de 24 heures.

## Limites importantes

**Cette politique est programmée dans la PR, mais ni le Worker ni son espace KV ne sont encore déployés.** Elle n'assure pas à elle seule que les fournisseurs publics répondent, autorisent la réutilisation ou fournissent une mesure correcte.

Pour utiliser automatiquement les observations, il faudra valider les endpoints publics avec des réponses réelles et leurs conditions de réutilisation, puis déployer le service et le KV dans un compte gratuit compatible. Il ne doit pas être fusionné ou installé dans le site principal sans l'accord explicite du propriétaire.

La présence de la dernière donnée valide pendant 24 h améliore la continuité, **mais sa précision économique peut diminuer pendant la panne** : les chiffres doivent donc être clairement étiquetés « sauvegardés ». Un revenu en EUR dépend toujours d'une source de cours juridiquement utilisable ou d'un cours manuel.


## Cadence horaire et maîtrise du quota gratuit

La version préparée pour Cloudflare utilise **trois Crons horaires séparés** (`17 * * * *`, `27 * * * *`, `37 * * * *`, UTC) et un seuil d'affichage « actualisé » de **75 minutes** (60 minutes + 15 minutes de tolérance). La conservation maximale des données vérifiées reste **24 heures** à partir de l'horodatage initial ; toute rediffusion sans vérification est interdite.

Pour réduire les opérations de lecture du stockage gratuit, les modules XMR, PoW GPU et revenus généraux demandent les fichiers de réseau **toutes les 15 minutes**, et contrôlent **chaque minute**, localement dans le navigateur, si l'ancien résultat doit être retiré de l'affichage. Cela évite de nouvelles requêtes réseau pendant les vérifications de péremption.

- Référence : [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) — expressions exécutées en UTC, délai de propagation possible.
- [Quotas Workers](https://developers.cloudflare.com/workers/platform/limits/) et [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/) — les quotas des offres gratuites sont limités et doivent être surveillés avant toute mise en ligne.
- [Tests de cadence](../tests/hourly-refresh.test.mjs), [tests de conservation](../tests/backup-24h.test.mjs).

Le service n'est **pas encore déployé** ; aucune performance avec de vraies réponses API publiques n'a été validée dans Cloudflare. Ne pas confondre un test simulé réussi avec une garantie d'exploitation.
