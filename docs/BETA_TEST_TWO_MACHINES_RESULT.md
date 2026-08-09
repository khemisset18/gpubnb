# Résultat — Bêta test de location GPU (annonce "deux machines")

## Date et heure

2026-08-09, ~01:53–01:55 UTC. Hôte réel (PC A, GPU physique) et compte locataire distinct (même buyer utilisé sur toute la campagne de test), réservation passée via le site en ligne (gpubnb.netlify.app / API `gpubnb.onrender.com`).

## Machine et GPU

- OS : Windows 11 Home (build 10.0.26200), Docker Desktop, backend WSL2.
- GPU : NVIDIA GeForce GTX 1650, 4096 MiB VRAM, pilote 592.82, CUDA 13.1.
- Machine GPUbnb (hôte) : `cmsiggruy0004df0tn669f6bn`.
- Annonce : `cmskhoviy0047dx0uuv7am07o` — "GTX 1650 - Test bêta deux machines".

## Résultat de référence (run propre)

- **Booking ID** : `cmsl5eyqy000ujp1b6gfghjyg`
- **Job ID** : `cmsl5f3ug0010jp1bnlnz63pc` (type `GPU_DIAGNOSTIC`)
- Résultat du job : `gpuDetected: true`, `containerCleaned: true`, `imageCacheHit: true`, `firstGpuName: "NVIDIA GeForce GTX 1650"`, `firstGpuTemperatureC: 92`, `firstGpuMemoryUsedMiB: 161`.

## États traversés

**Booking** : `AWAITING_DEPOSIT` → `FUNDED` (bypass paiement bêta, voir Limites) → `STARTING` → `COMPLETED`.

**Job** : `QUEUED` → `RUNNING` → `COMPLETED` (~1min38 entre création et fin).

**Machine** : `connectivity` `ONLINE` en continu sur ce run ; `operational` `AVAILABLE` → `RESERVED` (pendant le job) → `AVAILABLE`.

## Bugs réels trouvés et corrigés pendant cette campagne

Cinq bugs distincts empêchaient ce résultat, découverts uniquement en essayant le parcours réel de bout en bout depuis un PC fraîchement redémarré :

1. **Docker introuvable par l'agent** — l'agent tournait comme service Windows (`GPUbnbAgent`), dont le compte de service n'a pas Docker Desktop dans son `PATH` (installation par-utilisateur). Chaque heartbeat remontait donc `dockerAvailable:false`/`nvidiaRuntimeAvailable:false` côté serveur, quel que soit l'état réel de la machine. **Corrigé** en abandonnant le service Windows : après un redémarrage complet du PC, l'agent tourne comme process en arrière-plan classique (`gpubnb-agent start --daemon`) sous le compte interactif de l'utilisateur, qui a bien Docker dans son `PATH`.

2. **`stale_heartbeat` (HTTP 409) systématique en mode `--daemon`** — le process détaché (`DETACHED_PROCESS`, sans console) est nettement plus lent pour les appels système shellés (`nvidia-smi`, `docker`, `wmic`) que le même code lancé dans une console attachée, très probablement à cause du coût d'allocation de console Windows pour chaque sous-processus enfant. Comme l'horodatage signé du heartbeat était capturé *avant* ces sondes (voir bug 3 ci-dessous pour la vraie correction), il dépassait régulièrement la fenêtre de validité serveur (`HEARTBEAT_MAX_AGE_SECONDS`, 25s par défaut). **Contournement appliqué** : `HEARTBEAT_MAX_AGE_SECONDS` remonté à 120 (maximum autorisé par le schéma) sur le service Render `gpubnb`.

3. **Installation locale de l'agent pointant vers une copie obsolète du code** — `pip install -e` avait été fait depuis un dossier `Documents\Codex\...` non synchronisé avec `agent/` du dépôt principal. Cette copie obsolète contenait deux bugs déjà corrigés dans le dépôt : (a) elle capturait l'horodatage du heartbeat *avant* de collecter l'inventaire matériel (lent), au lieu d'après — cause racine réelle du bug 2 ; (b) le résultat du diagnostic GPU incluait un tableau imbriqué (`result.metrics.gpus`) que le schéma serveur (`z.record` de scalaires uniquement) rejette avec `HTTP 400 invalid_request`, faisant systématiquement échouer le job et dégrader la réservation. **Corrigé** en réinstallant l'agent (`pip install -e agent`) depuis le bon chemin (`C:\Users\hicha\gpubnb\agent`).

4. **`HEARTBEAT_OFFLINE_SECONDS` trop court (40s)** — le balayage périodique de détection "hors-ligne" (qui tourne maintenant en in-process sur le service web, faute de pouvoir héberger le worker dédié sur le plan gratuit Render) déclenchait un faux positif dès qu'un cycle de heartbeat de l'agent Windows était un peu plus lent que d'habitude, annulant automatiquement (`AGENT_OFFLINE`) le job fraîchement créé avant même que l'agent ait pu le récupérer. Deux réservations consécutives ont été dégradées de cette façon. **Corrigé** en remontant `HEARTBEAT_OFFLINE_SECONDS` à 300 (maximum autorisé).

5. **(Contexte, déjà documenté)** Le plan gratuit Render ne peut pas héberger les Background Workers `gpubnb-delivery-worker`/`gpubnb-sweep-scheduler` définis dans `render.yaml` — la réconciliation des réservations bêta et le balayage hors-ligne tournent donc en in-process sur le service web (`BETA_TEST_DEV_BYPASS`, commit `253a31e`, déjà en prod avant cette session).

## Commits / changements de cette session

- Réinstallation locale de l'agent (`pip install -e agent`) depuis le bon chemin — pas de changement de code, correction d'un environnement local désynchronisé.
- Ajout de `*.egg-info/` à `.gitignore`.
- Configuration serveur (Render, dashboard, pas de commit) : `HEARTBEAT_MAX_AGE_SECONDS` 25→120, `HEARTBEAT_OFFLINE_SECONDS` 40→300.

## Limites du test — à connaître avant toute bêta publique

- **Bypass de paiement bêta activé (`BETA_TEST_DEV_BYPASS=true`)** : aucune transaction Solana réelle, aucun escrow déployé (`ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET`). Ce flag devient un no-op dès qu'un vrai programme d'escrow est configuré (garde-fou déjà en place, voir `dev-booking-reconciler.ts`).
- Les deux contournements serveur (`HEARTBEAT_MAX_AGE_SECONDS=120`, `HEARTBEAT_OFFLINE_SECONDS=300`) masquent un vrai problème de lenteur du mode `--daemon` de l'agent sur Windows (bug 2/3) plutôt que de le résoudre à la racine. Une vraie correction (regrouper l'allocation de console, ou éviter `DETACHED_PROCESS`) reste à faire côté agent si celui-ci doit être distribué à des hôtes tiers sur Windows.
- Un seul type de job testé : `GPU_DIAGNOSTIC`. `GPU_PROOF` et l'espace de travail interactif (`WORKSPACE_PREPARE`) n'ont pas été validés dans cette session.
- Plusieurs réservations de test antérieures sur cette même annonce sont restées en `DEGRADED`/`CANCELLED` en base (ids `cmsl42lnj...`, `cmsl2hj6l...`, `cmsl1k5al...`, `cmsl0wo2y...`, `cmskxdmj3...`, `cmskx44y3...`, `cmskikhr5...`, `cmskid3pz...`, `cmskhq1kx...`) — sans conséquence sur le run de référence retenu, mais à garder en tête si on interroge l'historique de cette annonce.
