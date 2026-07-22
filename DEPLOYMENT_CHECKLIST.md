# Checklist de déploiement GPUbnb

## Avant Render

- [ ] Choisir les domaines finaux frontend et API.
- [ ] Créer PostgreSQL et Redis TLS ; vérifier sauvegarde et restauration.
- [ ] Relire `apps/api/prisma/migrations`, puis exécuter uniquement `prisma migrate deploy`.
- [ ] Garder `ALLOW_MAINNET=false` et `SOLANA_CLUSTER=devnet` tant que l'audit Mainnet manque.

## Render (service Docker)

- [ ] Connecter le dépôt et la branche voulue ; vérifier le SHA affiché avant déploiement.
- [ ] Root Directory : vide (racine du dépôt).
- [ ] Dockerfile Path : `./apps/api/Dockerfile` ; Docker Context : `.`.
- [ ] Health Check Path : `/health` ; ne pas utiliser `/ready` pour le redémarrage automatique.
- [ ] Définir `DATABASE_URL`, `REDIS_URL` (`rediss://`), `PUBLIC_APP_DOMAIN` (hôte sans protocole), `PLATFORM_WALLET`, `SOLANA_RPC_URL` et `ESCROW_PROGRAM_ID`.
- [ ] Générer des valeurs aléatoires distinctes d'au moins 32 caractères pour `SESSION_SECRET` et `INTERNAL_SERVICE_TOKEN` dans Render.
- [ ] Conserver `NODE_ENV=production`, `TRUST_PROXY=true` et les valeurs non secrètes de `render.yaml`.
- [ ] Si Supabase Auth est activé, définir ensemble `SUPABASE_URL` et `SUPABASE_ANON_KEY`.
- [ ] Tester `GET https://<API_DOMAIN>/health`, puis `GET /ready`.

## Supabase et Google OAuth (si activés)

- [ ] Dans Supabase Auth, définir **Site URL** à `https://<FRONTEND_DOMAIN>`.
- [ ] Ajouter `https://<FRONTEND_DOMAIN>/**` aux Redirect URLs autorisées.
- [ ] Activer Google dans Supabase avec le Client ID et Client Secret conservés uniquement dans Supabase.
- [ ] Dans Google Cloud Console, ajouter l'origine JavaScript `https://<FRONTEND_DOMAIN>`.
- [ ] Ajouter l'URI de redirection fournie par Supabase : `https://<PROJECT_REF>.supabase.co/auth/v1/callback`.
- [ ] Renseigner uniquement `SUPABASE_URL` et la clé anon dans Render ; l’API expose ces valeurs publiques via `public-config.js` ; ne jamais y mettre la service-role key.
- [ ] Configurer les modèles/SMTP Supabase, puis tester inscription, confirmation e-mail, connexion Google, déconnexion et récupération de mot de passe.

## Validation fonctionnelle

- [ ] Tester connexion Phantom et Supabase, création de session et cookie Secure/SameSite.
- [ ] Tester inscription, connexion, déconnexion et expiration de session.
- [ ] Tester publication d'une machine et heartbeat signé.
- [ ] En Devnet seulement, tester réservation, dépôt escrow et lecture du paiement.
- [ ] Vérifier les logs sans données d'authentification et les métriques PostgreSQL/Redis.

## Rollback

- [ ] Noter le SHA déployé et conserver le précédent SHA sain.
- [ ] En incident, désactiver l'auto-deploy, restaurer/redéployer le précédent SHA dans Render.
- [ ] Ne pas exécuter de migration destructive inverse ; appliquer une migration corrective relue.
- [ ] Révoquer/faire tourner tout secret potentiellement compromis et vérifier `/health` puis `/ready`.
