# GPUbnb Workspaces — audit et fondation

## Audit actualisé

La stack reste HTML/CSS/JavaScript statique sur Netlify, API Fastify TypeScript
sur Render, Prisma/PostgreSQL, Redis, agent Python Ed25519 et contrat Anchor.
L’authentification Supabase/Phantom, les rôles locataire/loueur, la liaison
machine, les heartbeats et le moteur `GPU_DIAGNOSTIC` sont déjà en place.

Fichiers principalement concernés :

- `apps/api/prisma/schema.prisma` et les migrations ;
- `apps/api/src/server.ts`, `workspace-manifests.ts` et
  `workspace-compatibility.ts` ;
- `apps/web/workspaces.*`, le tableau de bord et plus tard la fiche machine ;
- `agent/gpubnb_agent/platform_info.py`, `cli.py` et le futur orchestrateur ;
- `docs/WORKSPACE_*.md` et les tests correspondants.

## Architecture proposée

1. Un catalogue versionné décrit chaque espace sans logique UI.
2. Le moteur de compatibilité confronte un manifeste aux capacités mesurées.
3. `MachineWorkspace` conserve score, explication, choix du propriétaire et
   limites.
4. Une future `WorkspaceSession` référencera réservation, machine, manifeste
   exact et mode d’isolation.
5. L’agent n’exécute que des commandes typées et signées. Il ne reçoit jamais
   une commande shell arbitraire.

## Dépendances

La fondation n’ajoute aucune dépendance externe. Prisma, Zod, Fastify, Python
standard et les signatures existantes suffisent. Les phases exécutables
nécessiteront ensuite un registre OCI, NVIDIA Container Toolkit, une solution
VM/microVM selon l’espace, un canal temps réel et éventuellement un stockage
d’artefacts abstrait.

## Limites honnêtes

`Compute Workspace` est en bêta car seul le diagnostic contrôlé est exécutable.
Les douze autres cartes décrivent le produit cible mais restent `UPCOMING` ou
`EXPERIMENTAL`. Aucun accès bureau, IDE, jeu, logiciel Adobe/CAO ou licence
commerciale n’est annoncé comme disponible.
