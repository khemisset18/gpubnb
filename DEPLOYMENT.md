# Déploiement public pris en charge

GPUbnb est déployé comme un service Docker Render unique servant l’API et `apps/web` sur la même origine. Cette architecture est nécessaire aux cookies de session `SameSite=Strict` et évite une configuration CORS permissive.

1. Créer PostgreSQL et Redis TLS et tester leur restauration.
2. Créer le Blueprint Render depuis `render.yaml`, avec la racine du dépôt comme contexte.
3. Définir les variables et secrets listés dans `DEPLOYMENT_CHECKLIST.md`.
4. Laisser la CI terminer npm, Prisma, TypeScript, Rust, l’audit et le build Docker.
5. Relire les migrations, puis déployer ; le conteneur exécute `prisma migrate deploy`.
6. Définir les valeurs publiques Supabase dans Render ; l’API génère `GET /public-config.js`, jamais une clé `service_role`.
7. Tester `/health`, `/ready`, l’authentification, la réservation et les paiements sur Devnet.
8. Installer l’agent uniquement sur une machine Linux dédiée, sans privilèges root.

Le Mainnet reste bloqué tant que `scripts/mainnet-gate.sh` ne réussit pas avec de vraies preuves externes.
