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

## Important

Le dépôt est une **candidate production**, pas une garantie de sécurité financière. Un déploiement Mainnet exige un nouveau Program ID, des clés protégées, des tests Anchor exécutés, un RPC de production, une surveillance et un audit indépendant du binaire exact déployé. Voir `docs/MAINNET_GO_LIVE.md`.

## Mainnet safety status

This repository is deliberately **NO-GO for public mainnet** until `./scripts/mainnet-gate.sh` passes with genuine third-party evidence. Never bypass `ALLOW_MAINNET`, the external audit, multisig, sandbox pentest, private RPC, backup-restore test, and legal review requirements.

See `docs/CHANGES_MAINNET_HARDENING.md` and `audit/README.md`.

## RC3 — préparation des autorités Mainnet

Voir `docs/RC3_ADDITIONS.md`, `docs/MULTISIG_SETUP.md` et `docs/SANDBOX_SECURITY.md`.
Le dépôt inclut désormais une migration d'admin en deux étapes, les outils de Program ID, une baseline de sandbox et un bundle de preuves. Les attestations externes ne sont jamais générées artificiellement.


## Premier démarrage sans coder

Lire `COMMENCER_ICI.txt`, puis `docs/ETAPE_1_GITHUB_NETLIFY.md`. Exécuter `node scripts/devnet-doctor.mjs` pour vérifier la machine.

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
