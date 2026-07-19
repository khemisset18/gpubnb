# GPUbnb Enterprise — release candidate Devnet

Plateforme pseudonyme de location de GPU. Ce dépôt comprend l'interface Netlify, une API permanente, PostgreSQL/Redis, un agent GPU et un programme d'escrow Solana.

## Statut de sécurité

- **Devnet uniquement** par défaut.
- `ALLOW_MAINNET=false` est obligatoire.
- Aucun KYC obligatoire ; authentification par signature de portefeuille et session opaque.
- Une annonce publique n'est visible que si le GPU a été récemment attesté par son agent.
- Le règlement est déterministe : 5 % sur la partie payable, 95 % fournisseur, remboursement du solde.
- Le seuil commercial est 90 % de disponibilité par heure. Sous ce seuil, paiement proportionnel.

Ce dépôt corrige les principaux défauts du prototype, mais un audit indépendant du binaire Solana déployé et des tests d'évasion de la sandbox restent requis avant tout Mainnet.

## Démarrage local

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
cd apps/api
npm ci
npm run prisma:generate
npm run prisma:migrate
npm test
npm run build
npm start
```

Pour Netlify, déployer **uniquement `apps/web`** et définir `window.GPUBNB_API_URL` dans `config.js`.

## Déploiement gratuit Supabase + Upstash

Le fichier `render.yaml` de cette version déploie uniquement l'API sur Render. PostgreSQL doit être fourni par Supabase et Redis par Upstash. Voir `docs/DEPLOIEMENT_GRATUIT.md`.
