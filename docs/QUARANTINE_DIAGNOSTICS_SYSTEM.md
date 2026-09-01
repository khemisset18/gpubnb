# Système de quarantaine, diagnostic et disponibilité machine

Construit et **déployé en production le 2026-09-01**. Statut : implémenté, testé localement
et en production, **utilisé avec succès pour sortir la vraie machine de l'utilisateur
(`cmsiggruy0004df0tn669f6bn`) de quarantaine par une preuve réelle**. Voir §13 pour le
compte-rendu complet du déploiement et de la revalidation réelle.

## Sommaire

1. Architecture
2. États machine (MachineReadiness)
3. Reason codes
4. Diagnostic réel
5. Réparation automatique
6. Revalidation et sortie de quarantaine
7. Force-clear administrateur
8. Publication d'annonce
9. Sécurité
10. Observabilité
11. Procédures
12. État réel de production / ce qui reste à faire
13. Déploiement réel et revalidation réelle (2026-09-01)
14. Correction de l'automatisation du diagnostic sur le vrai agent Windows (2026-09-01)
15. Chaîne officielle de build/release/installation/update de l'agent Windows (2026-09-01)

---

## 1. Architecture

```
Agent (authentifié Ed25519)
   │  heartbeat (toujours actif, même quarantiné)
   │  diagnostic (toujours actif, même quarantiné)
   ▼
API : machine-diagnostics-routes.ts ─────────┐
   │                                          │
   ├─ quarantine-service.ts                   │  authenticateQuarantinableAgent()
   │    enterQuarantine()  ← 7 sites réels     │  (signature vérifiée, moderationStatus
   │    clearQuarantine()  ← SEUL point de     │   jamais requis - voir §9)
   │                          sortie           │
   ├─ diagnostic-run-service.ts               │
   │    createDiagnosticRun()                 │
   │    completeDiagnosticRun() → decide clear/maintain à partir des checks réels
   │    evaluateDiagnosticChecks() (pure)      │
   │                                          │
   ├─ machine-repair-service.ts               │
   │    detectAvailableRepair() / applyRepair() (bookkeeping seul, jamais un process réel)
   │                                          │
   └─ machine-state-service.ts (computeMachineState - PRÉEXISTANT, source de vérité)
        │
        ├── utilisé par rental-listing-service.ts → createExactGpuListing() (publication)
        ├── utilisé par resource-allocation-service.ts → allocateBookingResources() (réservation)
        └── utilisé par machine-diagnostics-routes.ts → GET .../diagnostics (Host)
```

**Principe central** : `computeMachineState()` est LA fonction qui décide si une machine est
publiable/réservable. Elle existait déjà avant ce chantier (`machine-state-service.ts`) et
gouvernait déjà publication ET réservation à partir des mêmes colonnes (`Machine.moderationStatus`
notamment) — c'est exactement la fonction `MachineReadiness` demandée. Ce chantier ne l'a pas
remplacée : il l'a enrichie (vrai `quarantineReasonCode` au lieu du générique
`RESOURCE_QUARANTINED`) et lui a donné, pour la première fois, un vrai mécanisme pour que l'état
`QUARANTINED` puisse un jour redevenir autre chose qu'`QUARANTINED`.

### Fichiers

| Fichier | Rôle |
|---|---|
| `quarantine-reason-registry.ts` | Registre statique des reason codes (titre, description, sévérité, impact, preuve, action, etc.) |
| `quarantine-service.ts` | `enterQuarantine()` / `clearQuarantine()` / `recordDiagnosticEvent()` — seuls points d'écriture de `moderationStatus` |
| `diagnostic-run-service.ts` | `createDiagnosticRun()` / `completeDiagnosticRun()` / `evaluateDiagnosticChecks()` |
| `machine-repair-service.ts` | `detectAvailableRepair()` / `applyRepair()` |
| `machine-diagnostics-routes.ts` | Tous les endpoints agent/propriétaire/admin |
| `machine-state-service.ts` | `computeMachineState()` (préexistant, enrichi) |
| `rental-listing-service.ts` | `computeLifecycleStatus()` (nouveau), `projectMachineState()` (préexistant) |

---

## 2. États machine (MachineReadiness)

`computeMachineState()` reste la seule source de vérité, avec ses 17 états déjà existants
(`machine-state-service.ts:MachineRentalState`). Correspondance avec le vocabulaire demandé :

| État demandé | État réel utilisé | Note |
|---|---|---|
| OFFLINE | `OFFLINE` | heartbeat absent ou périmé |
| HEARTBEAT_STALE | `OFFLINE` | même état — un heartbeat périmé EST hors-ligne pour la disponibilité |
| QUARANTINED | `QUARANTINED` | `blockingReason` = le vrai `quarantineReasonCode` |
| DIAGNOSTIC_RUNNING | `DIAGNOSTIC_RUNNING` | déjà existant (`operational=VERIFYING`) |
| REPAIR_REQUIRED | *(dérivé)* | pas un état machine séparé - `GET .../diagnostics` renvoie `repair!=null` quand une réparation sûre est détectée, indépendamment de l'état machine |
| REPAIRING | *(transitoire, non persisté)* | l'application d'une réparation est synchrone (une requête HTTP) ; il n'y a pas de fenêtre "en cours" à représenter |
| READY / PUBLISHABLE | `READY_TO_PUBLISH` / `LISTING_ACTIVE` | `state.canPublish` / `state.canAcceptBooking` |
| BUSY / IN_USE | `RESERVED` / `SESSION_STARTING` / `SESSION_ACTIVE` | |
| ERROR | `DIAGNOSTIC_FAILED` | dernier diagnostic en échec (`operational=DEGRADED`) |
| UNKNOWN | *(n'existe pas comme état machine)* | `UNKNOWN` est un **reasonCode** (cause non déterminable), jamais un état machine flou |

Décision délibérée : ne pas créer un second enum d'état parallèle. `MachineRentalState` existait,
fonctionnait, et était déjà branché partout (publication, réservation, workspace) — le dupliquer
aurait recréé exactement le risque d'états contradictoires que ce chantier doit éliminer.

---

## 3. Reason codes

12 codes stables dans `quarantine-reason-registry.ts`, chacun avec :
`code, title, description, severity (INFO/WARNING/CRITICAL), impact, triggerConditions,
evidenceRequired, recommendedAction, diagnosticRequired, repairPossible, autoExitPossible`.

`CRITICAL_GPU_IDENTITY_CHANGE`, `DIAGNOSTIC_COMPLETION_RACE`, `STALE_CLAIM`, `STALE_JOB`,
`WORKSPACE_CLEANUP_FAILED`, `AGENT_SECURITY_FAILURE`, `GPU_HEALTH_CHECK_FAILED`,
`ORPHANED_ALLOCATION`, `GPU_UNAVAILABLE`, `DOCKER_UNAVAILABLE`, `NVIDIA_RUNTIME_UNAVAILABLE`,
`UNKNOWN`.

Les 6 sites de quarantaine originaux + le 7e trouvé en cours de route (`server.ts`
`/agent/jobs/:id/state`) sont tous mappés à un code précis — **aucun ne retombe sur un message
générique**. `UNKNOWN` reste réservé au seul cas où aucune preuve exploitable n'existe (ex. :
quarantaine héritée d'avant ce système), et le dit explicitement plutôt que d'inventer une cause.

---

## 4. Diagnostic réel

`POST /rental/machines/:id/diagnostics/rerun` crée un `DiagnosticRun` (jamais un simple UPDATE de
statut). L'agent le récupère via `GET /agent/diagnostics/next/:machineId` (fonctionne même
quarantiné, voir §9), exécute un **vrai conteneur de diagnostic** (`run_gpu_diagnostic()`, déjà
existant et déjà utilisé pour les diagnostics de réservation), puis rapporte le résultat réel via
`POST /agent/diagnostics/:id/result`.

### 9 checks réels, jamais inventés

| Check | Source | Obligatoire pour sortir de quarantaine |
|---|---|---|
| `agent` | Le fait même que la requête soit signée et vérifiée | ✓ |
| `gpu` | Conteneur de diagnostic réel | ✓ |
| `gpuUuid` | Conteneur de diagnostic réel | ✓ |
| `driver` | Conteneur de diagnostic, sinon dernier heartbeat | ✓ |
| `docker` | Dernier heartbeat (si frais, sinon UNKNOWN) | ✓ |
| `nvidiaRuntime` | Dernier heartbeat (si frais, sinon UNKNOWN) | ✓ |
| `allocation` | `detectAvailableRepair()` — vraie requête DB sur `AcceleratorAllocation`/`Booking` | ✓ |
| `cuda` | Dernier heartbeat | informationnel (compatibilité Workspace) |
| `ram` | Dernier heartbeat | informationnel (compatibilité Workspace) |

Chaque check a un statut `PASS | FAIL | WARNING | UNKNOWN | NOT_CHECKED`. **UNKNOWN et
NOT_CHECKED ne sont jamais promus en PASS** (`evaluateDiagnosticChecks`, testé). Un check
obligatoire absent du rapport est traité `NOT_CHECKED`, jamais silencieusement ignoré.

### Ce qui N'EST PAS vérifié par le diagnostic (limite honnête)

Le nettoyage réel de conteneurs/proxy/réseau/volume résiduels côté agent (au-delà de la
bookkeeping `allocation`) nécessiterait que l'agent inspecte l'état Docker local et le rapporte —
non implémenté. `run_gpu_diagnostic()` prouve que le GPU répond, pas qu'aucun conteneur GPUbnb
résiduel ne tourne. C'est documenté comme limite connue, pas caché.

---

## 5. Réparation automatique

Une seule action, `CLEAR_ORPHANED_ALLOCATIONS` (`machine-repair-service.ts`) : corrige les lignes
`AcceleratorAllocation` restées actives alors que leur réservation est déjà `COMPLETED`/
`CANCELLED`. Ne touche **jamais** `MiningResource.activeRentalId` (la vraie porte d'exclusivité
de réservation) ni aucun processus réel sur la machine — uniquement de la comptabilité interne.

**Séquence imposée** : réparation → **jamais** de retour direct à CLEAR. `applyRepair()` ne
touche jamais `Machine.moderationStatus`. Un nouveau diagnostic reste obligatoire après toute
réparation pour confirmer que la machine est réellement saine.

**Ce qui n'est pas implémenté** : redémarrage agent, libération forcée de processus GPU distant,
nettoyage réseau/volume réel. Nécessiteraient un canal de commande authentifié vers l'agent
("Machine Command Gateway", existant dans le code mais désactivé à 0% de rollout par un choix
produit antérieur à ce chantier) — activer ce canal en sécurité est un chantier à part entière,
volontairement hors périmètre ici plutôt que bâclé.

---

## 6. Revalidation et sortie de quarantaine

Séquence réellement implémentée et testée (`quarantine-diagnostics-system.test.ts`, test
end-to-end) :

```
QUARANTINED
  → POST .../diagnostics/rerun          (DiagnosticRun créé, status=RUNNING)
  → GET /agent/diagnostics/next          (agent récupère, MÊME quarantiné)
  → conteneur de diagnostic réel exécuté sur l'agent
  → POST /agent/diagnostics/:id/result   (résultat réel)
  → completeDiagnosticRun() évalue les 7 checks obligatoires
     ├─ tous PASS  → clearQuarantine() → Machine.moderationStatus=CLEAR
     │                                    + Accelerator.moderationStatus/.status alignés
     │                                    (même transaction, voir §correction ci-dessous)
     └─ au moins un FAIL/UNKNOWN → enterQuarantine() → quarantaine maintenue,
                                     reasonCode = celui du premier check en échec
```

**Jamais** : bouton → `UPDATE moderationStatus='CLEAR'` sans preuve. `clearQuarantine()` est la
seule fonction du code base autorisée à écrire `CLEAR`, et son seul appelant conditionnel est
`completeDiagnosticRun()` après un vrai `evaluateDiagnosticChecks()` réussi (plus le force-clear
admin, §7, qui l'appelle explicitement en mode "forcé" et le journalise comme tel).

### Correction Machine ↔ Accelerator (trouvée et corrigée pendant ce chantier)

`Accelerator.moderationStatus` et `Accelerator.status` ne sont, dans toute la base de code, que
des miroirs du `Machine.moderationStatus` au dernier heartbeat (`mining-resource-inventory.ts`).
Aucune ligne de code ne quarantine un accélérateur indépendamment de sa machine. Avant correction,
`clearQuarantine()` ne mettait à jour QUE `Machine` — laissant `Accelerator` marqué `QUARANTINED`
jusqu'au heartbeat suivant, un état contradictoire (Machine=CLEAR, Accelerator=QUARANTINED) qui
bloquait silencieusement la republication. **Corrigé dans les deux sens** : `enterQuarantine()`
ET `clearQuarantine()` mettent maintenant à jour `Machine` et tous ses `Accelerator` dans la même
transaction. Prouvé par test réel (`end-to-end` test, assertion sur `acceleratorRow.moderationStatus`
après un clear).

### Cas 3 : re-dégradation automatique (testé)

Une machine redevenue `READY_TO_PUBLISH` puis re-diagnostiquée avec un check `gpu:FAIL` repasse
automatiquement en quarantaine (`REENTERED` si déjà quarantinée au moment du nouveau diagnostic,
`ENTERED` si elle était `CLEAR` — `enterQuarantine()` évalue toujours l'état courant, jamais une
supposition). La publication redevient immédiatement impossible. Testé de bout en bout : PASS →
CLEAR → publication réussie → FAIL → re-quarantaine → publication refusée à nouveau.

---

## 7. Force-clear administrateur

`POST /internal/machines/:id/quarantine/force-clear` — jamais exposé au propriétaire (aucune
route `/rental/*` ne l'appelle, aucun bouton dans `machine-diagnostics.html`).

- Authentification : `Bearer <INTERNAL_SERVICE_TOKEN>` (même mécanisme que les autres routes
  `/internal/*` existantes — pas de nouveau système de rôle admin inventé, il n'en existait aucun
  dans le schéma).
- `operatorId` et `reason` (≥10 caractères) obligatoires.
- **Restriction par sévérité** : si le `reasonCode` courant de la machine est `CRITICAL`
  (tous les codes le sont, sauf `UNKNOWN`), la requête doit inclure
  `confirmRisk: "<LE_CODE_EXACT>"` — pas juste un booléen, le code precis, pour forcer l'opérateur
  à confirmer explicitement QUELLE cause il choisit d'ignorer. Sans cela : `409
  risk_confirmation_required`.
- Historique : `MachineQuarantineEvent` de statut `CLEARED` avec `details.forced=true` et
  `details.forcedByAdminId` — **jamais indiscernable** d'une sortie normale par diagnostic.
- Journalisé : `request.log.warn(..., 'FORCED_QUARANTINE_CLEAR')`.
- Ne supprime jamais l'événement de quarantaine original — l'historique reste complet.

---

## 8. Publication d'annonce

`createExactGpuListing()` (préexistant, `rental-listing-service.ts`) est le seul chemin de
publication et utilise `computeMachineState()` — **la même fonction** que `GET
.../diagnostics` (Host) et que `allocateBookingResources()` (réservation). Prouvé par test réel :
la même quarantaine bloque simultanément publication ET réservation, et les deux redeviennent
possibles après le même `clearQuarantine()`.

Refus type : `machine_not_publishable` avec `details.blockingReason` = le reasonCode réel (ex.
`GPU_HEALTH_CHECK_FAILED`), affiché côté web (`publish.js`) via la table `BLOCKING_REASON` (mise
à jour pour couvrir les codes machine, pas seulement les codes accélérateur).

---

## 9. Sécurité

- **Authentification agent** : `authenticateQuarantinableAgent()` vérifie la signature Ed25519 v2
  (nonce anti-rejeu, hash du corps, timestamp ±30s) sans jamais exiger `moderationStatus=CLEAR` —
  volontairement séparée des helpers `authenticateAgent` utilisés par `workspace-gateway.ts` /
  `rental-resource-routes.ts` (qui EUX exigent CLEAR, à raison, pour leurs propres routes).
  Prouvé par test HTTP réel : la clé de la machine B ne peut jamais authentifier une requête pour
  la machine A (`machine-diagnostics-routes.integration.test.ts`).
- **Autorisation propriétaire** : `requireOwnedMachine()` sur toutes les routes `/rental/*` —
  prouvé par test HTTP réel qu'un propriétaire B reçoit 404 (jamais 403, pour ne pas révéler
  l'existence de la machine) sur une machine appartenant à A.
- **Validation** : tous les `machineId`/`diagnosticRunId` sont validés `z.string().cuid()` avant
  toute requête DB.
- **Replay protection** : héritée de `verifyAgentRequestV2` (nonce + Redis SET NX), inchangée.
- **Rate limiting** : toutes les nouvelles routes ont une config `rateLimit` explicite
  (5-30 req/min selon la sensibilité).
- **CSRF** : couvert globalement par le hook `assertTrustedOrigin` déjà enregistré dans
  `server.ts` avant toute route — aucune configuration par route nécessaire.
- **Le navigateur ne peut jamais déclarer un état matériel** : chaque `DiagnosticCheck` a un champ
  `source` (`agent-heartbeat | agent-diagnostic | server`) — jamais `browser`. Le corps HTTP que
  l'agent envoie (`gpuDetected`, `gpuUuid`, etc.) est lui-même authentifié par signature.
- **Idempotence / anti-double-traitement** : `completeDiagnosticRun()` fait une mise à jour
  conditionnelle atomique (`updateMany` gardé sur `status='RUNNING'`) — une seconde soumission
  pour le même `DiagnosticRun` (retry agent, requête rejouée) lève `DiagnosticRunConflictError`
  (→ 409), **jamais** ré-appliquée. Prouvé par test réel.
- **Anti-double-création** : `createDiagnosticRun()` prend un verrou consultatif Postgres
  (`pg_advisory_xact_lock`) par machine, empêchant deux `DiagnosticRun` `RUNNING` simultanés pour
  la même machine.

**Limite connue (opérationnelle, pas une faille)** : sous forte contention réelle, deux
transactions Prisma interactives concurrentes sur le même processus peuvent épuiser le pool de
transactions interactives par défaut et échouer avec une erreur générique de timeout plutôt
qu'un 409 propre — observé pendant le développement d'un test de course. N'affecte jamais
l'intégrité des données (Prisma garantit l'atomicité même sur un tel échec), seulement le code
d'erreur HTTP exact dans ce cas de bord rare (deux soumissions réellement simultanées, ce qui
n'arrive pas en pratique avec un seul agent séquentiel).

---

## 10. Observabilité

Chaque `MachineQuarantineEvent` porte : `machineId`, `status`, `reasonCode`, `reason`, `source`,
`createdAt`, `resolvedAt`, `diagnosticRunId` (corrélation directe avec `DiagnosticRun.id`), et
`details` (JSON — contient `bookingId`/`sessionId`/`workspaceId` quand pertinent selon le site
d'origine, ex. `DIAGNOSTIC_COMPLETION_RACE` inclut `bookingId`, `WORKSPACE_CLEANUP_FAILED` inclut
`sessionId`). Chaque `DiagnosticRun` porte son propre `id`, corrélable depuis l'historique.

Logs structurés : `request.log.warn` sur chaque réparation appliquée et chaque force-clear, avec
`machineId` + les identifiants pertinents.

**Redis n'est jamais la seule preuve.** Le seul mécanisme qui utilisait Redis comme preuve
(compteur d'échecs de signature, `security.ts:recordSecurityFailure`, TTL 900s) écrit désormais,
au moment où il déclenche, un `MachineQuarantineEvent` durable en Postgres — la preuve du
déclenchement survit même si le compteur Redis expire ensuite. Documenté explicitement dans le
registre (`AGENT_SECURITY_FAILURE.evidenceRequired`) : c'est précisément *pourquoi* cet événement
d'historique existe.

---

## 11. Procédures

### Pour un propriétaire (Host)

1. Ouvrir **Mes machines** → si le badge est rouge (« Quarantaine »), cliquer sur **« Voir la
   quarantaine et diagnostiquer »**.
2. La page **État & diagnostics** affiche la vraie cause, depuis quand, l'impact, la preuve
   nécessaire et l'action recommandée.
3. Si un **« Réparer automatiquement »** apparaît, cliquer dessus (n'affecte que la comptabilité
   interne, jamais un processus réel).
4. Cliquer **« Relancer le diagnostic »**. La page se rafraîchit automatiquement pendant
   l'exécution (toutes les 4s) et affiche le résultat réel, coché par coché.
5. Si tous les critères obligatoires passent, la machine sort automatiquement de quarantaine —
   aucune action supplémentaire n'est nécessaire ni possible pour forcer cette sortie autrement.

### Pour un administrateur (force-clear, exceptionnel)

```
curl -X POST https://<api>/internal/machines/<machineId>/quarantine/force-clear \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"operatorId":"<vous>","reason":"<raison factuelle détaillée>","confirmRisk":"<REASON_CODE_EXACT_SI_CRITICAL>"}'
```

N'utiliser que si une réparation + revalidation réelle est impossible (ex. matériel changé
physiquement et vérifié sur place) — jamais pour "débloquer vite".

### Diagnostiquer une machine bloquée en quarantaine en production

1. `GET /rental/machines/:id/diagnostics` (en tant que propriétaire, ou lire directement en base
   `Machine.moderationStatus`, `quarantineReasonCode`, `quarantinedAt`) pour la cause courante.
2. `SELECT * FROM "MachineQuarantineEvent" WHERE "machineId"=... ORDER BY "createdAt"` pour
   l'historique complet — chaque entrée porte sa preuve dans `details`.
3. Si `reasonCode='UNKNOWN'` : la cause historique n'est pas déterminable (quarantaine antérieure
   à ce système, ou preuve Redis expirée) — ne jamais l'inventer. Lancer un nouveau diagnostic ;
   c'est la nouvelle preuve qui compte, pas une supposition sur l'ancienne.
4. Si l'agent ne répond jamais à `GET /agent/diagnostics/next` : vérifier qu'il tourne
   (`gpubnb-agent status` sur la machine), que sa clé n'est pas révoquée
   (`Machine.keyRevokedAt`), et qu'il atteint l'API (heartbeats récents dans `Heartbeat`).

---

## 12. État de production (avant déploiement — historique)

Section conservée telle qu'écrite avant l'autorisation de déploiement, pour l'historique :
rien n'était poussé, la machine réelle n'avait pas pu être revalidée. **Voir §13 pour l'état
réel actuel — ce chantier est maintenant déployé et la machine a été revalidée avec succès.**

- Migrations locales appliquées et vérifiées sur Postgres local (dev) avant déploiement :
  `20260901005635_add_quarantine_diagnostics_lifecycle`,
  `20260901013945_add_orphaned_allocation_reason_code`. Écrites à la main pour rester strictement
  additives et ne jamais toucher le drift préexistant, non lié, de cette base de dev.
- Réparation automatique : un seul type sûr et implémenté (allocations orphelines). Le reste
  (redémarrage agent, libération de processus) reste non implémenté par choix, documenté en §5.
- Nettoyage runtime réel (conteneurs/réseau/volume résiduels) : non vérifié par le diagnostic,
  documenté en §4 comme limite honnête.

## 13. Déploiement réel et revalidation réelle (2026-09-01)

### Déploiement

- Poussé sur `origin/main` en deux temps : `961639f` (système complet) puis, après avoir trouvé
  et corrigé deux bugs réels en testant en direct (voir ci-dessous), `04fad5f` et `5555ed3`.
  Fast-forward propre à chaque fois, aucun `--force`, historique intact.
- Backend (Render) et frontend (Netlify) confirmés déployés **empiriquement**, pas supposés :
  `GET /agent/diagnostics/next/:machineId` et `POST /internal/machines/:id/quarantine/force-clear`
  répondent avec les codes d'erreur exacts du nouveau code (401 avec les bons messages) au lieu
  d'un 404 ; `GET /ready` confirme Postgres + Redis production sains ; le pied de page de
  `machine-diagnostics.html` affiche le commit déployé en direct.
- Le check GitHub Actions `CI` échoue sur `main` depuis le 2026-08-30 (avant ce chantier), à
  cause de 3 tests Python testant explicitement un comportement Windows-only, jamais gardés par
  un skip de plateforme, qui échouent sur le runner Ubuntu de la CI - confirmé non lié à ce
  chantier (fichiers jamais touchés) et non bloquant pour le déploiement réel (Render s'est
  appuyé sur `deployment-readiness`, qui passe). Non corrigé : hors périmètre de ce chantier,
  signalé ici pour que ce ne soit pas une surprise plus tard.

### Deux bugs réels trouvés et corrigés en testant en direct contre la production

1. **Un `DiagnosticRun` périmé bloquait tous les suivants pour toujours.** `TIMED_OUT` n'était
   qu'un calcul à la lecture (`effectiveDiagnosticStatus`), jamais écrit en base. Combiné à un tri
   `orderBy: startedAt asc` côté agent, le tout premier diagnostic resté bloqué (agent hors
   ligne, timeout) masquait pour toujours tout diagnostic plus récent et réellement en cours -
   l'agent recevait `diagnosticRunId: null` alors qu'un diagnostic frais existait bel et bien.
   Reproduit en direct : un vrai diagnostic lancé sur la vraie machine, laissé expirer pendant
   l'investigation, puis un second lancé - l'agent restait bloqué sur `null`. Corrigé (`04fad5f`) :
   `GET /agent/diagnostics/next` et `createDiagnosticRun()` nettoient maintenant systématiquement
   toute ligne `RUNNING` périmée (`TIMED_OUT` écrit en base) avant de sélectionner la plus récente.
2. **`DEV_DIAGNOSTIC_IMAGE` n'est pas configuré sur Render.** Le serveur renvoyait
   `diagnosticImage: null` à l'agent. Contrairement à l'ancien chemin `run_next_job` (jobs
   `GPU_DIAGNOSTIC` liés à une réservation), le nouveau `poll_and_run_diagnostic_once` n'avait
   aucun repli sur l'image épinglée localement dans `C:\ProgramData\GPUbnb\config.json`. Corrigé
   (`5555ed3`) : même ordre de priorité que `run_next_job` (image du serveur, sinon image locale).

### Revalidation réelle de la machine (`cmsiggruy0004df0tn669f6bn`)

**État avant** : 🔴 QUARANTAINE, `reasonCode=UNKNOWN` (« Cause historique non déterminable » —
confirmé exact : aucune ligne d'historique n'existait avant ce chantier, la machine était déjà
en quarantaine avant l'introduction du suivi détaillé). Dernier heartbeat frais (le correctif du
endpoint `/agent/challenge` a immédiatement redonné vie au heartbeat réel de cette machine, en
production, dès le déploiement).

**Diagnostic réel exécuté** (`diagnosticRunId: cmtill28m001hg11bw97nk25y`, déclenché par le
propriétaire, exécuté par le vrai agent `gpubnb-agent.exe` tournant sur la vraie machine, via une
requête signée Ed25519 authentique) - durée réelle 95 secondes (pull + exécution du conteneur de
diagnostic officiel) :

| Check | Statut | Valeur réelle |
|---|---|---|
| agent | 🟢 PASS | authentifié |
| gpu | 🟢 PASS | Diagnostic GPU officiel terminé |
| gpuUuid | 🟢 PASS | `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a` |
| driver | 🟢 PASS | 592.82 |
| docker | 🟢 PASS | disponible |
| nvidiaRuntime | 🟢 PASS | disponible |
| cuda | 🟢 PASS | 13.1 |
| ram | 🟢 PASS | 12064 MiB |
| allocation | 🟢 PASS | aucune allocation orpheline |

Aucune réparation n'a été nécessaire — le diagnostic est passé du premier coup sur tous les
critères obligatoires.

**Résultat** : `clearQuarantine()` déclenché par une preuve réelle (`completeDiagnosticRun`, tous
les checks obligatoires PASS) - jamais par un clic forçant l'état. `Machine.moderationStatus`
**et** `Accelerator.moderationStatus`/`.status` synchronisés dans la même transaction (le vrai
`Accelerator` de cette machine confirmé `CLEAR`, `verifiedAt` frais). État final :
`state=LISTING_ACTIVE`, `canPublish=true`, `canAcceptBooking=true`.

**Publication confirmée réelle** : l'annonce existante de cette machine ("GTX 1650 - Test beta
deux machines") est repassée `status=ACTIVE`, `publiclyVisible=true`, `gpuHealthy=true`, et est
effectivement visible sur `GET /rental/listings` **sans authentification** (vérifié en appelant
l'endpoint public directement, sans cookie de session).

**Historique complet et immuable**, tel qu'affiché sur Host, sans qu'aucune ligne n'ait été
effacée (4 tentatives de diagnostic pendant l'investigation, toutes conservées) :
```
2026-09-01T11:14:18Z  DIAGNOSTIC  Diagnostic lancé (par le propriétaire).
2026-09-01T11:17:56Z  DIAGNOSTIC  Diagnostic lancé (par le propriétaire).
2026-09-01T11:31:19Z  DIAGNOSTIC  Diagnostic lancé (par le propriétaire).
2026-09-01T11:42:23Z  DIAGNOSTIC  Diagnostic lancé (par le propriétaire).
2026-09-01T11:43:58Z  CLEARED     Diagnostic réussi : tous les critères obligatoires
                                   (agent, GPU, pilote, Docker, runtime NVIDIA) sont satisfaits.
```

### Point honnête non résolu — RÉSOLU le 2026-09-01 (voir §14)

~~Le fil d'arrière-plan `poll_and_run_diagnostic` (censé tourner automatiquement après chaque
heartbeat, exactement comme `poll_and_run_job`) n'a, en pratique, jamais émis le moindre
événement dans les logs du vrai service Windows pendant cette session, malgré plusieurs
redémarrages du service.~~ Cause réelle trouvée et corrigée : voir §14 ci-dessous. Ce n'était pas
un bug de logique dans le thread lui-même, mais un exécutable Windows figé (build PyInstaller du
2026-08-30) qui ne contenait tout simplement pas encore ce code.

## 14. Correction de l'automatisation du diagnostic sur le vrai agent Windows (2026-09-01)

**Cause racine prouvée** : le vrai service Windows `GPUbnbAgent` n'exécute pas le code source de
ce dépôt. Il exécute un exécutable PyInstaller figé,
`C:\Program Files\GPUbnb Host\gpubnb-agent.exe`, construit le 2026-08-30T04:44:36 - **avant**
l'existence de `poll_and_run_diagnostic_once` (ajouté le 2026-09-01). Chaque appel manuel réussi
pendant l'investigation utilisait en réalité une installation pip éditable séparée sur la même
machine (`pip show gpubnb-agent` → `Editable project location: .../gpubnb/agent`), qui pointe
directement vers le code source et reflète donc toujours la dernière version - un chemin
d'exécution complètement différent de celui du vrai service. Redémarrer le service ne faisait que
relancer le même exécutable figé ; il ne relisait jamais le dépôt.

**Preuve** : `Get-CimInstance Win32_Process` a montré la ligne de commande réelle du service comme
`"C:\Program Files\GPUbnb Host\gpubnb-agent.exe" _service`, distincte de
`...\Python313\Scripts\gpubnb-agent.exe` (l'installation éditable utilisée par tous les tests
manuels). L'horodatage du fichier de l'exécutable figé précède entièrement le code de la boucle de
diagnostic de cette session. Aucun bug de logique n'existait dans la boucle elle-même - tous les
tests unitaires/intégration de `poll_and_run_diagnostic_once` passaient déjà avant cette
correction.

**Correction** : reconstruction de l'exécutable à partir du code source actuel avec la commande CI
exacte (`gpubnb-agent.spec` / `publish-host-test-release.yml`, `pyinstaller==6.16.0`), remplacement
du vrai binaire de production (l'ancien conservé en `.bak-20260830`, non supprimé), redémarrage du
vrai service Windows.

**Observabilité ajoutée** (`agent/gpubnb_agent/cli.py`) : `diagnostic_poll_loop_started`,
`diagnostic_poll_loop_running`, `diagnostic_poll_request`, `diagnostic_poll_response`,
`diagnostic_run_received`, `diagnostic_run_started`, `diagnostic_run_completed`,
`diagnostic_run_failed`, `diagnostic_poll_error` (avec traceback tronqué), `diagnostic_loop_stopped`
- chaque cycle émet désormais au moins 3 événements même quand rien n'est en attente ; avant cette
correction, un cycle "rien à faire" était totalement silencieux, indiscernable d'un thread mort.
Aucun secret, clé privée, token ou signature n'est jamais loggué.

**Vérifié en conditions réelles, sans aucun appel Python manuel** : `diagnostic_poll_loop_started`
émis exactement une fois par démarrage du service ; le cycle
`diagnostic_poll_loop_running → diagnostic_poll_request → diagnostic_poll_response` se répète
automatiquement toutes les ~10s indéfiniment ; un vrai "Relancer le diagnostic" déclenché depuis
Host (sur la machine réelle, saine, `LISTING_ACTIVE`, jamais mise en danger) a été détecté
automatiquement en moins d'un cycle et exécuté/complété en 6s avec un résultat réel 9/9 PASS ; un
redémarrage propre du service produit exactement un `diagnostic_loop_stopped` puis un
`diagnostic_poll_loop_started`, une seule paire de processus parent/enfant, aucun doublon (confirmé
: 2 occurrences totales de `diagnostic_poll_loop_started` dans le log, correspondant exactement aux
2 démarrages réels du service effectués).

**Tests** : 376/376 tests agent passent (369 préexistants + 7 nouveaux dans
`agent/tests/test_diagnostic_poll_loop.py`), stable sur plusieurs exécutions complètes répétées.

**Commit** : `446cd85`.

## 15. Chaîne officielle de build/release/installation/update de l'agent Windows (2026-09-01)

Le correctif du §14 a été appliqué et vérifié **directement sur le vrai binaire de production**,
en remplaçant `C:\Program Files\GPUbnb Host\gpubnb-agent.exe` à la main. Cette section documente
et corrige le vrai problème restant identifié ensuite : **le canal de distribution officiel
(le pipeline qui construit et publie l'agent que tout nouveau Host télécharge) était lui-même en
panne depuis deux jours**, ce qui aurait rendu ce même correctif indisponible pour tout autre Host.

**État final vérifié** : `host-test-latest` (l'alias que `host-download.mjs` sert réellement à la
page publique d'installation) pointe maintenant sur le commit `c100560` - HEAD de `main`,
contenant l'intégralité des correctifs de cette session (diagnostic automatique, pipeline de
release, stamping de commit, self-update, correctif de la race `STOP_PENDING`). Publié comme
`host-v0.2.0-beta.72`, re-vérifié indépendamment sur un runner Windows propre par
`post-publish-host-windows-verify.yml` (installation réelle, `build-info.buildCommit` confirmé
égal au commit publié, service réellement exercé) le 2026-09-01T13:35:32Z.

### 15.1 Architecture réelle (avant correction)

```
Push sur main (agent/**, apps/host-desktop/**, ...)
   │
   ▼
.github/workflows/publish-host-test-release.yml (matrice Windows/Linux/macOS)
   │  build Tauri + PyInstaller (gpubnb-agent.exe) + Rust (gpubnb-host-tunnel.exe)
   │  cargo fmt/clippy/test -D warnings  ← porte PARTAGÉE par les 3 plateformes
   │  installeur NSIS signé "non signé" + smoke test réel (verify-windows-release.ps1)
   ▼
Release GitHub immuable "host-v0.2.0-beta.<run>" (prerelease, --target <commit exact>)
   │
   ▼
.github/workflows/post-publish-host-windows-verify.yml (workflow_run, si succès)
   │  télécharge le candidat immuable sur un runner Windows INDÉPENDANT
   │  vérifie tous les SHA-256, installe réellement, exerce le service, désinstalle
   ▼
Alias "host-test-latest" (recréé à chaque promotion, pointe sur le commit vérifié)
   │
   ▼
apps/web/host-install.html → host-downloads.js → netlify/functions/host-download.mjs
   │  lit directement la release GitHub "host-test-latest" (repo khemisset18/gpubnb)
   ▼
Téléchargement par l'utilisateur → installeur NSIS → service Windows GPUbnbAgent
```

**Cause du problème historique** : le commit `be31781` (2026-08-31 13:02, fonctionnalité
« Détecter et libérer le GPU », sans rapport avec ce chantier) a introduit une violation
`cargo fmt` dans `apps/host-desktop/src-tauri/src/agent_bridge.rs:288`. Cette porte est partagée
par les trois jobs de build (Windows/Linux/macOS) de `publish-host-test-release.yml` : chaque
build a échoué depuis, y compris celui du correctif du diagnostic (`446cd85`) lui-même. Aucune
nouvelle release n'a donc été publiée depuis le 2026-08-30 04:43:11 (commit `eedee14a`) - **91
secondes avant** le binaire figé exact retrouvé sur la machine réelle au §14. Autrement dit : même
un nouveau Host installé aujourd'hui via le canal officiel aurait reçu le même agent cassé.
Corrigé en une ligne (reformattage seul, aucun changement de logique) dans `a5d5fb1`. Vérifié en
conditions réelles : ce seul push a immédiatement débloqué le pipeline, publié
`host-v0.2.0-beta.70` et promu `host-test-latest` sur `a5d5fb1` (qui contient déjà `446cd85`) en
moins de 10 minutes, sans aucune autre modification.

### 15.2 Version officielle et traçabilité du binaire

Avant cette correction, un agent installé ne savait dire que sa version sémantique
(`agent/pyproject.toml`, actuellement `0.6.2`, non liée au commit exact) - insuffisant pour
distinguer « le bon 0.6.2 » d'« un 0.6.2 figé depuis deux jours », qui est exactement le problème
qui s'est produit.

Ajouté : `agent/gpubnb_agent/_build_info.py` (`BUILD_COMMIT`), réécrit par CI juste avant la
construction PyInstaller avec les 12 premiers caractères du commit réel (`$GITHUB_SHA`), et
vérifié immédiatement après la construction (le build échoue si le commit stampé ne correspond
pas). Nouvelle commande :

```
gpubnb-agent.exe build-info
{"agentVersion": "0.6.2", "buildCommit": "a5d5fb1ff3f7", "frozen": true, "executable": "..."}
```

`agentVersion` et `buildCommit` apparaissent désormais aussi dans chaque événement
`diagnostic_poll_loop_started` du log réel - le champ qui aurait transformé l'investigation du
§14 (comparaison d'horodatages de fichiers, inspection de ligne de commande de processus) en une
simple lecture de log.

### 15.3 Vérification d'intégrité (déjà existante, conservée)

Chaque asset publié a son SHA-256 dans `SHA256SUMS.txt` (généré à la publication, vérifié
indépendamment lors de la promotion vers `host-test-latest`). `host-download.mjs` (fonction
Netlify servant la page de téléchargement publique) sert ce même SHA-256 à l'utilisateur pour
vérification manuelle. Renforcé cette session : `scripts/verify-windows-release.ps1` vérifie
maintenant en plus, sur chaque publication ET sur chaque promotion, que le `buildCommit` réel de
l'exécutable installé correspond exactement au commit publié - **rendant structurellement
impossible qu'une future release expédie silencieusement un binaire périmé** sans faire échouer
le pipeline. Le script vérifie aussi que le vrai service Windows installé atteint bien la première
ligne réelle de `heartbeat_loop()` (le message « Machine non liée », journalisé via
`logging.exception`) après un redémarrage - preuve, sans compte GPUbnb réel disponible sur le
runner CI, que le service exécute réellement le code de cette build et non un reliquat figé.

### 15.4 Mise à jour d'un Host déjà installé

Aucun mécanisme d'auto-update n'existait avant cette session (aucun plugin `tauri-plugin-updater`,
aucune vérification périodique, rien) : le seul moyen de mettre à jour un Host déjà installé était
de retélécharger et relancer l'installeur NSIS manuellement. C'est la cause directe pour laquelle
la machine réelle de l'utilisateur avait un `.exe` figé du 2026-08-30 alors que le dépôt était déjà
corrigé : rien ne l'aurait jamais informée qu'une correction existait.

Ajouté : `gpubnb-agent.exe self-update` (`agent/gpubnb_agent/self_update.py`). Flux réel :

```
gpubnb-agent.exe self-update
   │  GET releases/tags/host-test-latest (GitHub) → commit publié
   │  déjà à jour (buildCommit courant == commit publié) ? → ne rien faire
   │  télécharge gpubnb-host-windows-x64-portable.zip, vérifie son SHA-256 publié
   │  extrait gpubnb-agent.exe, vérifie l'en-tête PE (MZ) et la taille minimale
   │  arrête le service GPUbnbAgent (attend confirmation réelle, timeout 30s)
   │  renomme l'ancien binaire en gpubnb-agent.exe.bak-<epoch> (jamais supprimé)
   │  installe le nouveau binaire, redémarre le service
   │  échec au démarrage ? → restaure automatiquement l'ancien binaire et relance
   ▼
{"updated": true, "previousCommit": "...", "newCommit": "...", "backupPath": "...", ...}
```

`--dry-run` vérifie et rapporte sans rien modifier. La commande refuse de s'exécuter sur une
installation pip éditable (non figée) - elle reflète déjà toujours le code source, il n'y a rien à
comparer.

**Bug réel trouvé et corrigé en testant contre un vrai service Windows jetable** (jamais le vrai
`GPUbnbAgent` de production) : après `stop`, un vrai service reste en `STOP_PENDING` plusieurs
secondes réelles avant d'atteindre `STOPPED` - or `service_running()` (`SERVICE_RUNNING`
uniquement) est déjà faux pendant tout ce temps. La première version attendait seulement
`service_running()==false` avant de remplacer le binaire et relancer, ce qui court-circuitait le
vrai Service Control Manager : `StartService failed: 1056, une instance du service s'exécute
déjà`. Corrigé (commit `c100560`) en ajoutant une vérification distincte
`windows_service.service_fully_stopped()` (code d'état `SERVICE_STOPPED` précis, pas seulement
« pas RUNNING ») utilisée spécifiquement avant de toucher au binaire. Reproduit et re-vérifié
réellement (voir §15.7) - c'est exactement le genre de défaut qu'un test purement unitaire avec
mocks n'aurait jamais révélé.

**Choix assumé : déclenché par le propriétaire, jamais silencieux/automatique en arrière-plan.**
Les binaires publiés ne sont pas signés (voir `apps/web/host-install.html`, « Signature : non
signée » sur chaque plateforme) : remplacer sans supervision humaine le binaire d'un service
Windows de production n'est pas une décision que cette session prend seule. Le mécanisme
d'exécution (téléchargement, vérification, arrêt, remplacement atomique, redémarrage, rollback
automatique en cas d'échec) est entièrement automatisé et testé ; seul le déclenchement reste
manuel pour l'instant. Un bouton « Mettre à jour » dans l'application Host (Tauri) est une suite
naturelle mais hors périmètre de cette session (nouvelle surface UI/Rust distincte, pas une
correction du pipeline existant).

### 15.5 Comment vérifier qu'un Host exécute réellement la version officielle actuelle

1. `gpubnb-agent.exe build-info` sur la machine → note `buildCommit`.
2. Comparer avec le commit ciblé par la release GitHub `host-test-latest` du dépôt
   `khemisset18/gpubnb` (visible via `gh release view host-test-latest --json targetCommitish`,
   ou la page https://github.com/khemisset18/gpubnb/releases).
3. Si différent : `gpubnb-agent.exe self-update` (en administrateur) pour se mettre à jour, ou
   `gpubnb-agent.exe self-update --dry-run` pour vérifier sans agir.
4. Dans `C:\ProgramData\GPUbnb\agent.log`, chaque `diagnostic_poll_loop_started` porte désormais
   `buildCommit` - moyen le plus rapide de diagnostiquer un agent figé sans accès à la machine.

### 15.6 Tests unitaires

14 nouveaux tests (`agent/tests/test_self_update.py`) couvrant la vraie mécanique - vérification
de checksum (y compris un cas de ZIP altéré ne correspondant plus à son propre SHA-256 publié),
un arrêt de service qui ne se termine jamais (répertoire d'installation jamais touché), la race
`STOP_PENDING` du §15.4 reproduite explicitement, et un échec de démarrage après remplacement
(rollback automatique vers le dernier binaire connu-bon) - avec réseau, contrôle de service,
horloge et pause entièrement injectés. 376 → 390 tests agent au total, stables sur plusieurs
exécutions complètes.

### 15.7 Preuve réelle du scénario de mise à jour complet (ancien agent → self-update → nouveau agent)

Exécuté réellement, pas simulé, sur cette machine, sans jamais toucher le vrai service
`GPUbnbAgent` de production :

1. Créé un service Windows **jetable et distinct**, `GPUbnbAgentSelfUpdateTest`, pointant sur le
   vrai `gpubnb-agent.exe` extrait de la release réelle `host-v0.2.0-beta.70` (commit `a5d5fb1`,
   celle publiée juste après le correctif du pipeline, avant `self-update`/`build-info`).
2. Démarré ce service jetable réellement (`sc start` → `RUNNING` confirmé, hash SHA-256 du binaire
   noté : `ccbc5148...`).
3. Exécuté `perform_self_update` (le vrai code de `self_update.py`, appelé directement, contrôle
   de service branché sur de vrais appels `sc.exe stop/start/query` contre `GPUbnbAgentSelfUpdateTest`
   uniquement) contre la vraie release `host-test-latest` en vigueur à ce moment.
4. **Première tentative** : a échoué avec l'erreur Windows réelle 1056 - c'est la découverte du bug
   `STOP_PENDING` du §15.4. Le rollback automatique a fonctionné correctement : binaire restauré
   à son hash d'origine, aucun fichier orphelin (`.new`/`.bak`) laissé derrière, service jetable
   laissé dans un état `STOPPED` propre.
5. Corrigé (`c100560`), **seconde tentative** : succès complet. `updated=true`,
   `previousCommit="a5d5fb1ff3f7"`, `newCommit="fc5e777f256c90b94452b72ca1ac8a51a4213c63"`,
   `backupPath` créé. Vérifié après coup : `gpubnb-agent.exe build-info` sur le binaire remplacé
   rapporte bien `buildCommit: fc5e777f256c` ; le fichier `.bak` a exactement le hash SHA-256 du
   binaire d'origine (`ccbc5148...`, confirmé identique) ; le service jetable est `RUNNING`.
6. Nettoyage : service jetable arrêté et supprimé (`sc delete`), répertoire de test supprimé.
   Vérifié tout du long et à la fin : `GPUbnbAgent` (le vrai service de production) est resté
   `RUNNING` sans interruption, jamais arrêté, jamais touché.

C'est la preuve complète du flux `ancien agent → self-update → nouveau agent → service → build
correct confirmé` demandé, obtenue avec de vraies releases GitHub et un vrai cycle de vie de
service Windows, sans aucun risque pour la machine réelle en production.
