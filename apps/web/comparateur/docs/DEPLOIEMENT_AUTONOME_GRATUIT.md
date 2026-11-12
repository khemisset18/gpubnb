# GPUbnb Comparateur — activation autonome **sans entretien de nœud**

**État : préparation en PR #353, non fusionnée, non déployée.**
Ce guide ne concerne que \`apps/web/comparateur/\`, pas GPUbnb Host, la marketplace ou le site principal.

## Architecture prévue

- Un **Cloudflare Worker** isolé réalise une tentative de collecte **toutes les heures**, à des minutes distinctes en UTC : XMR `17 * * * *`, ETC `27 * * * *` et RVN `37 * * * *`.
- Pour XMR et ETC, les sources publiques sont interrogées par priorité, avec retour automatique au fournisseur principal quand il récupère. RVN a un seul fournisseur de blockchain préparé.
- Une observation n'est stockée en KV qu'après validation des champs, de la chaîne, des blocs et des dates. Les données de prix fiat restent manuelles.
- Chaque crypto possède sa propre clé KV et n'efface pas les relevés des autres monnaies.
- Les dernières observations valides sont conservées **24 heures maximum** après collecte, sans réhorodatage. Après ce délai : **Service indisponible**.
- Le navigateur lit les nouvelles données au plus une fois toutes les 15 minutes et contrôle localement chaque minute la péremption.
- **Aucun mineur n'est installé ni lancé** et aucun utilisateur GPUbnb Host n'est contacté.

## Avant toute activation : zéro approximation

Il reste des prérequis externes. La PR ne les prétend pas satisfaits :

1. **Tester les endpoints réels** XMR/ETC/RVN sur la plateforme prévue et confirmer les conditions de réutilisation commerciale gratuite et les limites imposées par leurs opérateurs. Si une source refuse l'usage, la désactiver ou ne pas publier ses données.
2. **Créer un compte Cloudflare gratuit** autorisé à utiliser Workers Cron et Workers KV ; vérifier les quotas de l'offre à la date du déploiement. Une offre gratuite n'est pas une garantie de service illimité.
3. **Créer UNE SEULE fois un namespace KV** avec l'identifiant de liaison \`SNAPSHOTS\`. Cloudflare génère un identifiant KV (32 caractères hexadécimaux).
4. **Préparer une configuration locale**, sans jamais enregistrer d'identifiant inventé dans Git.
5. **Lancer les tests locaux**, la validation Wrangler (\`--dry-run\`), puis une observation de test. **Déployer seulement après l'accord explicite du propriétaire**.
6. Après activation, vérifier \`/api/status\` au moins sur 2 cycles horaires, l'expiration 24 h, le basculement, les données ERR et l'absence d'appels au site GPUbnb.

### Commandes préparatoires (aucune fusion ni activation implicite)

Sur une machine de confiance, dans une copie de la branche de la PR :

\`\`\`bash
cd apps/web/comparateur
npm test
# Une seule fois, après connexion volontaire au compte Cloudflare :
npx wrangler login
npx wrangler kv namespace create SNAPSHOTS
# Copier uniquement l'identifiant KV réellement retourné par Cloudflare :
node tools/prepare-cloudflare-config.mjs 0123456789abcdef0123456789abcdef
# IMPORTANT : l'identifiant ci-dessus est un EXEMPLE, ne PAS l'utiliser.
npx wrangler deploy --config wrangler.deploy.jsonc --dry-run
\`\`\`

\`prepare-cloudflare-config.mjs\` **n'effectue aucun déploiement**. Il vérifie le template, les trois Crons horaires et l'identifiant fourni, puis crée \`wrangler.deploy.jsonc\` localement en refusant d'écraser un fichier existant. Ce fichier est ignoré par Git et exclu des assets publics. **L'identifiant de namespace n'est pas un jeton secret mais est propre au compte Cloudflare ; jamais de token ou d'identifiants d'administration dans le dépôt.**

La commande de déploiement réelle suivante est volontairement **non exécutée par cette PR** :

\`\`\`bash
# UNIQUEMENT après accord explicite du propriétaire, et jamais vers le site principal :
npx wrangler deploy --config wrangler.deploy.jsonc
\`\`\`

Les commandes du guide ne sont ni du code exécuté ni un script GitHub Action. L'identifiant d'exemple dans les instructions n'est pas accepté comme configuration de production : il faut utiliser l'identifiant réel attribué au compte.

## Vérification de production prévue

Après autorisation, consulter le JSON public de \`/api/status\` :
- \`refresh: "hourly"\`
- \`expectedRefreshMinutes: 60\`
- \`graceMinutes: 15\`
- \`backupMaxHours: 24\`
- Chaque cryptomonnaie XMR/ETC/RVN porte indépendamment \`fresh\`, \`saved\` ou \`unavailable\`.
- \`operator\` indique le fournisseur utilisé, \`fallback: true\` indique un fournisseur secondaire.
- **Aucun \`fresh\` sans collecte valide réelle** ; si les données sont vides, le statut doit rester \`unavailable\`.

## Sécurité et coûts

- **Politique de données minimale** : aucun portefeuille, adresse de minage, mot de passe, identifiant d'utilisateur ni numéro de série.
- **Appels sortants bornés** : hôtes HTTPS autorisés en dur, redirections refusées, réponses JSON limitées à 768 Kio réellement lus, délai de 10 secondes par requête.
- **Assets privés non publiés** : \`.assetsignore\` exclut \`edge/\`, \`tools/\`, \`tests/\`, les docs et \`wrangler.deploy.jsonc\`. Une politique CSP de la page empêche les scripts et connexions externes.
- **Surveillance minimum** : regarder les logs en cas d'échecs systématiques, ou préparer ultérieurement une notification hebdomadaire à partir du statut, sans imposer de tâches quotidiennes à l'opérateur.
- **Quotas** : avec 24 tentatives par crypto et trois déclencheurs horaires, les lectures KV côté visiteurs peuvent devenir le coût dominant ; réexaminer les quotas si l'audience grandit.

### Références officielles
- [Cloudflare Workers KV, création et liaison du namespace](https://developers.cloudflare.com/kv/get-started/)
- [Cloudflare KV, l'identifiant \`id\` est obligatoire](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)
- [Cloudflare Static Assets et \`.assetsignore\`](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

**PR maintenue en brouillon. Aucun changement aux autres modules GPUbnb, aucune fusion, aucun déploiement.**
