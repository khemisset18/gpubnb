# Roadmap GPUbnb

## P0 — Test entre deux PC

- [x] CLI agent Windows 10/11 et Ubuntu.
- [x] `setup`, clé locale, diagnostic et configuration persistante.
- [x] Code de liaison à usage unique entre compte et machine.
- [x] Heartbeats signés et télémétrie multiplateforme.
- [ ] Assistant web d'installation de l'agent.
- [ ] Scénario `TWO_PC_TEST.md` reproductible.
- [ ] Moteur minimal `GPU_DIAGNOSTIC` sans code utilisateur.

## P1 — Vraie location Devnet

- [ ] Disponibilités, acceptation et historique des réservations.
- [ ] Jobs, tentatives, logs paginés et résultats JSON.
- [ ] Polling agent autorisé uniquement pour sa machine.
- [ ] Exécution Docker GPU isolée et nettoyage.
- [ ] Déploiement du programme Anchor sur Devnet.
- [ ] Escrow, règlement, remboursement et liens Explorer.
- [ ] Demandes/propositions migrées de `localStorage` vers PostgreSQL.

## P2 — Sécurité et fiabilité

- [ ] Rotation/révocation des clés agent.
- [ ] Événements de sécurité et journal d'audit durable.
- [ ] Machine à états testée pour jobs et réservations.
- [ ] Quotas, timeouts, limites de logs et artefacts.
- [ ] Stockage objet avec URL temporaire, checksum et expiration.
- [ ] Tests d'évasion Docker, panne, reprise et charge.
- [ ] Supervision, alertes et sauvegarde/restauration.

## P3 — Expérience utilisateur

- [ ] Filtres, tri, pagination et page annonce détaillée.
- [ ] Assistant agent en six étapes.
- [ ] Suivi temps réel des tâches.
- [ ] Notifications, messagerie, avis, favoris et litiges.
- [ ] Tableaux de bord complets et accessibilité.
- [ ] Installateurs Windows/Linux signés.

## P4 — Préparation production

- [ ] Administration avec permissions et audit.
- [ ] Rôles `renter`, `provider`, `support`, `admin`.
- [ ] RPC privé, multisignature et gestion de clés.
- [ ] Audit indépendant contrat/API/agent/sandbox.
- [ ] Juridique, confidentialité, fiscalité et sanctions.
- [ ] Mainnet uniquement après passage de toutes les portes NO-GO.
