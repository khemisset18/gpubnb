> GPUbnb v1.0 Devnet — base renforcée destinée aux tests locaux et Devnet, jamais aux fonds Mainnet sans audit.

# GPUbnb v1.0 — Devnet Release

Marketplace pseudonyme de location de GPU avec authentification Phantom, agent GPU signé, PostgreSQL/Redis et escrow natif SOL.

## Paiement

Le contrat Anchor verrouille les lamports dans un PDA unique par réservation. Après mesure d'usage :

- disponibilité >= 90 % : montant payable intégral ;
- disponibilité < 90 % : paiement proportionnel ;
- 5 % du montant payable vers `B5WQmXWHL8R86wf3LHLRE4aQAuRdRSz1EXKcwNQDqj2e` ;
- 95 % au fournisseur ;
- solde non payable remboursé au locataire.

Le frontend peut créer une réservation d'une heure, demander à l'API une transaction non signée, la faire signer par Phantom et confirmer le dépôt. L'API vérifie ensuite la signature, le programme invoqué, le PDA, le propriétaire du compte, l'acheteur, le fournisseur, le montant et la durée avant de passer la réservation à `FUNDED`.

## Structure

- `apps/web` : interface web statique et bundle Solana local.
- `apps/api` : API Fastify, Prisma, Redis et vérification on-chain.
- `programs/gpu_escrow` : contrat Anchor SOL.
- `agent` : agent de preuve GPU signé.
- `docs` : procédures de déploiement et limites de production.

## Démarrage local

### Prérequis

- Node.js 22 et npm 10.9.2 ;
- PostgreSQL 16 et Redis 7 (ou `docker compose`) ;
- Docker pour reproduire l'image Render ;
- Rust/Anchor uniquement pour le programme d'escrow.

`apps/api` est le package Node canonique et autonome. Le dépôt n'utilise pas de
workspaces npm : toute installation, génération Prisma et compilation de l'API
doit être lancée depuis ce dossier. Les anciennes copies Node à la racine ont été supprimées : il n’existe plus qu’une source canonique pour chaque application.

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
cd apps/api
npm ci
npx prisma generate
npx prisma migrate deploy
npm test
npm run build
npm start
```

L'API écoute sur `0.0.0.0:$PORT`. `GET /health` est un contrôle de processus sans
accès aux dépendances ; `GET /ready` vérifie PostgreSQL et Redis.

## Configuration

Copier `.env.example` vers un fichier local non suivi. Les variables obligatoires
sont `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `INTERNAL_SERVICE_TOKEN`,
`PUBLIC_APP_DOMAIN` et `PLATFORM_WALLET`. En production, Redis doit utiliser
`rediss://`, `PUBLIC_APP_DOMAIN` doit être le nom d'hôte public du frontend (sans
protocole), et `TRUST_PROXY=true` est requis derrière Render. Les paramètres
Supabase `SUPABASE_URL` et `SUPABASE_ANON_KEY` sont facultatifs ensemble ; la clé
anon est publique, aucune service-role key n'est utilisée par le code.

Google OAuth et les e-mails sont fournis par Supabase Auth : aucune clé Google
n'entre dans l'API ou le frontend. Le navigateur charge la configuration publique depuis `GET /public-config.js`, généré par l’API à partir des variables Render. Seules l’URL et la clé anon publiques y sont exposées ; aucune clé privée ne rejoint le bundle. Pour conserver les cookies de session `SameSite=Strict`, le lancement pris en charge sert le frontend et l’API depuis le même domaine Render.

## Commandes de validation

Depuis `apps/api` : `npm ci`, `npm test`, `npm run build`,
`npx prisma validate`, `npx prisma format --check` et `npx prisma generate`.
La migration de production non destructive est `npx prisma migrate deploy`.
Depuis la racine, `cargo test --manifest-path programs/gpu_escrow/Cargo.toml`
teste le contrat et `node --check apps/web/*.js` contrôle le JavaScript statique.

## Docker et Render

Construire depuis la racine, comme Render :

```bash
docker build -f apps/api/Dockerfile -t gpubnb-api .
```

Render doit utiliser **Root Directory vide (racine du dépôt)**, Dockerfile
`./apps/api/Dockerfile`, healthcheck `/health` et la branche/commit explicitement
choisi. `render.yaml` décrit ces réglages. Le conteneur lance `prisma migrate deploy`
avant l'API ; consulter les migrations en PR avant tout déploiement. Les domaines,
secrets et services managés restent des opérations manuelles détaillées dans
`DEPLOYMENT_CHECKLIST.md`.

## Limites et rollback

Le frontend conserve encore certaines fonctions de démonstration en stockage
local et le Mainnet reste volontairement bloqué jusqu'aux preuves d'audit décrites
ci-dessous. Pour revenir en arrière, sélectionner dans Render le dernier déploiement
sain ou redéployer son SHA ; les migrations Prisma doivent rester additives et ne
doivent jamais être annulées par une suppression manuelle de données.

## Important

Le dépôt est une **candidate production**, pas une garantie de sécurité financière. Un déploiement Mainnet exige un nouveau Program ID, des clés protégées, des tests Anchor exécutés, un RPC de production, une surveillance et un audit indépendant du binaire exact déployé. Voir `docs/MAINNET_GO_LIVE.md`.

## Mainnet safety status

This repository is deliberately **NO-GO for public mainnet** until `./scripts/mainnet-gate.sh` passes with genuine third-party evidence. Never bypass `ALLOW_MAINNET`, the external audit, multisig, sandbox pentest, private RPC, backup-restore test, and legal review requirements.

See `docs/CHANGES_MAINNET_HARDENING.md` and `audit/README.md`.

## RC3 — préparation des autorités Mainnet

Voir `docs/RC3_ADDITIONS.md`, `docs/MULTISIG_SETUP.md` et `docs/SANDBOX_SECURITY.md`.
Le dépôt inclut désormais une migration d'admin en deux étapes, les outils de Program ID, une baseline de sandbox et un bundle de preuves. Les attestations externes ne sont jamais générées artificiellement.


## Premier démarrage sans coder

Lire `DEPLOYMENT_CHECKLIST.md`, puis exécuter `node scripts/devnet-doctor.mjs` pour vérifier la machine.

## v1.1 — Publication GPU locale (démo)

- Nouvelle page `apps/web/publish.html`, reliée à la navigation principale.
- Formulaire de publication avec validation côté navigateur.
- Sauvegarde des annonces dans `localStorage` (`gpubnb.demo.listings.v1`).
- Fusion automatique des annonces locales avec les annonces API dans la marketplace.
- Les annonces locales sont clairement marquées comme démo et ne déclenchent aucune transaction.

## Version v1.2 — Demandes et propositions

Le frontend inclut maintenant deux espaces complémentaires :

- `apps/web/demandes.html` : publication et suivi des demandes GPU côté client ;
- `apps/web/propositions.html` : réponse aux demandes côté propriétaire, avec statuts en attente, acceptée ou refusée.

Dans cette version Devnet, ces données restent locales au navigateur et sont clairement signalées comme démonstration. La prochaine étape consiste à connecter ces écrans à l'API et à PostgreSQL avant tout usage réel.
