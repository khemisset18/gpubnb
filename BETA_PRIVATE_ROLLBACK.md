# GPUbnb — Procédure de retour arrière (bêta privée)

Ce document couvre deux scénarios distincts : (A) revenir en arrière sur le code de cette branche avant fusion, et (B) réagir à un incident pendant que la bêta privée est déjà ouverte à de vrais hôtes/locataires.

## A. Avant fusion — annuler cette branche

Aucune modification de schéma de base de données n'a été faite dans `feat/beta-readiness-hardening` (vérifié : `apps/api/prisma/schema.prisma` non touché par cette branche). Toutes les modifications sont additives (nouveaux fichiers, nouvelles routes de processus, une route HTTP existante modifiée de façon rétrocompatible). Revenir en arrière avant fusion ne nécessite donc aucune migration inverse :

```bash
git checkout main
# La branche feat/beta-readiness-hardening peut être abandonnée sans effet sur main.
```

Si la branche a déjà été partiellement déployée (ex. `render.yaml` appliqué avec le nouveau service `gpubnb-sweep-scheduler`) : supprimer le service Render `gpubnb-sweep-scheduler` et redéployer l'API/Delivery Worker depuis `main`. Les variables d'environnement `SWEEP_INTERVAL_MS`/`SWEEP_LOCK_TTL_MS` peuvent rester définies sans effet — le code de `main` ne les lit pas.

## B. Pendant la bêta — incident avec la branche déjà en production

### B.1 Arrêt sûr des trois processus

Ordre recommandé pour éviter de laisser des réservations bloquées en cours de traitement :

1. Arrêter le Sweep Scheduler en premier (`SIGTERM` — il termine son cycle en cours avant de quitter, voir `interruptibleSleep`/`FailureTracker` dans `sweep-scheduler.ts`). Aucune perte : le prochain démarrage reprend au cycle suivant, sans état à restaurer (la « source de vérité » est `Job.status`/`Machine.moderationStatus`, jamais un état interne au process).
2. Arrêter le Delivery Worker (`SIGTERM` — draine les événements en vol jusqu'à `SHUTDOWN_GRACE_MS`, 20 s, avant de quitter).
3. L'API peut rester active (elle continue de servir les requêtes existantes ; sans Delivery Worker, les nouvelles réservations restent bloquées à `AWAITING_DEPOSIT`, ce qui est un état sûr, pas une corruption).

### B.2 Revenir à l'état RC1 (avant cette branche) en production

```bash
git log --oneline main..feat/beta-readiness-hardening   # confirmer les 4 commits à annuler
git checkout main
npm run build   # dans apps/api
```

Redéployer l'API et le Delivery Worker depuis `main`. Supprimer (ou laisser inactif) le service `gpubnb-sweep-scheduler` — son absence fait revenir exactement au comportement RC1 documenté dans `RISKS_RC1.md` (R1-R4 réouverts, aucune régression au-delà de ce qui était déjà connu et documenté). **Aucune donnée n'est perdue** : les tables `Job`/`Machine`/`Booking`/`Payment` ne changent pas de forme entre `main` et cette branche.

### B.3 Réservations et jobs en cours au moment du retour arrière

- Un job `ASSIGNED`/`RUNNING` au moment de l'arrêt reste dans cet état jusqu'à ce que l'agent le complète normalement (le retour arrière n'affecte pas l'agent, qui continue de suivre le job qu'il a en cours) — ou jusqu'à ce que le sweep de staleness (présent aussi sur `main`, hérité de RC1) le détecte comme bloqué après `JOB_STALE_AFTER_SECONDS`.
- Sans le Sweep Scheduler dédié (retour à `main`), ce sweep de staleness ne s'exécute plus automatiquement — redéclencher manuellement `POST /internal/sweep-offline` (jeton `INTERNAL_SERVICE_TOKEN`) le temps de remettre en place un ordonnanceur externe (cron, tâche planifiée) si le retour arrière doit durer.
- Aucune réservation `FUNDED`/`ACTIVE` ne peut être « perdue » par ce retour arrière : le pire cas est qu'elle reste bloquée jusqu'à intervention manuelle, jamais qu'elle soit réglée deux fois ou remboursée deux fois (garanti par les transitions gardées par statut source, inchangées entre les deux branches).

### B.4 Incident spécifique : exclusivité GPU en défaut (Priorité 4)

Si un doute existe sur le verrou d'exclusivité GPU (ex. deux jobs constatés actifs simultanément sur le même GPU malgré le correctif) :

1. Ne pas désactiver le correctif en isolation — revenir entièrement à `main` (section B.2) le temps d'investiguer, pour garder un comportement cohérent et déjà documenté plutôt qu'un état intermédiaire non testé.
2. Mettre en quarantaine manuellement (`moderationStatus='QUARANTINED'`) toute machine impliquée, le temps de vérifier physiquement l'état réel du GPU (voir `BETA_PRIVATE_OPERATIONS.md` section 5).
3. Collecter les journaux `gpu_exclusivity_claim_deferred`/`gpu_exclusivity_claim_conflict` avant de les faire tourner (rotation de logs) — nécessaires pour rejouer l'incident.

### B.5 Incident spécifique : paiement réel engagé par erreur

Rappel : le programme d'escrow n'est déployé nulle part (`BETA_PRIVATE_READINESS.md` section 2), donc ce scénario ne devrait structurellement pas pouvoir se produire pendant la bêta privée telle que scopée par ce document. S'il se produisait malgré tout (ex. un opérateur déploie le programme de sa propre initiative en cours de bêta) : arrêter immédiatement tout nouveau `POST /bookings/:id/payment-intent` en remettant `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET`, et traiter toute transaction déjà émise comme un incident financier réel — hors du périmètre de ce document, qui suppose l'absence d'argent réel pendant la durée couverte ici.

## C. Ce qui n'est PAS couvert par cette procédure

- Restauration d'une sauvegarde de base de données (aucune stratégie de sauvegarde/restauration n'est documentée dans ce dépôt — à définir avant la bêta, hors périmètre de cette branche).
- Retour arrière du contrat Solana (non applicable, jamais déployé).
- Communication aux utilisateurs bêta en cas d'incident (procédure humaine, à définir séparément).
