# Système de quarantaine, diagnostic et disponibilité machine

Construit le 2026-09-01. Statut : **implémenté, testé localement (523/523 tests API + 368/368 tests
agent), NON déployé** (aucun push, aucun déploiement — voir "Ce qui reste à faire").

## 0. Constat de départ (investigation réelle, avant tout code)

- La machine réelle de l'utilisateur (`cmsiggruy0004df0tn669f6bn`) est en quarantaine côté API
  (`Machine.moderationStatus = QUARANTINED`) en continu depuis au moins `2026-08-30T00:58`
  (preuve : 4 fichiers de logs agent réels, et le fichier local
  `C:\ProgramData\GPUbnb\gpu-resource-rental-v1.json`, qui montre une quarantaine agent-side
  séparée, horodatée `2026-08-30 00:57:57` locale, sur la session `cmtezdkuo01iok30tse8g5ye1`).
- 6 endroits dans `apps/api/src` écrivaient `moderationStatus = QUARANTINED`, plus un 7e trouvé
  en cours de chantier (`/agent/jobs/:id/state`, cas `cleanupUnverified`). **Aucun** endroit dans
  toute la base ne réécrivait `moderationStatus = CLEAR` avant ce chantier — une quarantaine
  était donc, avant ce chantier, définitive par construction, pour **toutes** les machines.
- `GET /agent/challenge/:machineId` refusait (403 `machine_quarantined`) toute machine
  quarantinée avant même de vérifier sa signature — bloquant tout heartbeat ultérieur (le
  heartbeat a besoin d'un challenge frais). Explique aussi les `401 invalid_agent_request` en
  continu observés sur `/agent/workspace-gateway/next-batch` et `/agent/mining/.../rental-authority`.
- Le frontend (`rental-owner.js`) n'affichait que le badge d'état ; `blockingReason` était
  calculé côté serveur mais jamais lu côté client, et pour `QUARANTINED` il était codé en dur à
  `RESOURCE_QUARANTINED` (générique).
- Le compte de l'utilisateur possède une deuxième machine fantôme (`cms7dbmn30001ie0to0i04iu6`,
  agent 0.5.0, aucun heartbeat depuis le 30/07/2026).

## 1. Architecture construite

### 1.1 Base de données (migration `20260901005635_add_quarantine_diagnostics_lifecycle`)

- Enums : `QuarantineReasonCode` (11 codes stables), `QuarantineEventStatus`
  (ENTERED/DIAGNOSTIC/CLEARED/REENTERED), `DiagnosticRunStatus`
  (RUNNING/COMPLETED/FAILED/TIMED_OUT), `DiagnosticTrigger` (OWNER/SYSTEM/ADMIN),
  `MachineLifecycleStatus` (ACTIVE/STALE/OFFLINE/RETIRED).
- Table **`MachineQuarantineEvent`** (historique immuable) : id, machineId, status, reasonCode,
  reason, details (JSON), source, createdAt, resolvedAt, diagnosticRunId. Une nouvelle
  quarantaine n'écrase jamais l'ancienne — elle ajoute une ligne `ENTERED` ou `REENTERED`.
- Table **`DiagnosticRun`** : id, machineId, status, checks (JSON), triggeredBy, triggeredById,
  error, startedAt, completedAt.
- `Machine` : + `quarantineReasonCode`, `quarantinedAt`, `lastDiagnosticRunId`,
  `lastDiagnosticAt`, `lifecycleStatus`, `retiredAt`, `retiredReason` (état courant — un
  instantané, jamais la source de vérité historique).
- Migration écrite à la main (pas `prisma migrate dev`) pour rester strictement additive et ne
  jamais toucher au drift préexistant, non lié, de cette base de dev locale (tables
  `MachineAccelerator`/`OutboxEvent`/etc. héritées d'anciens tests, hors sujet).

### 1.2 Registre des causes (`apps/api/src/quarantine-reason-registry.ts`)

11 codes stables (`CRITICAL_GPU_IDENTITY_CHANGE`, `DIAGNOSTIC_COMPLETION_RACE`, `STALE_CLAIM`,
`STALE_JOB`, `WORKSPACE_CLEANUP_FAILED`, `AGENT_SECURITY_FAILURE`, `GPU_HEALTH_CHECK_FAILED`,
`GPU_UNAVAILABLE`, `DOCKER_UNAVAILABLE`, `NVIDIA_RUNTIME_UNAVAILABLE`, `UNKNOWN`), chacun avec
titre, description, sévérité (INFO/WARNING/CRITICAL), impact, conditions de déclenchement,
et `autoRecoverable`.

### 1.3 Service de quarantaine (`apps/api/src/quarantine-service.ts`)

- `enterQuarantine(tx, {...})` : seule fonction qui écrit `moderationStatus = QUARANTINED`.
  Idempotente (ENTERED la 1re fois, REENTERED ensuite), `quarantinedAt` ne bouge jamais tant que
  la quarantaine reste continue. Ajoute toujours une ligne d'historique.
- `clearQuarantine(tx, {...})` : **seule** fonction qui écrit `moderationStatus = CLEAR`. Clôt
  les événements ouverts (`resolvedAt`), ajoute une ligne `CLEARED`. Découverte en testant :
  nettoie aussi `Accelerator.moderationStatus`/`Accelerator.status` (qui ne sont, dans toute
  cette base de code, jamais qu'un miroir du `Machine.moderationStatus` au dernier sync
  d'inventaire — sans ce nettoyage, la levée de quarantaine restait invisible jusqu'au heartbeat
  suivant).
- `recordDiagnosticEvent(tx, {...})` : ligne d'historique neutre (ex. "diagnostic lancé") sans
  changer l'état.

Les **6 anciens sites** + le 7e trouvé en cours de route (`accelerator-security-executor.ts`,
`dev-booking-reconciler.ts` ×2, `job-staleness-sweep.ts`, `workspace-gateway.ts`, `server.ts`
×2 : heartbeat + `/agent/jobs/:id/state`) ont tous été migrés vers `enterQuarantine()`, chacun
avec le reasonCode réel correspondant à sa cause métier.

### 1.4 Diagnostic réel (`apps/api/src/diagnostic-run-service.ts`)

- `createDiagnosticRun()` : crée un `DiagnosticRun` RUNNING (idempotent — ne relance pas si un
  diagnostic est déjà en cours et récent).
- `evaluateDiagnosticChecks()` : fonction pure. Checks obligatoires pour lever une quarantaine :
  `agent`, `gpu`, `gpuUuid`, `driver`, `docker`, `nvidiaRuntime`. `ram`/`cuda` sont
  informationnels (compatibilité Workspace uniquement, jamais bloquants pour la quarantaine —
  conforme à l'exemple exact donné : "12 Go RAM, Developer compatible, Data incompatible = pas
  de quarantaine"). **UNKNOWN et NOT_CHECKED ne sont jamais promus en PASS.**
- `completeDiagnosticRun()` : seule fonction qui décide clear vs maintien, à partir des checks
  réels. Une erreur d'exécution agent (le diagnostic n'a pas pu tourner) → `FAILED`, quarantaine
  maintenue avec la raison déjà connue. Un diagnostic qui s'exécute mais échoue un check → réentre
  en quarantaine avec le reasonCode du premier check en échec. Un diagnostic qui passe tous les
  checks obligatoires → `clearQuarantine()`.
- Statut effectif `TIMED_OUT` calculé paresseusement (3 min sans réponse), sans cron dédié.

### 1.5 Réparation (`apps/api/src/machine-repair-service.ts`) — **scope volontairement restreint**

Une seule action sûre, réellement implémentée : `CLEAR_ORPHANED_ALLOCATIONS` — corrige les
lignes `AcceleratorAllocation` restées actives alors que leur réservation est déjà `COMPLETED`/
`CANCELLED`. Ne touche jamais `MiningResource.activeRentalId` (la vraie porte d'exclusivité de
réservation), ni aucun processus réel sur la machine. Réparer ne lève jamais la quarantaine —
seul un nouveau diagnostic réel, ensuite, le peut.

**Ce qui n'est PAS implémenté et pourquoi** : redémarrer l'agent, tuer un processus GPU distant,
etc. nécessiteraient un canal de commande authentifié vers l'agent. Celui-ci existe dans le code
("Machine Command Gateway") mais est **désactivé à 0% de rollout par choix produit antérieur** —
l'activer/l'exploiter en toute sécurité est un chantier à part entière, hors du périmètre
raisonnable de cette session.

### 1.6 Disponibilité machine centrale (axe "MachineReadiness")

`computeMachineState()` (`apps/api/src/machine-state-service.ts`) **existait déjà** avant ce
chantier et s'est révélé être précisément la fonction centrale demandée — elle est déjà la seule
source utilisée par la publication d'annonce (`createExactGpuListing` → `machine_not_publishable`
avec la vraie cause) et cohérente avec la réservation (`resource-allocation-service.ts` vérifie
`moderationStatus === CLEAR` séparément mais avec la même donnée source). Ce chantier l'enrichit :
- `blockingReason` pour `QUARANTINED` renvoie désormais le vrai `quarantineReasonCode` (ex.
  `GPU_HEALTH_CHECK_FAILED`) au lieu du générique `RESOURCE_QUARANTINED`.
- `rental-listing-service.ts` (`listOwnerRentalMachines`, `projectMachineState`) transmet ce
  code, plus `quarantinedAt`/`lastDiagnosticAt`/`lifecycleStatus`.

Un test croisé (`quarantine-diagnostics-system.test.ts`) prouve, contre une vraie base Postgres,
que la même quarantaine bloque à la fois la publication (`createExactGpuListing`) et la location
(`allocateBookingResources`) — Host, publication et réservation utilisent bien la même source.

### 1.7 Lifecycle machine / machine fantôme (`computeLifecycleStatus`, `rental-listing-service.ts`)

Calculé en direct depuis `lastHeartbeatAt` (pas stocké, ne peut donc jamais devenir lui-même
obsolète) : `RETIRED` (explicite, prioritaire) > `OFFLINE` si aucun heartbeat, sinon `STALE` à
30+ jours sans heartbeat, `OFFLINE` à 10h+, `ACTIVE` sinon.
`POST /rental/machines/:id/retire` (soft delete — `lifecycleStatus=RETIRED`, historique
conservé, annonces mises en pause) et `.../reactivate`.

### 1.8 Endpoints (`apps/api/src/machine-diagnostics-routes.ts`)

**Côté agent (fonctionnent MALGRÉ la quarantaine — nouvelle authentification dédiée
`authenticateQuarantinableAgent`, qui vérifie la signature Ed25519 mais jamais
`moderationStatus`)** :
- `GET /agent/diagnostics/next/:machineId` — renvoie le diagnostic en attente, s'il y en a un.
- `POST /agent/diagnostics/:diagnosticRunId/result` — reçoit le résultat réel, construit les
  checks à partir : (a) du résultat du conteneur de diagnostic officiel (`gpu`, `gpuUuid`), (b)
  du dernier heartbeat authentifié pour `docker`/`nvidiaRuntime`/`driver`/`cuda`/`ram`, jamais du
  navigateur.

**Côté propriétaire (session requise, `canHost`)** :
- `GET /rental/machines/:machineId/diagnostics` — vue complète (état, quarantaine avec preuve,
  checklist, compatibilité par Workspace, réparation disponible ou non, historique).
- `POST .../diagnostics/rerun` — crée un `DiagnosticRun` réel.
- `POST .../diagnostics/repair` — applique l'unique réparation sûre si détectée.
- `POST .../retire` / `.../reactivate`.

**Admin, très contrôlé** (`POST /internal/machines/:machineId/quarantine/force-clear`) : exige le
`INTERNAL_SERVICE_TOKEN` (même mécanisme que les autres routes `/internal/*` existantes — pas de
notion de rôle admin dans le schéma actuel, donc pas de nouveau système de rôles inventé).
Journalise `FORCED_QUARANTINE_CLEAR` (`req.log.warn`) et enregistre un événement d'historique
avec `details.forced = true` et `forcedByAdminId` — jamais caché. **Aucun bouton "Forcer" côté
propriétaire.**

### 1.9 Correction du verrou identifié en investigation

`GET /agent/challenge/:machineId` ne bloque plus sur `moderationStatus`. Une machine quarantinée
peut donc de nouveau obtenir un challenge, envoyer un heartbeat, et faire tourner un diagnostic.
**Aucun code de `/agent/heartbeat` n'écrit `CLEAR`** (vérifié par test source) — un heartbeat
seul ne peut donc jamais lever une quarantaine, uniquement la faire persister/se réactualiser.

### 1.10 Agent (`agent/gpubnb_agent/cli.py`)

Nouvelle boucle `poll_and_run_diagnostic_once()`, indépendante de `run_next_job` (qui reste
scopé aux jobs liés à une réservation), lancée dans son propre thread après chaque heartbeat
réussi — donc y compris pendant une quarantaine. Réutilise `run_gpu_diagnostic()` (déjà
existant, déjà testé) et le protocole de signature existant (`agent_request`).

### 1.11 Frontend

- `apps/web/machine-diagnostics.html` + `.js` (nouvelle page "État & diagnostics") : cause
  réelle avec preuve, checklist PASS/FAIL/WARNING/UNKNOWN/NOT_CHECKED par vérification,
  compatibilité par Workspace, historique complet, bouton "Relancer le diagnostic",
  bouton "Réparer automatiquement" (affiché uniquement si une réparation sûre existe). **Aucun
  bouton pour lever la quarantaine directement.**
- `apps/web/rental-owner.js` : affiche désormais la vraie cause (`blockingReason` /
  `quarantineReasonCode`), lien vers la nouvelle page, notice + bouton "Retirer cette machine"
  pour une machine `STALE`.
- `apps/web/publish.js` : la carte de codes d'erreur (`BLOCKING_REASON`) couvre maintenant aussi
  les codes machine (avant : uniquement les codes accélérateur — un refus de publication au
  niveau machine affichait un code brut, pas un message).

## 2. Tests

- **API** : 523/523 tests passent (503 préexistants, tous encore verts après le refactor des 7
  sites de quarantaine ; 20 nouveaux). Nouveaux fichiers : `diagnostic-run-service.test.ts` (6
  tests purs sur `evaluateDiagnosticChecks`), `quarantine-diagnostics-system.test.ts` (12 tests
  contre une vraie base Postgres locale : historique immuable, REENTERED, clear qui résout
  l'historique, forçage admin tracé, diagnostic PASS→clear, diagnostic FAIL→maintien avec le bon
  reasonCode, échec d'exécution→maintien, réparation qui ne lève jamais la quarantaine seule,
  publication refusée si quarantiné, réservation refusée si quarantiné, machine stale identifiée,
  challenge accessible malgré quarantaine, **boucle end-to-end complète**
  QUARANTINED→diagnostic→PASS réel→CLEAR→publication réussie). `machine-state-service.test.ts`
  +2 tests (reasonCode réel propagé, machine offline jamais READY).
- **Agent** : 368/368 tests passent (364 préexistants + 4 nouveaux pour
  `poll_and_run_diagnostic_once` : no-op si rien en attente, exécution réelle + rapport,
  échec d'exécution rapporté comme erreur explicite, image de diagnostic manquante rapportée
  comme erreur explicite).
- Un vrai bug a été trouvé et corrigé **par les tests eux-mêmes** en cours de route : sans le
  nettoyage `Accelerator.moderationStatus`/`.status` dans `clearQuarantine()`, le test
  end-to-end échouait — la publication restait refusée (`ACCELERATOR_QUARANTINED`) même après
  une levée de quarantaine réussie côté machine, parce que l'accélérateur gardait son propre
  miroir figé jusqu'au heartbeat suivant.

## 3. Ce qui reste à faire (explicitement hors de ce qui a été livré)

1. **Rien n'a été poussé ni déployé** (conforme à l'instruction explicite). Le système existe
   dans le dépôt local uniquement (branche `main`, commits locaux).
2. La machine réelle de l'utilisateur **n'a pas encore été diagnostiquée avec le nouveau
   système** : cela nécessite que `gpubnb.onrender.com` (production) et `gpubnb.netlify.app`
   tournent avec ce code, ce qui exige un déploiement — explicitement non autorisé pour l'instant.
3. Le lien "Voir les diagnostics" depuis un refus de publication (`publish.js`) n'est pas encore
   cliquable — seul le message texte a été corrigé.
4. Réparation automatique : un seul type de réparation sûre est implémenté (nettoyage
   d'allocations orphelines). Toute réparation nécessitant une commande vers l'agent (redémarrage,
   libération de processus GPU) est explicitement hors périmètre (Machine Command Gateway
   désactivé par choix produit antérieur).
