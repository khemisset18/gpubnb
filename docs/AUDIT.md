# Audit technique GPUbnb

Date : 23 juillet 2026  
Portée : dépôt `khemisset18/gpubnb`, branche `main`.

## Synthèse

GPUbnb est une base Devnet cohérente, avec un frontend statique, une API Fastify
TypeScript, PostgreSQL/Prisma, Redis, un programme Anchor et un agent Python.
La CI compile et teste ces composants. Le projet n'est cependant pas encore une
plateforme de location GPU entre deux PC : le moteur de tâches, l'installation
de l'agent, la liaison simple, les résultats et le programme Solana déployé
manquent.

## Technologies et structure

- Frontend : HTML/CSS/JavaScript statique, Netlify.
- API : Node.js 22, TypeScript strict, Fastify, Zod, Prisma.
- Données : PostgreSQL, Redis pour sessions, nonces et challenges.
- Identité : Supabase Auth (Google/e-mail) et signature Phantom.
- Paiement : programme Rust Anchor, intégration Solana Web3, Devnet verrouillé.
- Agent : Python, PyNaCl/Ed25519, interrogation `nvidia-smi`.
- Isolation : scripts Docker durcis, non encore pilotés par un moteur de tâches.
- Hébergement : Netlify + Render.
- CI : GitHub Actions, tests Node/Rust, Gitleaks et Trivy.

## Fonctionnel et vérifié

- Authentification Google/e-mail/Phantom et session serveur.
- Profil privé/public avec espaces locataire et loueur.
- PostgreSQL/Prisma et migrations versionnées.
- Redis pour session, challenge et anti-rejeu.
- Création d'une machine à partir d'une clé publique Ed25519.
- Heartbeat avec challenge, signature, compteur et contrôles de cohérence.
- Mise hors ligne serveur et masquage des annonces.
- Annonces persistées en base et filtrées par fraîcheur du heartbeat.
- Réservation avec idempotence et contrainte PostgreSQL anti-chevauchement.
- Construction et vérification serveur d'une transaction escrow.
- Calcul 95 % fournisseur / 5 % plateforme testé.
- Programme Anchor compilé et testé en CI.
- Conteneur Docker de workload avec capacités supprimées, réseau coupé,
  utilisateur non-root, ressources et timeout.
- CI verte, audit npm, Gitleaks et Trivy.

## Partiellement fonctionnel

- L'agent sait signer et envoyer un heartbeat, mais n'est pas un produit
  installable et n'a pas de commandes.
- La publication exige encore la copie d'une clé publique technique.
- Le contrat Anchor existe, mais aucun Program ID Devnet réel n'est configuré.
- Les tableaux de bord exposent les données principales, pas encore les tâches,
  artefacts, notifications, litiges et revenus complets.
- Les modèles de messagerie, avis et forum existent, sans routes produit.
- Le script Docker est robuste, mais aucune tâche serveur ne le déclenche.

## Simulé ou local uniquement

- `Demandes` et `Propositions` utilisent `localStorage`.
- Certaines annonces de démonstration historiques existent côté navigateur.
- Le parcours paiement est bloqué volontairement par
  `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET`.
- Aucun benchmark GPU certifié ni preuve d'exécution entre deux PC.

## Cassé ou bloquant

- L'ancien agent s'exécute dès l'import et exige des variables d'environnement.
- Il suppose `nvidia-smi` dans un PATH Linux forcé.
- Il n'existe ni `setup`, ni stockage de configuration, ni liaison par code.
- Aucun moteur `jobs`, polling agent, logs progressifs ou artefacts.
- Aucun test automatisé Python de l'agent.
- Les doublons de fichiers racine (`server.ts`, `agent.py`, schémas et frontend)
  créent un risque de modifier la mauvaise copie.

## Manques majeurs

- CLI agent Windows/Linux et packaging.
- Liaison à usage unique, rotation/révocation de clés.
- Inventaire CPU/RAM/disque/Docker/CUDA/réseau.
- Tables et API jobs, tentatives, logs, artefacts, notifications, litiges,
  événements de sécurité et audit.
- Machine à états explicite des tâches et réservations.
- `GPU_DIAGNOSTIC` réellement exécuté dans Docker avec GPU.
- Page détail annonce, filtres, disponibilité et favoris.
- Demandes/propositions persistées en base.
- Administration et rôles admin/support.
- Stockage objet sécurisé pour les résultats.

## Sécurité

### Protections présentes

- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`.
- Validation Zod, limites de corps et rate limiting.
- Nonces consommés, compteurs et challenges anti-rejeu.
- Signatures Ed25519 côté serveur.
- Vérification on-chain côté backend.
- Secrets générés côté hébergeur, scanners CI et logs expurgés.
- Sandbox Docker non privilégiée.

### Risques et limites

- Pas de table d'événements de sécurité durable.
- Pas de révocation/rotation de clé agent.
- Pas de RLS applicable aux tables Prisma : l'autorisation repose entièrement
  sur l'API.
- Les routes sont concentrées dans un seul `server.ts`, difficile à auditer.
- Le token Supabase public est volontairement public, mais les secrets serveur
  doivent rester uniquement dans Render.
- Aucun upload/artefact n'est permis actuellement ; il faudra concevoir les
  contrôles avant de l'activer.
- La sandbox n'a pas encore subi de pentest d'évasion.
- Mainnet reste strictement NO-GO.

## Architecture et base de données

- Les relations principales sont bonnes, mais le schéma mélange des fonctions
  déjà exposées et des tables sans API.
- `Machine` ne conserve pas encore version agent, OS, CUDA, puissance, RAM,
  disque, Docker et runtime NVIDIA.
- `Heartbeat` ne conserve qu'un sous-ensemble de la télémétrie.
- Il manque un historique générique des transitions.
- Les identités Supabase sont placées dans le champ historique `wallet` sous la
  forme `supabase:<uuid>` ; une future migration devra renommer ce concept.

## Frontend et design

- Identité visuelle cohérente, responsive et moderne.
- Les états de compte principaux existent.
- La publication reste trop technique.
- Demandes/propositions sont trompeuses car locales au navigateur.
- Pas de page annonce détaillée, de filtres avancés ni de suivi de tâche.
- Plusieurs boutons requis par le produit n'existent pas encore ; aucun faux
  bouton ne doit être ajouté avant son API.

## Variables requises

API : `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`,
`INTERNAL_SERVICE_TOKEN`, `PUBLIC_APP_DOMAIN`, `PLATFORM_WALLET`,
`SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `ESCROW_PROGRAM_ID`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`.

Agent Phase 1 : URL API, configuration locale, clé Ed25519 locale et
`machineId` obtenu par liaison. Aucun secret agent ne doit être ajouté au
frontend ou au serveur.

## Priorités

1. P0 : agent installable, liaison simple, diagnostic, heartbeat multiplateforme.
2. P0 : test documenté entre deux PC sans exécution arbitraire.
3. P1 : moteur de tâches `GPU_DIAGNOSTIC` et logs.
4. P1 : réservations/disponibilités et Devnet réel.
5. P2 : rotation de clés, événements de sécurité et sandbox auditée.
6. P3 : marketplace complète et UX.
7. P4 : administration, conformité, audit externe et production.

