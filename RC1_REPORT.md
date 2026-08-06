# Rapport RC1 — GPUbnb

**Branche :** `feature/first-gpu-rental` · **PR :** [#44](https://github.com/khemisset18/gpubnb/pull/44) (draft, `MERGEABLE`, `main` ← `feature/first-gpu-rental`)
**SHA final (code) :** `ad3f5ea9a523dde09bca995aa1edc328fce42f2d` — dernier commit fonctionnel, celui vérifié par le CI vert décrit ci-dessous.
**SHA HEAD (avec ce rapport) :** `c0a51eaf2d51d096d316bd5fbb0412886adc4066` — ajoute uniquement les artefacts RC1 (ce document et les 5 autres fichiers listés en section 11), aucun changement de code. Le CI n'a pas été re-déclenché sur ce commit précis (changement documentation uniquement, sans impact sur les tests/build).
**Date de clôture :** 2026-08-07 (UTC)

---

## 1. Verdict

### READY TO MERGE (techniquement), sous réserve de l'autorisation explicite de l'utilisateur

**CI GitHub Actions confirmé intégralement vert** sur le SHA final `ad3f5ea` : `gh pr checks 44` → **exit code 0**, tous les checks `pass` (y compris le dernier en attente au moment de la rédaction initiale, `Windows x64` / installeur `host-desktop`, terminé en 7m4s, `pass`). Aucun check en échec, aucun check restant `pending`.

**Réserves (non bloquantes techniquement, à la discrétion de l'utilisateur) :**
- Aucune revue humaine indépendante de cette PR n'a eu lieu (session solo).
- `apps/host-desktop` n'a jamais été exercé comme rôle hôte réel (voir `KNOWN_LIMITATIONS_RC1.md`).

**Toute la checklist de fusion technique est vérifiée avec preuve** (voir section 11). Aucune régression connue. Aucun bug non corrigé de sévérité CRITIQUE.

**Je ne fusionnerai pas cette PR sans une autorisation explicite et séparée de l'utilisateur, conformément à la règle absolue établie au début de cette campagne.**

---

## 2. Nombre total de commits de cette campagne

**28 commits** sur `feature/first-gpu-rental`, depuis la divergence de `main` (`da4b48a`) jusqu'au SHA final.

```
git log --oneline main..HEAD | wc -l
28
```

Liste complète, dans l'ordre chronologique, avec hash court : voir `CHANGELOG.md`.

---

## 3. Bugs découverts

### 3.1 — Pendant le premier parcours GPU réel (5 bugs)

| # | Commit | Composant | Résumé |
|---|---|---|---|
| 1 | `b63b158` | Delivery Worker | Plantage au démarrage — cast `bigint`/`integer` Prisma vers SQL |
| 2 | `e0fda0e` | API / agent | Heartbeat systématiquement rejeté — perte de précision flottante lors du rehashage de signature |
| 3 | `c77fd71` | Image Docker `gpu-diagnostic` | `nvml_library_unavailable` — dépendances glibc/mount manquantes dans l'image `scratch` |
| 4 | `d8b0d33` | Agent + API | 3 bugs en cascade empêchant la complétion d'un job (schéma, largeur colonne, rejeu de signature) |
| 5 | `b419998` | Delivery Worker | Ré-dégradation infinie des machines une fois `DEGRADED`, bloquant tout retour `AVAILABLE` |

### 3.2 — Audit CRITIQUE multi-agent (18 items, C1–C18)

17 corrigés (C1–C16, C18), 1 explicitement différé (C17, hors périmètre production pour `host-desktop`). Détail complet dans `CHANGELOG.md`.

### 3.3 — Pendant la Phase 5 (tests de robustesse), 3 bugs réels

| # | Commit | Composant | Résumé | Preuve |
|---|---|---|---|---|
| 6 | `9f3f03e` | API (`/bookings`) | Fuite de message d'erreur Prisma brut + absence de retry sous contention réelle | Requêtes concurrentes réelles, avant/après |
| 7 | `2d1acf7` | API (sweep) | Aucune détection de staleness au niveau job, indépendante du heartbeat machine | Coupure API réelle mid-job, job resté bloqué malgré agent sain |
| 8 | `d4b1698` | API (heartbeat) | Rapport agent honnête de nettoyage non vérifié ignoré par le heartbeat suivant | Requête signée réelle (même clé agent), machine remise `AVAILABLE` avant correctif |

### 3.4 — Pendant la vérification finale (Phase 6), 1 bug bloquant CI

| # | Commit | Composant | Résumé |
|---|---|---|---|
| 9 | `ad3f5ea` | `host-desktop` (style) | `cargo fmt --check` en échec sur les 3 plateformes CI, bloquant tout le job « rust tests and lint » |

**Total : 9 chaînes de bugs réels identifiées (regroupant plusieurs sous-bugs dans certains cas), sur 28 commits.**

---

## 4. Bugs corrigés

**Tous.** Chacun des 9 items ci-dessus est corrigé, avec commit isolé, et — pour les items 6, 7, 8, 9 (Phase 5/6) — vérifié par une reproduction live réelle avant et après le correctif (pas seulement par lecture de code). Voir `CHANGELOG.md` pour le détail par commit.

Aucun bug trouvé pendant cette campagne n'a été laissé non corrigé.

---

## 5. Risques restant ouverts

Voir `RISKS_RC1.md` pour le détail complet avec preuve. Résumé :

| # | Sévérité | Risque |
|---|---|---|
| R1 | IMPORTANT | Delivery Worker sans politique de redémarrage automatique en cas de crash |
| R2 | IMPORTANT | Aucun ordonnanceur pour `/internal/sweep-offline` dans ce dépôt (route existe, rien ne l'appelle périodiquement) |
| R3 | IMPORTANT | Aucune exclusivité GPU côté agent (sans conséquence pour `GPU_DIAGNOSTIC`, à traiter avant un job de calcul exclusif) |
| R4 | MINEUR | Deux instances d'agent peuvent tourner en parallèle sans garde-fou |
| R5 | MINEUR | Couplage Docker/infrastructure spécifique au dev local (sans impact production) |

Le chemin de production du timeout de workload (anciennement R5) a été validé de manière déterministe, après échec des tentatives de chaos en environnement réel — voir section 8 pour le détail exact et `RISKS_RC1.md`.

---

## 6. Couverture de tests

| Suite | Résultat | Commande |
|---|---|---|
| `apps/api` (Node test runner) | **183/183** verts, 0 échec | `npm test` |
| `apps/api` type-check | Propre, 0 erreur | `npx tsc --noEmit` |
| Agent Python | **55/55** verts (1 `skipped`, contrat non-Windows attendu) | `python -m unittest discover -s tests` |
| `programs/gpu_escrow` (Rust) | **7/7** verts | `cargo test` |
| `apps/host-desktop/src-tauri` (Rust) | **440/440** verts | `cargo test --locked -p gpubnb-host-desktop --all-targets` |
| `cargo fmt --check` (host-desktop) | Propre (corrigé en Phase 6) | `cargo fmt -p gpubnb-host-desktop -- --check` |
| `cargo clippy -D warnings` (host-desktop) | Propre, 0 warning | `cargo clippy --locked -p gpubnb-host-desktop --all-targets -- -D warnings` |

**Total automatisé : 685 tests exécutés, 685 verts, 1 skip attendu, 0 échec**, tous exécutés en direct pendant cette session (pas de résultat réutilisé d'une exécution antérieure sans re-vérification).

---

## 7. Résultats des tests E2E (parcours de location réels)

- **Première location GPU réelle de bout en bout** (session initiale) : booking `cmsgzduna0023icvkb5nwm32g`, job `cmsgzdv3u0003iccce5j2a4k9`, `gpuDetected:true`, 0 conteneur résiduel. Détail complet : `docs/FIRST_REAL_GPU_RENTAL_RESULT.md`.
- **Phase 4 — 10 locations GPU réelles consécutives** : 10/10 `COMPLETED`, température 64→77°C (jamais ≥85°C, seuil d'abandon jamais atteint), 0 conteneur résiduel, 0 heartbeat 401, 0 erreur HTTP, machine `AVAILABLE` confirmée après chaque cycle.
- **Phase 5/6 — locations réelles additionnelles** (tests de robustesse + preuve finale) : au moins 6 réservations réelles supplémentaires exécutées et menées à `COMPLETED` pendant la Phase 5/6, incluant la réservation de preuve finale `cmsi4hhne001dicfwhzc8ud0x` (`COMPLETED` en ~35s, 0 conteneur résiduel, machine `AVAILABLE`, GPU à 75°C en fin de session).

**Au total, sur l'ensemble de la campagne : au moins 17 réservations GPU réelles menées à `COMPLETED` sur matériel physique.**

---

## 8. Résultats des tests de robustesse (Phase 5)

| # | Scénario | Résultat |
|---|---|---|
| 1 | Workload échoue volontairement | ✅ Validé — `diagnostic_image_pull_failed`, booking `DEGRADED`, machine `AVAILABLE` |
| 2 | Timeout de workload dépassé | ⚙️ Validé par méthode déterministe — les tentatives de chaos en environnement réel n'ont pas permis de reproduire un timeout naturel, pour des raisons propres à l'environnement (voir détail ci-dessous). Le chemin de production du timeout a ensuite été validé de manière déterministe en exerçant directement le code réel de l'agent, sans modification du code de production. Une régression automatisée garantit désormais ce comportement |
| 3 | Résultat/preuve invalide | ✅ Validé — 3 attaques réelles signées rejetées (401/400/409) |
| 4 | GPU déjà occupé | ✅ Validé — job `COMPLETED` en concurrence avec un processus tiers réel |
| 5 | Réservation concurrente | ✅ Validé + défaut corrigé (`9f3f03e`) — 5/5 essais post-correctif : 1 gagnant, 1 rejet propre, 0 fuite |
| 6 | Arrêt contrôlé de l'agent | ✅ Validé — état sûr, récupération via sweep manuel |
| 7 | Redémarrage contrôlé de l'agent | ✅ Validé — PID périmé détecté, récupération complète prouvée |
| 8 | Interruption API/réseau | ✅ Validé + défaut corrigé (`2d1acf7`) — vérifié en direct, seuil réduit puis restauré |
| 9 | Arrêt contrôlé de Docker | ✅ Validé (2 constats documentés, R1/R5) |
| 10 | Nettoyage impossible (mock + reproduction live) | ✅ Validé + défaut corrigé (`d4b1698`) — vérifié en direct, requête signée réelle |

**10/10 validés avec preuve.** 6/10 sans réserve, 3/10 avec un défaut réel trouvé et corrigé, 1/10 (Test 2) validé par une méthode déterministe après échec des tentatives de chaos en environnement réel. **0/10 test non concluant.**

**Détail du Test 2, pour éviter toute ambiguïté lors d'une revue technique :**
1. Trois tentatives de reproduction en environnement réel ont été réalisées (pause du conteneur Docker via `docker events`/`docker pause`, blocage réseau sur une IP unique, blocage réseau sur une plage CIDR entière).
2. Ces trois tentatives ont échoué pour des raisons structurelles de l'environnement de test (conteneur officiel s'exécutant en moins d'une seconde, rotation d'IP côté GitHub, rejet instantané du pare-feu Windows au lieu d'un blocage réseau prolongé) — **pas à cause d'un défaut du code**.
3. Une méthode déterministe a ensuite été utilisée pour exercer le véritable chemin de production (`run_gpu_diagnostic()` → `subprocess.run(timeout=...)`) **sans modifier le code de production**.
4. Cette méthode substitue temporairement le binaire `docker` sur le `PATH` du processus de test afin de provoquer un blocage contrôlé de `docker run`, tout en laissant les autres commandes Docker (`pull`, `image inspect`, `container ls`, `rm`) s'exécuter contre le démon Docker réel.
5. Le timeout (`RuntimeError('diagnostic_timeout')`) est ainsi reproduit de façon déterministe et reproductible (deux exécutions, ~34s à chaque fois).
6. Une régression automatisée permanente (`agent/tests/test_agent.py::test_diagnostic_container_hang_is_reported_as_a_timeout`) vérifie désormais ce comportement à chaque exécution de la suite de tests.

Ce test **n'a pas** reproduit un timeout naturel en conditions réelles de bout en bout — il valide le chemin de code par une méthode déterministe et contrôlée.

---

## 9. Résultats des tests GPU réels

- GPU : NVIDIA GeForce GTX 1650, pilote 592.82, CUDA 13.1, 4096 MiB VRAM.
- Image diagnostic officielle : `ghcr.io/khemisset18/gpu-diagnostic@sha256:6c31bbf29c9a11a45ec88e3cd7ff34929c0b9aa6125ce591cbfbfa663303c748`, republiée et signée cosign pendant cette campagne (correctif bug #3).
- Type de job testé en conditions réelles : `GPU_DIAGNOSTIC` uniquement (voir `KNOWN_LIMITATIONS_RC1.md` pour `GPU_PROOF`/`WORKSPACE_PREPARE`, non testés).
- Température maximale observée sur l'ensemble de la campagne : **77°C**, jamais atteint le seuil d'abandon (85°C).
- Aucun conteneur résiduel constaté à aucun moment de la campagne (vérifié après chaque exécution réelle, `docker ps -a --filter name=gpubnb-diagnostic`).

---

## 10. Environnement exact utilisé

| Composant | Version |
|---|---|
| OS | Microsoft Windows 11 Famille, build 10.0.26200 |
| Docker Desktop | 29.6.2 (backend WSL2, moteur `desktop-linux`) |
| GPU | NVIDIA GeForce GTX 1650, pilote 592.82, CUDA 13.1, 4096 MiB VRAM |
| Node.js | v24.15.0 |
| Python (agent, venv dédié) | 3.13.14 |
| Rust (`rustc`/`cargo`) | 1.97.1 |
| PostgreSQL | 16 (image `postgres:16-alpine`, conteneur Docker local) |
| Redis | 7 (image `redis:7-alpine`, conteneur Docker local) |
| Mode paiement | `DEV_PAYMENT_BYPASS=true` sur toute la campagne (voir `KNOWN_LIMITATIONS_RC1.md`) |

---

## 11. SHA final, git status, fichiers modifiés

**SHA final :** `ad3f5ea9a523dde09bca995aa1edc328fce42f2d`
**Branche :** `feature/first-gpu-rental`, poussée vers `origin/feature/first-gpu-rental` (confirmé, `bb1b2c3..ad3f5ea`).

**`git status` au moment de la clôture :**
```
(clean — aucun fichier non suivi, aucune modification non commitée)
```

**Fichiers modifiés depuis la divergence de `main` :** 43 fichiers, +1882/-1198 lignes.

```
.env.example
.github/workflows/deployment-readiness.yml
.gitignore
README.md
agent/__init__.py                                  (supprimé)
agent/gpubnb_agent/cli.py
agent/gpubnb_agent/client.py
agent/gpubnb_agent/runner.py
agent/gpubnb_agent/storage.py
agent/setup.py                                     (supprimé)
agent/src/__init__.py                               (supprimé)
agent/src/config.py                                 (supprimé)
agent/src/crypto.py                                  (supprimé)
agent/src/hardware.py                                (supprimé)
agent/src/main.py                                    (supprimé)
agent/tests/test_agent.py
agent/tests/test_no_dead_src_package.py             (nouveau)
apps/api/src/booking-transaction-retry.ts           (nouveau)
apps/api/src/config.ts
apps/api/src/delivery-store.ts
apps/api/src/delivery-worker.ts
apps/api/src/device-authorization-routes.ts
apps/api/src/job-staleness-sweep.ts                 (nouveau)
apps/api/src/server.ts
apps/api/test/booking-transaction-retry.test.ts     (nouveau)
apps/api/test/bookings-concurrent-error-leak.test.ts (nouveau)
apps/api/test/cleanup-unverified-quarantine.test.ts (nouveau)
apps/api/test/device-authorization-inventory-limits.test.ts (nouveau)
apps/api/test/job-staleness-sweep.test.ts           (nouveau)
apps/api/test/resource-allocation-service.test.ts   (nouveau)
apps/api/test/server-agent-body-signature-wiring.test.ts (nouveau)
apps/api/test/server-payment-unfreeze-registration.test.ts (nouveau)
apps/api/test/server-settlement-routes-registration.test.ts (nouveau)
apps/api/test/workspace-preparation-race-safety.test.ts (nouveau)
apps/host-desktop/package-lock.json
apps/host-desktop/package.json
apps/host-desktop/src-tauri/src/agent_bridge.rs
containers/gpu-diagnostic/Dockerfile
docs/FIRST_REAL_GPU_RENTAL_RESULT.md                (nouveau, mis à jour Phase 6)
docs/SECURITY.md
docs/STATUT_RELEASE.md
netlify.toml
render.yaml
```

Plus, à la clôture de la Phase 6 (non comptés dans le diff ci-dessus, ajoutés après) : `CHANGELOG.md`, `RELEASE_NOTES_RC1.md`, `CHECKLIST_RC1.md`, `RISKS_RC1.md`, `KNOWN_LIMITATIONS_RC1.md`, `RC1_REPORT.md` (ce document) — 6 nouveaux fichiers à la racine.

---

## 12. Checklist de fusion de la PR #44

Voir `CHECKLIST_RC1.md` pour la checklist complète et progressive (fusion / bêta privée / bêta publique / 1.0). Extrait pour la fusion immédiate :

- [x] `git status` propre
- [x] Aucun secret suivi
- [x] Type-check propre
- [x] 183/183 tests API
- [x] 55/55 tests agent
- [x] 7/7 tests `gpu_escrow`
- [x] 440/440 tests `host-desktop`
- [x] `cargo fmt --check` propre
- [x] `cargo clippy -D warnings` propre
- [x] Commits poussés vers `origin`
- [x] **CI GitHub Actions intégralement vert** — confirmé par `gh pr checks 44` (exit code 0), tous les checks `pass` : `rust tests and lint` × 3 plateformes (macOS/Ubuntu/Windows), `frontend typecheck and build`, `production security gate`, `pinned miner provenance`, `api`, `agent`, `contract`, `dependency-audit`, `security-static-analysis`, `Trivy`, `build-scan-publish`, `build-publish-sign`, `Deployment configuration safety`, `Netlify static site`, `Render API container`, `Public release policy`, `Linux x64`, `macOS arm64`, `Windows x64` (installeur, 7m4s), `windows-installer` (6m4s).
- [ ] Revue humaine indépendante (non applicable — session solo)
- [ ] **Autorisation explicite de fusion de l'utilisateur** — non donnée

**Verdict : aucun obstacle technique restant. DO NOT MERGE tant que l'utilisateur n'a pas explicitement autorisé la fusion.**

---

## 13. Estimation de préparation

**Bêta privée (accès restreint, hôtes/locataires de confiance) : ~80%.** Manque : ordonnanceur de sweep en production (R2), superviseur du Delivery Worker (R1), un cycle de paiement réel de bout en bout hors bypass dev.

**Version 1.0 : ~37%.** Manque, en plus de ce qui précède : validation de `GPU_PROOF`/`WORKSPACE_PREPARE` en conditions réelles, test sur deux machines physiques distinctes, validation croisée matérielle (Linux natif, autre GPU), test de charge, verrou d'exclusivité GPU si un job de calcul exclusif est introduit (R3).

Ces deux pourcentages sont des estimations qualitatives basées sur la liste de contrôle `CHECKLIST_RC1.md`, pas une mesure formelle.
