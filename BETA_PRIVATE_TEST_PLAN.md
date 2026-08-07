# GPUbnb — Plan de test bêta privée

Ce document a deux parties : (1) le protocole de validation entre deux machines physiques distinctes, exigé avant d'accepter le premier hôte externe réel en bêta privée, et (2) le plan de test fonctionnel plus large de la bêta.

**Aucun test de ce document n'a été exécuté dans le cadre de cette tâche.** Une seule machine physique de développement (Windows 11, Docker Desktop WSL2, GTX 1650 — voir `KNOWN_LIMITATIONS_RC1.md`) a été utilisée pour produire le code de la branche `feat/beta-readiness-hardening`. Ce document remplace, pour la bêta privée, la portée de `docs/TWO_PC_TEST.md` (daté « Phase 1 », rédigé avant l'existence des jobs `GPU_PROOF`/`WORKSPACE_PREPARE`, du Delivery Worker, du sweep planifié et de l'exclusivité GPU).

## Partie 1 — Protocole deux machines physiques

### 1.0 Prérequis

- Deux machines physiques distinctes, sur des réseaux différents si possible (au minimum : deux postes physiques séparés, idéalement pas sur le même sous-réseau local, pour exercer un vrai NAT).
- PC A (« hôte ») : GPU NVIDIA réel, pilote installé, `nvidia-smi` fonctionnel, Docker + NVIDIA Container Toolkit.
- PC B (« locataire ») : navigateur seulement, aucun GPU requis.
- Une instance API accessible depuis les deux machines (déploiement Render existant, ou tunnel type `ngrok`/`cloudflared` vers une instance locale — à documenter au moment du test, pas de solution imposée ici).
- `DEV_PAYMENT_BYPASS=true` autorisé pour ce protocole (aucun paiement réel — voir Priorité 6 / `BETA_PRIVATE_READINESS.md` section 2 pour la raison structurelle : le programme d'escrow n'est pas déployé).

### 1.1 Étape A — PC A, installation et diagnostic local

```bash
nvidia-smi
python -m pip install -e agent
gpubnb-agent setup
gpubnb-agent diagnose
```

**Preuve attendue :** `diagnose` rapporte exactement un GPU réel, Docker disponible, runtime NVIDIA disponible. **Critère d'échec :** tout écart doit être corrigé avant de poursuivre — ne jamais continuer le protocole avec un `diagnose` en échec partiel.

### 1.2 Étape B — PC B, liaison

1. Se connecter sur `https://gpubnb.netlify.app/dashboard.html` (ou l'URL de l'environnement de bêta).
2. Activer le rôle loueur, créer un code de liaison à usage unique.
3. Transmettre uniquement ce code (canal séparé — pas le même que celui utilisé pour l'API elle-même) au PC A.

### 1.3 Étape C — PC A, liaison et heartbeat à travers un vrai réseau

```bash
gpubnb-agent link CODE_RECU
gpubnb-agent status
gpubnb-agent start --daemon
gpubnb-agent logs
```

**Preuve attendue :**
- `link` renvoie un `machineId`.
- Le tableau de bord du PC B affiche la machine en ligne dans un délai cohérent avec `HEARTBEAT_MAX_AGE_SECONDS`/`HEARTBEAT_OFFLINE_SECONDS`.
- La latence réseau réelle entre les deux machines est visible dans les journaux (timestamps heartbeat vs horloge serveur) — noter la valeur observée dans le rapport de test, ce protocole ne doit pas se contenter d'un « OK/KO ».
- Couper le Wi-Fi/câble du PC A quelques minutes : la machine doit passer hors-ligne côté PC B **après le prochain cycle du sweep-scheduler** (voir Priorité 3 — `SWEEP_INTERVAL_MS`, par défaut 30 s, plus `HEARTBEAT_OFFLINE_SECONDS`), sans intervention manuelle. C'est un test que RC1 n'a jamais pu exécuter (pas d'ordonnanceur alors) et qui devient possible pour la première fois avec cette branche.

### 1.4 Étape D — Réservation et exécution d'un job réel entre les deux machines

Sur PC B : effectuer une réservation réelle sur la machine du PC A (parcours UI standard), pour chacun des trois types de job, l'un après l'autre :

1. `GPU_DIAGNOSTIC` — déjà prouvé à plusieurs reprises en Phase 4/5 RC1, mais **jamais entre deux machines physiques distinctes**. Refaire ce test ici est nécessaire : la preuve RC1 ne couvre pas la latence réseau réelle ni un agent hébergé sur un poste vraiment séparé.
2. `WORKSPACE_PREPARE` — **jamais exécuté en conditions réelles**, RC1 comme cette branche. Premier test réel à faire.
3. `GPU_PROOF` — **jamais exécuté en conditions réelles**. Vérifier la preuve d'usage signée (`workspaceSession.metrics`, `workloadProof:true`) et le calcul de règlement en préversion (`GET /bookings/:id/settlement-preview`).

**Preuve attendue pour chaque job :** transitions d'état visibles (`QUEUED → ASSIGNED → ... → COMPLETED`), résultat cohérent, nettoyage du conteneur confirmé (`containerCleaned:true` pour `GPU_PROOF`), aucune erreur `*_cleanup_unverified`.

### 1.5 Étape E — Exclusivité GPU entre deux machines (Priorité 4)

Ce test valide spécifiquement le verrou par `gpuUuid` ajouté dans cette branche, qui ne peut être exercé de façon significative que si deux machines partagent — volontairement, pour le test — le même identifiant GPU signalé :

1. Configurer temporairement PC A et une VM/second processus agent pour rapporter le **même** `gpuUuid` factice dans leur inventaire (environnement de test uniquement, jamais en bêta réelle).
2. Lancer un job exclusif sur la première identité, vérifier qu'il passe `ASSIGNED`.
3. Tenter de réclamer un second job sur la seconde identité pendant que le premier est actif : il doit rester `QUEUED` (log `gpu_exclusivity_claim_deferred` côté API).
4. Laisser le premier job terminer, vérifier que le second peut alors être réclamé.

**Statut actuel : conçu mais jamais exécuté.** La suite `gpu-exclusivity.test.ts` (15 tests) prouve la logique en isolation (base de données simulée) ; ce protocole prouverait le comportement de bout en bout, ce qu'aucun test automatisé ne peut faire à la place d'une exécution réelle.

### 1.6 Étape F — Arrêt propre et redémarrage

```bash
gpubnb-agent stop
gpubnb-agent start --daemon
```

Vérifier : aucune double instance (Priorité 1, déjà prouvé en local — à reconfirmer sur une machine physique différente de celle utilisée pendant le développement), reprise normale des heartbeats.

### 1.7 Ce que ce protocole ne couvre toujours pas

- Redémarrage complet du PC hôte (coupure/reboot matériel réel) — explicitement exclu, comme en Phase 5 RC1.
- Charge (plusieurs dizaines de machines/réservations simultanées).
- `apps/host-desktop` (application Tauri) comme rôle hôte réel — ce protocole utilise l'agent CLI ; un protocole équivalent avec le binaire Tauri packagé doit être rejoué séparément avant d'ouvrir la bêta aux hôtes qui n'installeront que l'application graphique.
- Argent réel (voir Priorité 6 / `BETA_PRIVATE_READINESS.md`).

### 1.8 Checklist exacte, par catégorie

Cette section reprend le protocole des sections 1.1 à 1.7 sous forme de checklist opérationnelle, organisée exactement par ce qu'un exécutant doit vérifier avant/pendant/après le test. **Aucune case ne doit être cochée sans exécution réelle** — voir aussi `BETA_PRIVATE_CHECKLIST.md`.

#### PC hôte (PC A)
- [ ] Windows 10/11 ou Ubuntu récent.
- [ ] Pilote NVIDIA installé, `nvidia-smi` renvoie exactement un GPU.
- [ ] Docker installé et démarré (Docker Desktop/WSL2 sous Windows, Docker Engine sous Linux) + NVIDIA Container Toolkit — vérifiés ensemble par `gpubnb-agent diagnose`.
- [ ] Espace disque libre suffisant pour les images Docker tirées pendant le test (plusieurs Go — images de diagnostic/GPU-proof/workspace).
- [ ] Python 3.10+ installé **si** test avec l'agent CLI (section « Installation agent » ci-dessous) ; sinon `GPUbnb Host` (portable ou installateur) **si** test du rôle hôte via l'application graphique.
- [ ] Accès Internet sortant fonctionnel (aucune IP publique ni port entrant requis pour le flux actuel — voir « Réseau »/« Ports » ci-dessous).

#### PC locataire (PC B)
- [ ] Navigateur récent (pas de GPU, pas de Docker, pas d'agent requis).
- [ ] Accès Internet sortant vers l'URL de l'API/dashboard de test.
- [ ] Compte GPUbnb créé, rôle loueur activé.

#### Réseau
- [ ] PC A et PC B sur des réseaux physiquement distincts si possible (pas seulement deux fenêtres sur le même LAN) — c'est ce qui exerce un vrai NAT et une vraie latence, jamais testé jusqu'ici (une seule machine physique tout du long en RC1).
- [ ] Latence réelle observée entre PC A et l'API, et entre PC B et l'API, notée dans le compte-rendu du test (pas seulement « ça marche »).
- [ ] Aucune règle de pare-feu entrante spéciale requise côté PC A : l'agent (CLI ou via `host-desktop`) est **exclusivement un client HTTP sortant** vers l'API (sondage `GET /agent/jobs/next/:machineId`, heartbeats) — vérifié par lecture de code (`server.ts`, aucune route n'exige que l'API initie une connexion vers l'agent). C'est un point à confirmer expérimentalement, pas seulement à supposer, la première fois que ce protocole est réellement exécuté.
- [ ] Le pare-feu de PC A ne bloque pas le trafic HTTPS sortant vers l'API **et** vers le registre d'images (GHCR/Docker Hub, nécessaire pour `docker pull`).

#### Ports
- [ ] PC A (hôte) : **aucun port entrant à ouvrir** pour le flux de réservation/job actuel (confirmé par lecture de code : `connectionType`/`connectionMetadata` du modèle `WorkspaceSession` existent en base mais ne sont écrits nulle part dans `server.ts` — aucun mécanisme de connexion directe locataire → hôte n'est implémenté aujourd'hui, tout passe par l'API).
- [ ] PC B (locataire) : aucun port entrant.
- [ ] API : port sortant 443 (HTTPS) atteignable depuis PC A et PC B. Si le test cible une instance locale plutôt que Render, documenter séparément le port du tunnel utilisé (ex. `ngrok`/`cloudflared`) — aucune solution n'est imposée par ce dépôt.
- [ ] Si l'API testée tourne en local (pas Render) : Postgres (5432) et Redis (6379) ne doivent être exposés que sur la machine qui héberge l'API, jamais publiquement.

#### Installation agent (PC A, CLI Python)
- [ ] `python -m pip install -e agent`
- [ ] `gpubnb-agent setup`
- [ ] `gpubnb-agent diagnose` → GPU/Docker/runtime NVIDIA tous positifs avant de poursuivre.
- [ ] `gpubnb-agent link CODE_RECU` (code créé côté PC B, transmis par un canal séparé).
- [ ] `gpubnb-agent status` → confirme le PID réel détenteur du verrou d'instance (Priorité 1).

#### host-desktop (PC A, application graphique — parcours séparé de la CLI)
- [ ] Installation depuis l'exécutable portable (`GPUbnb-Host-Portable.exe` + `gpubnb-agent.exe` à côté) ou l'installateur (`gpubnb-host-windows-x64.exe`).
- [ ] Aucune console n'est utilisée manuellement pendant ce test — le but est de vérifier le parcours 100 % graphique.
- [ ] Application détecte le GPU, propose la liaison, affiche un état de connexion cohérent avec `gpubnb-agent status` en parallèle (vérification croisée).
- [ ] **Jamais exécuté comme rôle hôte réel avant ce test** (`KNOWN_LIMITATIONS_RC1.md`) — premier passage réel.

#### API
- [ ] `curl -s https://<host>/health` → `ok:true`.
- [ ] `curl -s https://<host>/ready` → `ok:true` (confirme DB + Redis atteignables par l'API elle-même).
- [ ] Les trois processus tournent (API, Delivery Worker, Sweep Scheduler — voir `BETA_PRIVATE_OPERATIONS.md`).
- [ ] Journaux `sweep_scheduler_started`/`delivery_worker_started` visibles au démarrage.

#### Réservation (PC B)
- [ ] Machine du PC A visible et « en ligne » dans le tableau de bord.
- [ ] Réservation créée sur cette machine (parcours UI standard).
- [ ] `DEV_PAYMENT_BYPASS=true` actif pour ce test (voir décision de périmètre, `BETA_PRIVATE_READINESS.md` section 2.6) — réservation financée automatiquement par la réconciliation de développement (`reconcileDevelopmentBookings`), pas de paiement réel.

#### Exécution GPU (PC A exécute, PC B observe)
- [ ] `GPU_DIAGNOSTIC` : transitions `QUEUED → ASSIGNED → DOWNLOADING/PREPARING → RUNNING → UPLOADING_RESULTS → COMPLETED` visibles.
- [ ] `WORKSPACE_PREPARE` : idem — **premier test réel**, jamais exécuté avant.
- [ ] `GPU_PROOF` : idem, avec échantillons de métriques signés envoyés pendant l'exécution (`send_session_metric` côté agent) — **premier test réel**.
- [ ] Pendant l'exécution de chacun : tenter de réclamer un second job exclusif sur la même machine (ou la même `gpuUuid` de test, voir étape E) et confirmer qu'il reste `QUEUED`.

#### Preuve
- [ ] Pour chaque job : `result.gpuDetected=true`, résultat cohérent avec le matériel réel du PC A.
- [ ] Pour `GPU_PROOF` : `finalize-proof` accepté, `provenSeconds >= 1`, réservation passée à `COMPLETED`.
- [ ] Capture des journaux structurés pertinents (`sweep_cycle_completed`, `gpu_exclusivity_claim_deferred` le cas échéant) et des captures d'écran du tableau de bord PC B à chaque étape clé.
- [ ] Résultat consigné dans un document `*_RESULT.md` séparé (même format que `docs/FIRST_REAL_GPU_RENTAL_RESULT.md`), pas seulement une case cochée sans trace.

#### Nettoyage
- [ ] `docker ps -a` sur PC A après chaque job : aucun conteneur résiduel (`gpubnb-diagnostic-*`/`gpubnb-gpu-proof-*`/équivalent workspace).
- [ ] Aucune erreur `diagnostic_cleanup_unverified`/`gpu_proof_cleanup_unverified` dans les journaux — si l'une apparaît, **ne pas** lever manuellement la quarantaine qui en résulte sans vérification physique réelle (`BETA_PRIVATE_OPERATIONS.md` section 5).
- [ ] `nvidia-smi` sur PC A confirme qu'aucun processus résiduel n'occupe le GPU après la fin du test.

#### Retour `AVAILABLE`
- [ ] `Machine.operational` repasse à `AVAILABLE` après un cycle réussi (visible côté tableau de bord PC B et/ou requête API).
- [ ] `Machine.moderationStatus` reste `CLEAR` (aucune quarantaine déclenchée par un test réussi).
- [ ] La machine peut immédiatement accepter une nouvelle réservation après ce retour — vérifié en tentant une seconde réservation de test.
- [ ] Si un test échoue et laisse la machine quarantinée : suivre la procédure de levée manuelle (`BETA_PRIVATE_OPERATIONS.md` section 5) avant de considérer le protocole terminé.

## Partie 2 — Plan de test fonctionnel de la bêta privée

À exécuter par l'équipe avant d'inviter le premier utilisateur externe, en plus du protocole deux machines ci-dessus.

| # | Scénario | Statut avant cette tâche | Preuve requise |
|---|---|---|---|
| 1 | Cycle complet réservation → paiement bypass → job `GPU_DIAGNOSTIC` → réglement preview | Prouvé (Phase 4 RC1, 10 locations) | Déjà acquis, pas à rejouer sauf régression |
| 2 | `GPU_PROOF` de bout en bout avec preuve d'usage signée | Jamais exécuté | Partie 1, étape D |
| 3 | `WORKSPACE_PREPARE` de bout en bout | Jamais exécuté | Partie 1, étape D |
| 4 | Sweep planifié détecte une machine hors-ligne sans intervention manuelle | Jamais exécuté (pas d'ordonnanceur avant cette branche) | Partie 1, étape C |
| 5 | Delivery Worker survit à une coupure Redis/DB transitoire sans redémarrage manuel | Corrigé en Priorité 2, prouvé par tests automatisés (`delivery-worker-resilience.test.ts`), **jamais rejoué en conditions réelles avec un vrai Docker/Render** | À rejouer en environnement de déploiement réel avant la bêta |
| 6 | Exclusivité GPU entre deux machines physiques | Jamais exécuté | Partie 1, étape E |
| 7 | Instance unique de l'agent sur une machine physique de bêta (pas la machine de développement) | Prouvé uniquement sur la machine de développement | Partie 1, étape F |
| 8 | Annulation d'une réservation en cours par le locataire | Non vérifié dans cette tâche | À planifier |
| 9 | Comportement de `moderationStatus=QUARANTINED` visible et compréhensible côté hôte (UI) | Non vérifié dans cette tâche | À planifier — vérifier que l'hôte quarantiné comprend pourquoi et comment demander une levée |
| 10 | Application `host-desktop` comme rôle hôte réel, installation Windows propre | Jamais exécuté comme parcours hôte réel | Voir `BETA_PRIVATE_INSTALLATION.md` |

## Critère de sortie de cette partie du plan

La bêta privée ne doit accepter son premier hôte externe réel qu'après exécution effective — pas seulement planification — des scénarios 2, 3, 4, 6, 7 et 10 ci-dessus, avec preuve écrite (captures, journaux, ou nouveau document `*_RESULT.md` suivant le format déjà utilisé pour `docs/FIRST_REAL_GPU_RENTAL_RESULT.md`).
