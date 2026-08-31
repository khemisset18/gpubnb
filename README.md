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
- `agent` : agent de preuve GPU signé, et superviseur des sessions Workspace.
- `workspaces/` : Dockerfiles et healthchecks de chaque Workspace.
- `docs` : procédures de déploiement et limites de production.

## Workspaces

Au-delà de la location GPU brute, GPUbnb fournit des environnements de
travail prêts à l'emploi ("Workspaces") : IDE distant, notebook IA, montage
vidéo/audio accéléré, build Android, laboratoire de sécurité, etc. Sur les
**13 Workspaces du catalogue, 9 sont réellement fonctionnels
(REAL_WORKING)** — testés de bout en bout (réservation réelle → conteneur
réel → accès via le Gateway → arrêt/cleanup vérifié) : **Compute, Developer,
Data, AI, Video, Audio, API, Mobile, Security Lab**.

Les **4 Workspaces à rendu de bureau GPU (Creator, Cloud Desktop, CAD,
Gaming) sont honnêtement bloqués** : leur architecture, leurs images
Docker et leur code de lancement sont réels et prêts, mais la machine de
développement actuelle (Windows/WSL2) ne peut pas exposer de rendu GPU
desktop réel (`/dev/dri`) — voir la distinction entre calcul CUDA et rendu
GPU desktop ci-dessous. Ils ne sont **jamais** présentés comme réservables
tant que ce n'est pas réellement validé sur un hôte Linux + GPU NVIDIA.

Voir `docs/WORKSPACES_OVERVIEW.md` pour l'état détaillé des 13 Workspaces
(tableau, ce qui a été testé, raison exacte du blocage), et
`docs/WORKSPACE_RUNTIME_ARCHITECTURE.md` pour l'architecture technique
(lancement, compatibilité matérielle, healthchecks, arrêt/cleanup).
`docs/SESSION_RESUME.md` contient la checklist complète pour reprendre le
développement des 4 Workspaces bloqués sur une vraie machine Linux GPU.

## GPUbnb Agent

La Phase 1 fournit une CLI Windows/Linux avec génération de clé Ed25519 locale,
diagnostic matériel, liaison par code à usage unique et heartbeats signés.

```bash
python -m pip install -e agent
gpubnb-agent setup
gpubnb-agent link CODE_TEMPORAIRE
gpubnb-agent diagnose
gpubnb-agent start
```

La clé privée reste uniquement dans le dossier de configuration de la machine.
Voir `docs/AGENT.md` et `docs/TWO_PC_TEST.md`.

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

L'API seule ne suffit pas : sans le Delivery Worker, aucune réservation ne dépasse
jamais `AWAITING_DEPOSIT` (financement, démarrage de job, règlement). Dans un
second terminal :

```bash
npm run dev:delivery   # ou : npm run build && npm start:delivery
```

Pour reproduire une première location GPU réelle de bout en bout (y compris le
mode `DEV_PAYMENT_BYPASS` en développement), suivre `docs/FIRST_GPU_RENTAL_E2E.md`.
Un run complet, avec les bugs réellement rencontrés et corrigés, est documenté
dans `docs/FIRST_REAL_GPU_RENTAL_RESULT.md`.

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
