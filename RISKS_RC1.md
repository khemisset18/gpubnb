# Risques connus — RC1

Chaque risque ci-dessous a été identifié par un test réel ou une lecture de code vérifiée pendant la campagne RC1 (branche `feature/first-gpu-rental`), pas par supposition. Sévérité indicative : CRITIQUE (bloque une bêta privée), IMPORTANT (à traiter avant bêta publique), MINEUR (à traiter avant 1.0).

## Ouverts (non corrigés dans RC1)

### R1 — IMPORTANT — Le Delivery Worker n'a pas de politique de redémarrage automatique
**Trouvé :** Test 9b (Phase 5), coupure Docker réelle pendant un job actif.
**Preuve :** le processus réel `tsx watch src/delivery-worker.ts` a crashé pendant la perte de connexion Redis/Postgres et n'a pas été relancé par son propre wrapper — contrairement à l'API, qui a survécu à la même coupure. Redémarrage manuel nécessaire.
**Risque en production :** une panne transitoire de la base de données peut arrêter silencieusement tout le flux d'auto-financement/création de jobs sans alerte, jusqu'à intervention humaine.
**Correctif proposé :** superviseur de processus (systemd, pm2, ou `restart: always` si conteneurisé) pour le Delivery Worker en production.

### R2 — IMPORTANT — Aucun ordonnanceur pour `/internal/sweep-offline` dans ce dépôt
**Trouvé :** lecture de code (`offline-sweep-service.ts`, `job-staleness-sweep.ts`) + Test 6/8 (Phase 5).
**Preuve :** aucun `setInterval`/tâche cron trouvé dans `apps/api/src` appelant cette route ; elle n'a été déclenchée que manuellement pendant les tests.
**Risque en production :** sans tâche planifiée externe (cron, Render Cron Job, etc.), les machines hors-ligne et les jobs bloqués ne sont **jamais** réconciliés automatiquement, malgré l'existence du mécanisme.
**Correctif proposé :** ajouter la tâche planifiée à l'infrastructure de déploiement (hors périmètre de cette campagne : aucune nouvelle fonctionnalité de code n'a été ajoutée, seulement la logique de sweep elle-même).

### R3 — IMPORTANT — Aucune exclusivité GPU au niveau agent
**Trouvé :** Test 4 (Phase 5), confirmé en conditions réelles.
**Preuve :** un job de diagnostic officiel s'exécute sans dégradation en concurrence avec un processus tiers actif sur le même GPU (NVML supporte les lectures concurrentes). Aucun verrou d'exclusivité n'existe côté agent.
**Risque en production :** sans conséquence pour `GPU_DIAGNOSTIC` (lecture seule), mais si un futur type de job exige un accès GPU exclusif (calcul réel), rien n'empêche aujourd'hui deux jobs de se disputer la même carte physique.
**Correctif proposé :** verrou d'exclusivité côté agent avant `docker run` pour tout job de type calcul (hors `GPU_DIAGNOSTIC`).

### R4 — MINEUR — Deux instances d'agent peuvent tourner simultanément sans garde-fou
**Trouvé :** Test 6 (Phase 5), découverte incidente.
**Preuve :** deux processus agent distincts (résidus de tests précédents non nettoyés) tournaient en parallèle sur la même identité machine sans qu'aucun mécanisme ne le détecte ou l'empêche.
**Risque en production :** sans conséquence observée grâce au verrouillage atomique côté API sur la réclamation de job, mais reste un état non voulu, non détecté, non journalisé.
**Correctif proposé :** verrou de fichier PID robuste ou détection explicite au démarrage de l'agent.

### R5 — MINEUR — Couverture incomplète : timeout de workload (Test 2)
**Trouvé :** Phase 5, Test 2, trois tentatives réelles distinctes, toutes documentées.
**Preuve :** le workload officiel s'exécute en moins d'une seconde (indétectable pour un `docker pause` externe) ; le blocage réseau (IP unique puis plage CIDR entière) a soit été contourné par le pool d'IP GitHub, soit provoqué un rejet instantané côté pare-feu Windows plutôt qu'un vrai blocage réseau permettant d'atteindre le seuil de 120s.
**Risque :** le chemin de code `subprocess.run(timeout=120)` (`runner.py`) est correct par lecture de code et déjà couvert par des tests unitaires existants, mais **n'a pas été exercé en conditions réellement bout-en-bout** dans cette campagne.
**Correctif proposé :** aucun changement de code nécessaire ; si une preuve end-to-end est requise, prévoir un environnement de test avec blackhole réseau contrôlable (hors portée de cette machine de développement).

### R6 — MINEUR — Couplage Docker/infrastructure spécifique au dev local
**Trouvé :** Test 9a (Phase 5).
**Preuve :** Postgres et Redis tournent eux-mêmes dans des conteneurs Docker sur cette machine de développement (`docker-compose.yml`) — arrêter Docker Desktop arrête donc toute l'API, pas seulement la capacité GPU de l'agent.
**Risque :** aucun en production (Postgres/Redis y sont des services managés séparés, `render.yaml`) — ce risque n'existe que pour la reproduction locale des tests de cette campagne. Documenté pour éviter une confusion future lors d'une nouvelle session de test local.

## Résolus dans RC1 (mentionnés pour traçabilité — ne plus reproduire)

- Fuite de message d'erreur Prisma brut + absence de retry sur `POST /bookings` sous contention (`9f3f03e`).
- Absence de détection de staleness au niveau job, indépendante du heartbeat machine (`2d1acf7`).
- Absence de quarantaine machine suite à un rapport agent de nettoyage non vérifié (`d4b1698`).
- Voir `CHANGELOG.md` pour la liste complète des 18 défauts CRITIQUE (audit) et des 5 défauts trouvés pendant le premier parcours réel.

## Risques structurels non testés (hors périmètre RC1, pas des défauts trouvés)

- Flux de paiement Solana réel (escrow on-chain, signature Phantom) — jamais exercé, `DEV_PAYMENT_BYPASS=true` sur toute la campagne.
- Type de job `GPU_PROOF` et espace de travail interactif `WORKSPACE_PREPARE` — non testés en conditions réelles.
- Hôte et locataire sur deux machines physiques distinctes avec latence réseau réelle — non testé (même machine physique tout du long).
- Configuration matérielle unique (Windows 11 + Docker Desktop WSL2 + GTX 1650) — aucune validation croisée Linux natif ou autre GPU.
