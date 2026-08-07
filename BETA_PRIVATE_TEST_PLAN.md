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
