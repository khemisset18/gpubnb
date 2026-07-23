# 📋 AUDIT TECHNIQUE COMPLET — GPUbnb v1.0

**Date :** 2026-07-23  
**Status :** Devnet | Pré-MVP  
**Objectif :** Finaliser le parcours complet de location GPU (publication → réservation → session → nettoyage)

---

## 1️⃣ ARCHITECTURE GLOBALE ✅

### Infrastructure
```
Frontend (Netlify)
├─ apps/web/ (HTML + JS vanilla)
├─ pages: index.html, dashboard.html, publish.html, demandes.html, propositions.html
├─ localStorage pour démo uniquement

Backend (Render Docker)
├─ apps/api/ (Fastify + Prisma + Redis)
├─ Port: 10000 (production) / 8787 (local)
├─ Authentification: Phantom Wallet + Nonce + Session Redis

Base de données
├─ PostgreSQL 16 (Supabase en production, local en dev)
├─ Prisma ORM v6.10

GPU Agent (Python)
├─ agent/ (CLI Python + pynacl + base58)
├─ Installation développeur: pip install -e agent
├─ Commandes: setup, link, diagnose, start, benchmark, show-key, reset-key

Blockchain (Solana Devnet)
├─ programs/gpu_escrow/ (Anchor 0.31 - Rust)
├─ Program ID: NOT_DEPLOYED_YET (urgent pour MVP)
├─ Escrow: PDA unique par réservation
├─ Settle: 95% fournisseur + 5% plateforme

Infrastructure locale
├─ infra/docker-compose.yml (Postgres + Redis)
├─ render.yaml (déploiement Render)
└─ Dockerfile multi-stage (Node 22)
```

---

## 2️⃣ ÉTAT DES COMPOSANTS

### 🟢 FONCTIONNEL - Bases de données & ORM
- ✅ Prisma Schema v6.10 complet et bien structuré
- ✅ Migrations versionnées
- ✅ Enums clairs : MachineConnectivity, ModerationStatus, ListingStatus, BookingStatus, PaymentStatus, JobStatus, WorkspaceSessionStatus
- ✅ Relations entre tables bien définies
- ✅ Indexes optimisés pour les requêtes courantes

**Modèles clés :**
```
User (email, pseudonym, profil)
├─ Machine (GPU owner's machine)
│  ├─ GpuListing (marketplace listing)
│  ├─ Heartbeat (agent keepalive)
│  └─ MachineWorkspace (workspace compatibility)
├─ Booking (renter's reservation)
│  ├─ Payment (escrow tracking)
│  ├─ Job (GPU task)
│  └─ WorkspaceSession (compute session)
└─ ForumTopic, Review, Conversation
```

### 🟢 FONCTIONNEL - API Fastify & Authentification
- ✅ Authentification Phantom Wallet (nonce + signature)
- ✅ Sessions Redis avec TTL (86400s par défaut)
- ✅ Rate limiting activé
- ✅ CORS / Helmet / Cookie security
- ✅ Error handler centralisé
- ✅ Endpoints d'accueil: /health, /ready

**Routes d'authentification :**
```typescript
POST /auth/nonce        → Demande nonce Phantom
POST /auth/verify       → Vérifie signature + crée session
POST /auth/logout       → Révoque session
POST /auth/supabase     → Authentification Supabase (OAuth)
GET  /auth/me           → Récupère profil utilisateur
```

### 🟡 PARTIEL - Machine & Agent
- ✅ Routes pour lier une machine : POST /machines/link-code, POST /agent/link
- ✅ Schéma pour l'inventaire GPU reçu de l'agent
- ✅ Heartbeat endpoint : POST /agent/heartbeat (rate-limited 30/min)
- ✅ Détection machine hors ligne après HEARTBEAT_OFFLINE_SECONDS (40s)
- ⚠️ **BLOQUANT** : L'Agent Python est en phase 0.5 — manque la sécurisation des requêtes
- ⚠️ **BLOQUANT** : Pas de vérification de signature des heartbeats (actuellement accepte tout)
- ⚠️ Communication non sécurisée : aucune signature Ed25519 sur les requêtes Agent

**Problèmes détectés :**
```javascript
// apps/api/src/server.ts : ligne 68
app.post('/agent/heartbeat', {...}, async (req,reply) => {
  const b = heartbeatSchema.parse(req.body);  // ✅ Validation
  // ❌ MANQUE : Vérification de signature Ed25519
  // ❌ MANQUE : Replay attack protection (timestamp + nonce)
  // ❌ MANQUE : Machine ID verification
```

### 🟡 PARTIEL - Marketplace & Listings
- ✅ GET /listings → Récupère listings ACTIVE avec machine ONLINE
- ✅ Filtering: status + connectivity + moderationStatus
- ⚠️ Pas de filtres frontend pour GPU, VRAM, prix, localisation
- ⚠️ Les données de démo dans localStorage pollluent le marché
- ⚠️ Affichage de "fausses" annonces v1.1 (localStorage)

### 🟡 PARTIEL - Réservation & Booking
- ✅ POST /bookings → Crée réservation (idempotency key)
- ✅ Statuts: CREATED, AWAITING_DEPOSIT, FUNDED, STARTING, ACTIVE, COMPLETED, DISPUTED, SETTLED, REFUNDED, CANCELLED
- ⚠️ Transitions de statuts sans validation centralisée
- ⚠️ POST /bookings/:id/payment-intent → Retourne 503 si ESCROW_PROGRAM_ID === 'NOT_DEPLOYED_YET'
- ⚠️ POST /bookings/:id/confirm-deposit → Bloquée jusqu'au déploiement contrat

**État du circuit de paiement :**
```
CREATED (initial)
  ↓
AWAITING_DEPOSIT (frontend sign transaction)
  ↓
FUNDED (signature verified, escrow PDA created)
  ↓
STARTING (backend sends command to agent)
  ↓
ACTIVE (session running)
  ↓
COMPLETED or DISPUTED or REFUNDED
  ↓
SETTLED (escrow closed, fonds libérés)
```

### 🟡 PARTIEL - Sessions GPU & Workspace
- ✅ Modèle WorkspaceSession complet (RESERVED → PREPARING → READY → RUNNING → COMPLETED)
- ✅ Modèle WorkspaceMetric pour suivi utilisation
- ✅ Modèle WorkspaceSessionEvent pour audit
- ⚠️ **CRITIQUE** : Aucun code d'exécution réelle de conteneur
- ⚠️ Routes API défines mais pas implémentées :
  - `POST /bookings/:bookingId/workspace-sessions` (prépare session)
  - `POST /workspace-sessions/:id/start` (démarre session)
  - `POST /workspace-sessions/:id/stop` (arrête session)
  - `GET /workspace-sessions/:id` (récupère état)
  - `POST /agent/workspace-sessions/:id/metrics` (reçoit métriques)

**Problème majeur :**
```typescript
// apps/api/src/server.ts : ligne 88-92
async function ensureComputePreparation(bookingId: string, renterId: string) {
  // ... database setup
  const limits = {
    maxRamMiB: 512,
    maxCpuCores: 1,
    storageQuotaMiB: 1024,
    networkAccess: 'NONE',  // ✅ Isolation réseau
    autoStopMinutes: 10
  };
  // ❌ MANQUE : Aucun appel Docker/Agent pour créer le conteneur
  // ❌ MANQUE : Aucune exécution du Workspace
  // ❌ MANQUE : Aucun tunnel d'accès (VS Code / JupyterLab)
}
```

### 🟡 PARTIEL - Workspace Manifests
- ✅ Définitions complètes de 13 workspaces (Compute, AI, Developer, Cloud Desktop, etc.)
- ✅ Système de manifestes immutable et type-safe
- ✅ Vérification de compatibilité : analyzeWorkspace()
- ⚠️ **UNIQUEMENT COMPUTE en BETA** — tous les autres sont UPCOMING/EXPERIMENTAL
- ⚠️ Compute Workspace : structure définie, zéro implémentation
- ⚠️ Aucune image Docker prête
- ⚠️ Aucun script d'installation de runtime

### 🔴 NON FONCTIONNEL - Agent Communication
L'Agent Python **n'existe pas en version fonctionnelle**.

**Fichiers trouvés :**
- ✅ `agent/requirements.txt` (pynacl, base58)
- ✅ `docs/AGENT.md` (documentation)
- ✅ Commandes attendues : setup, link, diagnose, start, benchmark
- ❌ Zéro implémentation Python
- ❌ Pas de signature de requêtes
- ❌ Pas de stockage clé privée local
- ❌ Pas de heartbeat signé
- ❌ Pas de détection GPU via nvidia-smi
- ❌ Pas de communication sécurisée

### 🔴 NON FONCTIONNEL - Escrow Program
**Status: NOT_DEPLOYED_YET**

**Fichiers trouvés :**
- ✅ `programs/gpu_escrow/src/lib.rs` (contrat Anchor complet)
- ✅ Logique escrow implémentée :
  - `initialize_config()` : Setup admin + oracle + platform wallet
  - `open()` : Crée PDA escrow, transfère lamports buyer → escrow
  - `propose_settlement()` : Oracle propose montant payable basé sur uptime
  - `dispute()` : Buyer peut contester dans fenêtre 3600s
  - `finalize()` : Settle = 95% provider + 5% platform + refund
  - Tests unitaires complets ✅
- ❌ Jamais compilé ni déployé
- ❌ Program ID inchangé (placeholder Anchor défaut)
- ❌ Pas d'appel depuis le backend

### 🔴 NON FONCTIONNEL - Frontend Pages (Démo)
**Fichiers statiques trouvés :**
- ✅ `apps/web/index.html` (page d'accueil magnifique)
- ✅ `apps/web/dashboard.html` (tableau de bord squelette)
- ✅ `apps/web/publish.html` (formulaire publication GPU)
- ✅ `apps/web/demandes.html` & `propositions.html` (v1.2, localStorage only)
- ⚠️ Dashboard : maquette uniquement (liens cassés, données en dur)
- ⚠️ Publish form : envoie vers API mais API bloquée sans Agent
- ⚠️ Demandes/Propositions : localStorage uniquement, zéro backend

### 🔴 NON FONCTIONNEL - Docker & Workspace Runtime
- ❌ Aucun Dockerfile de workspace
- ❌ Aucun script de préparation de conteneur
- ❌ Aucune gestion du cycle de vie (start/stop/cleanup)
- ❌ Aucune isolation réseau ou CPU/RAM/GPU
- ❌ Aucun tunnel d'accès (JupyterLab, VS Code Web)
- ❌ Aucun système d'import/export de fichiers

### 🟠 SÉCURITÉ - Lacunes détectées

| Problème | Sévérité | Bloc MVP? |
|----------|----------|----------|
| Agent: Zéro signature sur requêtes | CRITIQUE | ✅ OUI |
| Agent: Pas de nonce/timestamp | CRITIQUE | ✅ OUI |
| Heartbeat: Aucune vérification | CRITIQUE | ✅ OUI |
| Escrow: Pas déployé | CRITIQUE | ✅ OUI |
| Session: Aucune isolation Docker | CRITIQUE | ✅ OUI |
| Frontend: localStorage pollue BD | HAUTE | ✅ OUI |
| Machine offline detection: 40s lag | MOYENNE | ⚠️ PEUT ATTENDRE |
| Rate limiting sur /agent/heartbeat: 30/min | MOYENNE | ⚠️ PEUT ATTENDRE |

---

## 3️⃣ PARCOURS DE LOCATION — ÉTAT ACTUEL

```
Propriétaire (HOST)
├─ ❌ BLOQUÉ : Installer Agent → python install
├─ ❌ BLOQUÉ : gpubnb-agent setup (clé privée non générée)
├─ ❌ BLOQUÉ : gpubnb-agent link CODE (pas de signature)
├─ ❌ BLOQUÉ : GPU detection (nvidia-smi pas appelée)
├─ ✅ PEUT : Voir machine dans dashboard
├─ ❌ BLOQUÉ : Publier annonce (route existe, Agent non sécurisé)
└─ ❌ BLOQUÉ : Voir état machine

Locataire (RENTER)
├─ ✅ PEUT : Se connecter avec Phantom
├─ ✅ PEUT : Voir listings sur marketplace
├─ ✅ PEUT : Réserver une machine
├─ ❌ BLOQUÉ : Signer dépôt escrow (contrat pas déployé)
├─ ❌ BLOQUÉ : Accès au Workspace (session non implémentée)
├─ ❌ BLOQUÉ : Utiliser GPU (pas de conteneur)
├─ ❌ BLOQUÉ : Importer/exporter fichiers (API pas prête)
└─ ❌ BLOQUÉ : Terminer session (nettoyage pas implémenté)
```

---

## 4️⃣ FICHIERS À MODIFIER — LISTE COMPLÈTE

### Backend API (Priority 1)
```
apps/api/src/
├─ server.ts          ⚠️ CRITIQUE - Ajouter verification signatures + workspace runtime
├─ auth.ts            ✅ OK - Session Phantom fonctionnelle
├─ config.ts          ✅ OK - Configuration valide
├─ workspace-manifests.ts  ✅ OK - Compute manifest OK
├─ workspace-compatibility.ts  ✅ OK - Scoring OK
├─ workspace-usage.ts ✅ OK - Tracking OK
├─ job-state.ts       ✅ OK - State machine OK
└─ MANQUE : security.ts (signature Agent)
└─ MANQUE : docker.ts (gestion conteneurs)
└─ MANQUE : workspace-runtime.ts (exécution)
```

### Database Prisma (Priority 2)
```
apps/api/prisma/
├─ schema.prisma      ✅ OK - Tous les modèles présents
└─ migrations/        ✅ OK - À vérifier après changements
```

### GPU Agent Python (Priority 1)
```
agent/
├─ requirements.txt   ✅ Dépendances OK
├─ __init__.py        ❌ MANQUE : Package structure
├─ MANQUE : cli.py (CLI main)
├─ MANQUE : setup.py (entry point)
├─ MANQUE : crypto.py (Ed25519 signatures)
├─ MANQUE : machine.py (GPU detection)
├─ MANQUE : heartbeat.py (keepalive signé)
├─ MANQUE : docker.py (conteneur mgmt)
└─ MANQUE : workspace.py (exécution Workspace)
```

### Blockchain Anchor (Priority 1)
```
programs/gpu_escrow/
├─ src/lib.rs        ✅ Contrat OK, jamais compilé
├─ Cargo.toml        ✅ OK
└─ build.sh          ❌ MANQUE : Script de compilation
└─ deploy.sh         ❌ MANQUE : Script de déploiement
```

### Frontend (Priority 3)
```
apps/web/
├─ index.html        ✅ Maquette OK
├─ dashboard.html    ⚠️ PARTIEL - Squelette présent, pas de logique
├─ publish.html      ⚠️ PARTIEL - Formulaire OK, backend bloqué
├─ app.js            ⚠️ PARTIEL - Marketplace OK, booking incomplet
├─ publish.js        ❌ MANQUE : Implémentation complète
├─ dashboard.js      ❌ MANQUE : Logique tableaux
└─ MANQUE : workspace-session.js (accès Workspace)
└─ MANQUE : file-upload.js (import/export)
```

### Docker & Infrastructure
```
Dockerfile           ✅ Multi-stage, Node 22
docker-compose.yml   ✅ Postgres + Redis OK
render.yaml          ✅ Déploiement OK
└─ MANQUE : workspace-runtime.Dockerfile (image de session)
└─ MANQUE : scripts/build-workspace-image.sh
└─ MANQUE : docker-compose.dev.yml (avec GPU support)
```

---

## 5️⃣ BLOCAGES CRITIQUES POUR MVP

| # | Blocage | Fichiers | Délai | Dépendance |
|---|---------|----------|-------|-----------|
| 1 | Agent Python: CLI structure + signature | `agent/**` | 2-3h | Rien |
| 2 | Escrow contract: Deploy sur Devnet | `programs/gpu_escrow/` | 1-2h | Agent OK |
| 3 | Heartbeat: Signature + verification | `apps/api/src/server.ts` | 1h | 1, 2 |
| 4 | Docker runtime: Workspace conteneur | `apps/api/src/docker.ts` + `Dockerfile.workspace` | 3-4h | 2, 3 |
| 5 | Session lifecycle: Start/Stop/Cleanup | `apps/api/src/server.ts` | 2-3h | 4 |
| 6 | Frontend: Workspace access + files | `apps/web/workspace-session.js` | 2h | 5 |

**Critical path:** 1 → 2 → 3 → 4 → 5 → 6 (≈ 11-15 heures)

---

## 6️⃣ PLAN D'EXÉCUTION ÉTAPE PAR ÉTAPE

### PHASE 1: Sécurisation Agent (2-3h)
**Objectif:** Agent peut se lier de façon sécurisée + envoyer heartbeats signés

1. ✅ Structure Agent Python :
   - `agent/__init__.py` + `agent/setup.py`
   - CLI entry point
   
2. ✅ Crypto module (`agent/crypto.py`):
   - Génération Ed25519 (nacl.signing.SigningKey)
   - Stockage clé privée in `~/.config/gpubnb/`
   - Signature de requêtes + timestamp + nonce

3. ✅ GPU detection (`agent/machine.py`):
   - Call nvidia-smi
   - Parsing GPU model, VRAM, driver, CUDA
   - CPU, RAM, disk via psutil

4. ✅ Backend verification:
   - `apps/api/src/security.ts`
   - authenticateAgent() : vérifie signature Ed25519
   - replayProtection() : timestamp + nonce
   - Machine authorized : stocké en Redis

5. ✅ Routes API sécurisées:
   - `POST /agent/heartbeat` → Vérification signature obligatoire
   - `POST /agent/challenge/:machineId` → Nonce pour signature
   - Logging audit d'tous les accès Agent

### PHASE 2: Déploiement Escrow (1-2h)
**Objectif:** Program ID obtenu, tests passent, prêt pour paiement

1. ✅ Compiler contrat:
   - `cd programs/gpu_escrow && anchor build`
   
2. ✅ Deploy sur Devnet:
   - Générer keypair deployer
   - `anchor deploy --provider.cluster devnet`
   - Récupérer Program ID
   
3. ✅ Initialiser config:
   - `initialize_config()` avec admin + oracle + platform wallet
   - Stocker Program ID in `.env`
   
4. ✅ Tests:
   - Créer escrow : `open()`
   - Proposer settlement : `propose_settlement()`
   - Finalize : vérifier split 95/5

### PHASE 3: Heartbeat Signé & Vérification (1-2h)
**Objectif:** Backend accepte uniquement heartbeats signés, machine visible ssi alive

1. ✅ Agent envoie:
   ```python
   heartbeat = {
     machineId: "cuid",
     counter: 42,
     challenge: "random",
     timestamp: "2026-07-23T12:00:00Z",
     gpuUtilization: 45,
     memoryUsedMiB: 2048,
     temperatureC: 65,
     signature: "base64(ed25519_signature)"
   }
   ```

2. ✅ Backend vérifie:
   - Machine exists + key not revoked
   - Signature valide avec agentPublicKey
   - Timestamp < 60s
   - Counter > lastCounter (replay attack)
   - Qualité telemetry (memory < vram, etc.)

3. ✅ Machine status:
   - connectivity: ONLINE si heartbeat < 40s
   - OFFLINE sinon (cron job check)
   - Machine disparaît de marketplace si OFFLINE

### PHASE 4: Docker Workspace Runtime (3-4h)
**Objectif:** Backend peut créer, démarrer, monitorier conteneur isolé

1. ✅ Dockerfile.workspace:
   - Ubuntu 22.04
   - Python 3.10
   - NVIDIA drivers + CUDA 12.1
   - PyTorch 2.x
   - JupyterLab
   - 512MB RAM limit
   - 1 CPU core limit
   - GPU passthrough
   - User non-root
   - NO /root mount, NO host file access

2. ✅ Backend docker.ts:
   ```typescript
   async function createWorkspaceContainer(
     sessionId: string,
     machineId: string,
     limits: ResourceLimits
   )
   - Generate container name: gpubnb-{sessionId}
   - Create volume for session
   - Run container with limits
   - Expose random port for JupyterLab
   - Return connection URL
   
   async function cleanupWorkspaceContainer(sessionId: string)
   - Stop container
   - Remove container
   - Delete volume
   - Close firewall rules
   ```

3. ✅ Session lifecycle in server.ts:
   - POST /bookings/{id}/workspace-sessions : create + prepare
   - POST /workspace-sessions/{id}/start : run container
   - GET /workspace-sessions/{id} : status
   - POST /workspace-sessions/{id}/stop : cleanup

4. ✅ Tests:
   - Container starts without errors
   - GPU accessible inside (nvidia-smi works)
   - Resource limits enforced
   - Cleanup removes everything
   - Machine can be reused immediately after

### PHASE 5: Session Lifecycle & Storage (2-3h)
**Objectif:** Locataire peut accéder au Workspace, importer/exporter fichiers

1. ✅ Import files:
   - POST /workspace-sessions/{id}/upload
   - Multipart upload
   - Size limit: 1GB per file
   - Virus scan mock
   - Store in session volume

2. ✅ Access Workspace:
   - GET /workspace-sessions/{id}/connection
   - Return JupyterLab URL + temporary auth token
   - Token expires at session.expiresAt
   - Rate limit: 1000 req/min per session

3. ✅ Export results:
   - GET /workspace-sessions/{id}/download?file=name.txt
   - ZIP multiple files
   - Keep for 7 days max
   - Automatic cleanup

4. ✅ Session expiration:
   - Auto-stop at session.expiresAt
   - Container killed
   - Volumes deleted
   - User redirected to "Session expired"
   - Booking marked COMPLETED

### PHASE 6: Frontend Integration (2h)
**Objectif:** Locataire peut cliquer "Réserver" → "Ouvrir" → utiliser GPU

1. ✅ apps/web/workspace-session.html:
   - Show prep progress (PREPARING → READY)
   - "Ouvrir Workspace" button (points to JupyterLab)
   - File upload drag-n-drop
   - Download results
   - "Terminer session" button

2. ✅ Dashboard pour propriétaire:
   - Lister machines
   - État chacun (ONLINE/OFFLINE/RESERVED/RUNNING)
   - Voir réservations actives
   - Logs d'accès

3. ✅ app.js enhancements:
   - Booking flow: sign → deposit → wait for session → open
   - Error handling: network fail, session timeout, container crash

---

## 7️⃣ DÉFINITION DE "TERMINÉ" (MVP)

Une étape est ✅ TERMINÉE seulement si:

### Étape 1: Agent Sécurisé
- [ ] Agent génère clé Ed25519 → stockée in ~/.config/gpubnb/
- [ ] GPU détecté via nvidia-smi → reporté au backend
- [ ] Heartbeat signé, vérifié, pas replay
- [ ] Tests: `npm test` ✅ PASS
- [ ] Linting: `eslint src/ agent/` ✅ PASS

### Étape 2: Escrow Déployé
- [ ] Program ID != "NOT_DEPLOYED_YET"
- [ ] initialize_config() réussi
- [ ] Test open() → funded ✅
- [ ] Test propose_settlement() ✅
- [ ] Test finalize() → split vérifié ✅

### Étape 3: Heartbeat Accepté
- [ ] POST /agent/heartbeat sans signature → 401 REJECT
- [ ] POST /agent/heartbeat avec signature valide → 200 OK
- [ ] Machine.connectivity = ONLINE après heartbeat
- [ ] Machine.connectivity = OFFLINE après 40s inactivité
- [ ] Listing disparaît de marketplace si OFFLINE

### Étape 4: Docker Container Runnable
- [ ] Dockerfile.workspace construit sans erreur
- [ ] Container démarre en < 30s
- [ ] nvidia-smi fonctionne inside container
- [ ] GPU utilisable (test PyTorch)
- [ ] Resource limits appliquées (check via docker stats)
- [ ] User non-root, pas d'accès /root
- [ ] Cleanup : container gone, volume deleted

### Étape 5: Session Lifecycle
- [ ] POST /bookings/{id}/workspace-sessions → PREPARING
- [ ] POST /workspace-sessions/{id}/start → RUNNING
- [ ] Container still running after 5 min
- [ ] GET /workspace-sessions/{id} → real status
- [ ] POST /workspace-sessions/{id}/stop → COMPLETED + cleanup
- [ ] Machine reusable immediately

### Étape 6: Full MVP
- [ ] Prop: Agent installé ✅
- [ ] Prop: Machine publiée ✅
- [ ] Prop: Machine visible in marketplace ✅
- [ ] Rent: Recherche machine ✅
- [ ] Rent: Réserve 1 heure ✅
- [ ] Rent: Signe dépôt Phantom ✅
- [ ] Rent: Session prête (READY) ✅
- [ ] Rent: Ouvre Workspace dans navigateur ✅
- [ ] Rent: Execute test GPU (nvidia-smi + PyTorch) ✅
- [ ] Rent: Upload fichier test.py ✅
- [ ] Rent: Télécharge résultats ✅
- [ ] Rent: Session terminée ✅
- [ ] Prop: Machine de nouveau AVAILABLE ✅
- [ ] E2E test: Pass en < 10 min ✅

---

## 8️⃣ RISQUES & DÉPENDANCES

### Dépendances externes
| Service | Status | Risk | Mitigation |
|---------|--------|------|-----------|
| Solana Devnet RPC | ✅ Publique | MEDIUM | Rate limit handling |
| PostgreSQL | ✅ Standup OK | LOW | Backup migration |
| Redis | ✅ Standup OK | LOW | Failover strategy |
| NVIDIA drivers | ⚠️ Host dependent | HIGH | Graceful degradation |
| Docker | ⚠️ Host dependent | MEDIUM | Mock for testing |

### Risques techniques
| Risque | Probabilité | Impact | Mitigation |
|--------|------------|--------|-----------|
| GPU indisponible sur host | HIGH | BLOCKING | Mock hardware, CI sans GPU |
| Docker/containerd pas installé | MEDIUM | BLOCKING | Pre-flight check + docs |
| Network isolation failed | MEDIUM | SECURITY | AppArmor + seccomp |
| Container cleanup fail | MEDIUM | RESOURCE LEAK | Periodic garbage collection |
| Renter access after expiry | HIGH | SECURITY | Token expiry enforcement |

### Mitigations obligatoires
- [ ] Rate limiting sur /agent/heartbeat (30/min)
- [ ] Rate limiting sur /workspace-sessions/*/upload (10/min)
- [ ] File size limits (1GB per file, 5GB per session)
- [ ] Session TTL (max 24h)
- [ ] Container resource limits (512MB RAM, 1 CPU, 1 GPU slot)
- [ ] Audit logging de tous les accès Agent + Workspace
- [ ] Automatic cleanup timer (every 5 min check for expired sessions)

---

## 9️⃣ RÉSUMÉ EXÉCUTIF

### ✅ Ce qui fonctionne
1. Authentification Phantom + Sessions
2. Marketplace & Listings (affichage)
3. Database schema complet
4. Heartbeat endpoint (non sécurisé)
5. Escrow contract logic (non déployé)
6. Workspace manifests (non exécutés)

### ❌ Ce qui bloque le MVP
1. Agent Python : 0% implémentation
2. Agent signature : Zéro vérification
3. Escrow deployment : Program ID manquant
4. Docker runtime : Zéro code
5. Session management : Routes vides
6. File storage : Zéro implémentation

### ⏰ Effort estimé pour MVP complet
- Agent + Security: 2-3h
- Escrow Deploy: 1-2h
- Docker Runtime: 3-4h
- Session Lifecycle: 2-3h
- Frontend: 2h
- Tests E2E: 1-2h
- **Total: 11-17 heures** (1-2 jours)

### 🎯 Next step
**Lancer PHASE 1 dès maintenant** — Construire Agent Python fonctionnel avec CLI + signatures cryptographiques

---

**Rapport généré:** 2026-07-23 | **Auteur:** GPUbnb Technical Lead  
**Visé pour MVP:** 2026-07-24 17:00 UTC
