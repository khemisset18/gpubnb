# GPUbnb — Exploitation en bêta privée

Référence opérationnelle pour l'équipe qui supervise la bêta privée : trois processus à surveiller, journaux structurés à connaître, procédures de déblocage manuel.

## 1. Les trois processus

| Processus | Commande | Rôle | Nouveau dans cette branche |
|---|---|---|---|
| API | `npm start` (`dist/server.js`) | HTTP, auth, réservations, routes agent | Non |
| Delivery Worker | `npm run start:delivery` (`dist/delivery-worker.js`) | Publication des événements sortants, réconciliation des réservations en mode bypass | Résilience (Priorité 2) |
| Sweep Scheduler | `npm run start:sweep` (`dist/sweep-scheduler.js`) | Détection machines hors-ligne + jobs bloqués, toutes les `SWEEP_INTERVAL_MS` | Processus entier (Priorité 3) |

Les trois doivent tourner simultanément en production. L'absence du Sweep Scheduler ne provoque pas d'erreur visible immédiatement — les machines hors-ligne et jobs bloqués s'accumulent silencieusement jusqu'à investigation (c'était exactement le risque R2 de RC1).

## 2. Variables d'environnement de référence

Voir `apps/api/src/config.ts` (source de vérité, validée par `zod` au démarrage — tout démarrage réussi garantit des valeurs déjà valides) et `.env.example`. Nouvelles dans cette branche :

| Variable | Défaut | Effet |
|---|---|---|
| `SWEEP_INTERVAL_MS` | 30000 | Fréquence des cycles du Sweep Scheduler |
| `SWEEP_LOCK_TTL_MS` | 60000 | Durée de vie du verrou Redis distribué par cycle — doit rester supérieure au temps réel d'un cycle (voir section 4) |

## 3. Journaux structurés à surveiller

Tous les processus émettent du JSON sur stdout (une ligne = un événement). Ceux listés ici sont nouveaux dans cette branche ; les événements pré-existants (`delivery_worker_started`, `outbox_publish_failed`, etc.) restent inchangés.

### Sweep Scheduler
- `sweep_scheduler_started` — au démarrage, contient `intervalMs`/`lockTtlMs` effectifs.
- `sweep_cycle_completed` — un cycle a tourné ; contient les compteurs cumulés (`totals`) et les résultats du cycle (`jobsProcessed`, `machinesProcessed`, `machinesQuarantined`).
- `sweep_cycle_skipped_lock_held` — normal si une autre instance du scheduler tourne déjà (aucune action requise, c'est le mécanisme d'exclusivité qui fonctionne).
- `sweep_cycle_failed` — panne DB/Redis pendant un cycle ; surveiller `consecutiveFailures` — au-delà de 20, le process s'arrête volontairement (`sweep_scheduler_giving_up_after_sustained_failures`) et attend le redémarrage automatique de la plateforme.

### Delivery Worker (Priorité 2)
- `delivery_worker_connect_failed` — échec de connexion DB/Redis au démarrage, retry automatique en cours.
- `delivery_worker_iteration_failed` — panne pendant une itération de la boucle principale ; même seuil de 20 échecs consécutifs avant arrêt volontaire.

### API — exclusivité GPU (Priorité 4)
- `gpu_exclusivity_claim_deferred` — un agent a demandé un job mais le GPU (par `gpuUuid` ou par machine) était déjà occupé ; le job reste `QUEUED`, sera réclamé au prochain sondage. Normal en usage courant, à surveiller seulement si ça persiste anormalement longtemps pour une même machine.
- `gpu_exclusivity_claim_conflict` — conflit de sérialisation Postgres pendant la réclamation (deux sondages concurrents sur le même GPU) ; déjà retenté automatiquement, log de niveau `warn` uniquement.

### API — sweep manuel
- `offline_sweep_skipped_lock_held` (HTTP 409) — un opérateur a déclenché `/internal/sweep-offline` manuellement pendant qu'un cycle planifié tournait déjà ; relancer plus tard si nécessaire, ce n'est pas une erreur.

## 4. Dimensionner `SWEEP_LOCK_TTL_MS`

Le TTL doit couvrir le pire cas réaliste de durée d'un cycle (deux transactions Serializable sur les tables `Job`/`Machine`/`Booking`/`Payment`/`WorkspaceSession`). En bêta privée (volumétrie faible), le défaut de 60 s est large. Si `sweep_cycle_completed.durationMs` approche régulièrement la moitié du TTL configuré, l'augmenter — un TTL trop court sous une charge inattendue provoquerait l'expiration du verrou pendant qu'un cycle légitime est encore en cours, permettant (sans risque de corruption grâce à l'idempotence des sweeps, mais avec un travail redondant) à un second cycle de démarrer en parallèle.

## 5. Débloquer une machine quarantinée (`moderationStatus=QUARANTINED`)

Une machine est mise en quarantaine automatiquement dans deux cas : (1) un job signale un nettoyage de conteneur non confirmé (`diagnostic_cleanup_unverified`/`gpu_proof_cleanup_unverified`), (2) le sweep de staleness (Priorité 3 de la campagne RC1) constate un job bloqué sans possibilité de prouver le nettoyage. **Il n'existe aujourd'hui aucune route API dédiée à la levée de quarantaine** — c'est une action base de données directe (`UPDATE "Machine" SET "moderationStatus"='CLEAR' WHERE id=...`), à n'effectuer qu'après vérification manuelle réelle par un opérateur que le GPU concerné est effectivement libre (`nvidia-smi` sur la machine physique, absence de conteneur résiduel `docker ps -a`). Documenter cette vérification avant de lever la quarantaine — ne jamais lever une quarantaine « pour débloquer un hôte » sans cette vérification physique.

## 6. Ce qu'il ne faut jamais faire manuellement

- Supprimer `agent.lock`/`agent.pid` sur une machine hôte pendant qu'un processus agent semble actif (voir `BETA_PRIVATE_INSTALLATION.md` section 4).
- Modifier directement `Job.status` en base pour « débloquer » un job — les transitions autorisées sont dans `job-state.ts` ; un statut hors machine à états casse silencieusement les invariants (double règlement, double remboursement) que Priorité 3 et Priorité 4 garantissent précisément en respectant cette machine à états.
- Appeler `POST /internal/bookings/:id/settlement/confirm` avec une signature qui n'a pas été indépendamment vérifiée par un humain tant que la lacune décrite dans `BETA_PRIVATE_READINESS.md` section 2.2 n'est pas comblée — cette route fait confiance à la chaîne fournie sans preuve on-chain.

## 7. Surveillance recommandée pour la bêta privée

Aucun outil de supervision n'est fourni par ce dépôt (pas de Grafana/Prometheus configuré). Recommandation minimale pour la durée de la bêta : agréger les logs JSON des trois processus (n'importe quel collecteur acceptant stdout structuré) et alerter sur `sweep_cycle_failed`/`delivery_worker_iteration_failed` avec `consecutiveFailures` élevé, et sur toute apparition de `moderationStatus=QUARANTINED` en base (email/Slack manuel acceptable à cette échelle).
