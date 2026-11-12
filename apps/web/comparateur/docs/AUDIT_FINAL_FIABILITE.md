# GPUbnb Rentabilité — audit de fiabilité et sécurité

**Version contrôlée : PR #353, 12 novembre 2026.**
**Périmètre strict :** \`apps/web/comparateur/\`. Aucun changement ni démarrage sur le site principal, GPUbnb Host, ses comptes ou ses locations.

## Statut vérifié

| Sujet | Ce qui est codé | Limite avant production |
|---|---|---|
| Catalogue | 14 cryptos ; unités H/s, Sol/s, Graph/s ; mode Pearl basé sur des mesures de gains, ASIC séparés | Pas de benchmark réel automatiquement garanti |
| Calcul | Revenus crypto théoriques, électricité, frais pool, quantités et scénarios | Cours EUR manuel ; sources de mesures à confirmer |
| Sources publiques | XMR quorum de 2 opérateurs, ETC principal + secours, RVN premier fournisseur | Les API et leurs droits de réutilisation commerciale doivent être testés en réel |
| Cadence | Cloudflare Crons répartis `17/27/37 * * * *` (syntaxe illustrative ; trois expressions exactes dans `wrangler.jsonc`), chaque crypto une fois par heure UTC | Worker Cloudflare pas encore installé ni déployé |
| Reprise sur incident | 24 h maximum depuis dernier succès ; aucun réhorodatage après échec | Aucune disponibilité garantie si toutes les sources restent en panne |
| Réduction du quota | Réponses JSON partagées en cache jusqu'à 120 s au maximum | Surveiller les quotas réels KV/Workers si l'audience augmente |
| Expiration | Le TTL de cache est raccourci à la seconde près avant l'expiration de 24 h ; \`/api/status\` n'est pas mis en cache au-delà du seuil de fraîcheur de 75 min | Les caches réseau externes non contrôlés ne sont pas une garantie absolue |
| Navigateur | Lectures de JSON toutes les 15 min ; contrôle de péremption en mémoire chaque minute | Intégration navigateur/mobile à valider sur un hébergement de test |
| Sécurité HTTP | CSP, fichiers publics limités par \`.assetsignore\`, pas de portefeuille ni de clés API dans le navigateur | Tester les en-têtes réels selon l'hébergement choisi |
| Sécurité des données entrantes | URLs HTTPS autorisées, redirections refusées, délai maximal, lecture décompressée limitée à 768 Kio | Les endpoints peuvent bloquer Cloudflare ou imposer un accord d'utilisation |
| ETC restreint | \`eth_syncing\` absent (\`-32601\`) toléré seulement avec 33 blocs liés, bons chaînage et horodatage ; mauvais réseau/sync active refusés | Compatibilité réelle des appels par lots à confirmer sur Blockscout et les secours |
| Cloudflare KV | Namespace à créer UNE seule fois ; outil de configuration sans déploiement ni ID fictif | Compte Cloudflare + identifiant réel nécessaires avant tout test distant |

## Vérifications techniques effectuées en environnement JS isolé

- **16/16** : collecteurs ETC et sources de secours XMR/ETC/RVN, méthodes RPC restreintes, validations des hauteurs et des blocs.
- **7/7** : conservation 24 h, libellés, expiration, retour « Service indisponible ».
- **3/3** : limites réelles de réponse API (stream, taille de réponse, en-tête de taille falsifié).
- Contrôles directs supplémentaires : génération de config Cloudflare sans ID inventé, cache 120 s borné par la date d'expiration, syntaxe JavaScript des calculateurs.
- Tests natifs Node fournis dans \`tests/\` : notamment \`cloudflare-config.test.mjs\`, \`public-fetch-security.test.mjs\`, \`edge-cache.test.mjs\`, \`hourly-refresh.test.mjs\` et les suites plus anciennes.

Ces résultats **ne remplacent pas** l'exécution de \`npm test\` avec le dépôt complet, les tests dans un navigateur, les requêtes effectives aux fournisseurs, ni un audit de sécurité de l'environnement déployé. Ne pas confondre « code préparé » et « service actif ».

## Budget gratuit, niveau réaliste de maintenance

- Cloudflare annonce sur l'offre gratuite **100 000 lectures KV et 1 000 écritures KV par jour** dans sa documentation d'octobre 2026. Trois cryptos × une collecte réussie par heure = au plus **72 écritures de mesures par jour**, loin de 1 000 en conditions normales. Les lectures côté visiteurs restent la variable de coût la plus sensible.
- Les réponses d'API sont partagées au maximum 120 secondes afin de ne pas répéter inutilement les lectures KV. Le cache HTTP n'a jamais le droit de dépasser l'échéance de 24 h ; le statut de santé n'est pas conservé au-delà du basculement « récent/sauvegardé ».
- Une solution gratuite dépend toujours de quotas, de politiques des opérateurs tiers et des Conditions d'utilisation. Sans contrat de service, **on ne peut pas garantir zéro maintenance ni zéro panne**.
- Le seul prérequis humain à ce stade : **autoriser un futur hébergement de test indépendant, créer/relier le namespace KV Cloudflare et confirmer la politique d'utilisation des fournisseurs publics**. Ne pas installer de nœud blockchain ni de mineur sur une machine GPUbnb.

## Portes de validation avant activation

1. \`cd apps/web/comparateur && npm test\` avec Node.js 22.
2. Vérifier les vrais schémas des réponses XMR/ETC/RVN, la prise en charge HTTP de Cloudflare et les conditions de réutilisation commerciale.
3. Dry-run Wrangler depuis le **namespace KV réel** (voir [guide](DEPLOIEMENT_AUTONOME_GRATUIT.md)), sans toucher au site principal.
4. Tests d'intégration navigateur : écran mobile, calendrier horaire, statut source de secours, seuil de 24 h.
5. Seulement après autorisation explicite du propriétaire : déploiement isolé, suivi de deux cycles, puis éventuelle décision distincte de fusion.

## Documents liés

- [Activation gratuite en une fois](DEPLOIEMENT_AUTONOME_GRATUIT.md)
- [Sources principales et de secours](BASCULEMENT_SOURCES.md)
- [Politique de conservation 24 heures](SECOURS_24_HEURES.md)
- [14 cryptomonnaies, calculs et limites](COUVERTURE_COMPLETE_CRYPTOS.md)
- [Audit des projets GitHub et licences](REVUE_GITHUB_SECURITE.md)

## Sources Cloudflare actuelles

- [Workers KV : limites](https://developers.cloudflare.com/kv/platform/limits/)
- [Workers KV : tarifs](https://developers.cloudflare.com/kv/platform/pricing/)
- [Workers : cache HTTP](https://developers.cloudflare.com/workers/cache/)
- [KV namespace : identifiant requis](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)
- [Workers Static Assets et .assetsignore](https://developers.cloudflare.com/workers/static-assets/binding/)

**Ne pas fusionner ni déployer sans accord explicite.**


### CPU gratuite : trois collectes isolées

Cloudflare Workers Free limite le temps CPU à **10 ms par déclenchement planifié** (le temps d'attente réseau est exclu) et autorise **5 déclencheurs Cron par compte**. Le comparateur utilise désormais **3 déclencheurs horaires** : XMR à :17, ETC à :27 et RVN à :37 (UTC). Chaque invocation traite une seule cryptomonnaie. Cela réduit les risques de dépassement CPU et de sous-requêtes mais ne prouve pas qu'une collecte réelle complète respecte 10 ms ; la mesure sur Cloudflare reste obligatoire avant activation.

Référence : https://developers.cloudflare.com/workers/platform/limits/
