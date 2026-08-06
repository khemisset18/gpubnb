# Résultat — Première location GPU réelle

## Date et heure

2026-08-06, 02:34–03:54 UTC. Exécution locale complète, hôte et locataire joués par la même personne sur la même machine physique, avec deux comptes distincts (wallets Solana générés localement, authentification par signature).

## Machine et GPU

- OS : Windows 10 (build 10.0.26200), Docker Desktop 29.6.2, backend WSL2.
- GPU : NVIDIA GeForce GTX 1650, 4096 MiB VRAM, pilote 592.82, CUDA 13.1.
- Machine GPUbnb : `cmsgx4s6v0005icx0ffkrjsrh`.

## Résultat de référence (run propre, zéro erreur)

- **Booking ID** : `cmsgzduna0023icvkb5nwm32g`
- **Job ID** : `cmsgzdv3u0003iccce5j2a4k9` (type `GPU_DIAGNOSTIC`)
- **Image diagnostic** : `ghcr.io/khemisset18/gpu-diagnostic@sha256:6c31bbf29c9a11a45ec88e3cd7ff34929c0b9aa6125ce591cbfbfa663303c748`
- Résultat du job : `gpuDetected: true`, `containerCleaned: true`, `firstGpuName: "NVIDIA GeForce GTX 1650"`, `firstGpuTemperatureC: 77`, `exitCode: 0`.

Un premier run réussi antérieur existe aussi (`cmsgz3mj60017icvk7aj7slji` / job `cmsgz3n9z0007ic2o5qnegbky`), avant la correction du dernier bug (voir plus bas). Le run de référence ci-dessus est celui retenu car entièrement exempt d'erreur HTTP sur toute sa fenêtre d'exécution.

## États traversés

**Booking** : `AWAITING_DEPOSIT` → `FUNDED` (bypass paiement dev, voir Limites) → `STARTING` → `COMPLETED`.

**Job** : `QUEUED` → `ASSIGNED` → `PREPARING` → `RUNNING` → `UPLOADING_RESULTS` → `COMPLETED`.

**Machine** : `connectivity` `OFFLINE` → `ONLINE` ; `operational` `UNAVAILABLE` → `AVAILABLE` → `RESERVED` (pendant le job) → `AVAILABLE`.

## Résultats des tests (au moment de ce run — voir RC1_REPORT.md pour les chiffres à la clôture de la campagne)

- `apps/api` : `npm test` → **149/149 verts**, 0 échec.
- `agent` : `python -m unittest discover -s agent/tests` → **50/50 verts** (1 `skipped`, test de contrat spécifique non-Windows, attendu sur cette plateforme).

> **Mise à jour post-Phase 5/6 (RC1) :** cette campagne s'est poursuivie par une Phase de tests de robustesse (10 scénarios de chaos réel/mocké) puis une clôture RC1. À la clôture, les suites de tests comptent **183/183** (`apps/api`), **55/55** (`agent`, 1 skip attendu), **440/440** (`apps/host-desktop`, Rust) et **7/7** (`programs/gpu_escrow`, Rust). Le détail complet — bugs supplémentaires trouvés et corrigés, résultats de robustesse, verdict de fusion — est dans `RC1_REPORT.md`, `CHANGELOG.md` et `RISKS_RC1.md` à la racine du dépôt.

## Bugs réels trouvés et corrigés

Tous découverts en exécutant le parcours réel de bout en bout — aucun n'était visible avant.

1. **`b63b158`** — Le Delivery Worker plantait au démarrage : Prisma envoie les entiers JS en `bigint`, incompatible avec la signature `integer` des fonctions SQL `claim_outbox_events`/`claim_machine_commands`. Corrigé par un cast explicite `::integer`.
2. **`e0fda0e`** — Le heartbeat de l'agent échouait pour absolument toute machine hôte : le serveur recalculait le hash de signature via `JSON.stringify(req.body)` après `JSON.parse`, ce qui perd le `.0` des flottants Python (`77.0` → `77`), cassant la signature v2. Corrigé en utilisant les octets bruts déjà capturés (`request.rawBody`).
3. **`c77fd71`** — L'image Docker officielle `gpu-diagnostic` échouait systématiquement (`nvml_library_unavailable`) : le dossier de montage attendu par l'injecteur GPU de Docker Desktop n'existait pas dans l'image `scratch`, et la bibliothèque NVML elle-même dépend de bibliothèques glibc absentes de l'image minimale. Corrigé, republié via le workflow CI officiel (nouveau digest signé cosign).
4. **`d8b0d33`** — Trois bugs en cascade empêchaient la complétion d'un job : (a) l'agent envoyait un tableau imbriqué dans `result.metrics`, rejeté par le schéma serveur qui n'accepte que des scalaires ; (b) le message d'erreur résultant dépassait la largeur de la colonne DB `preparationStep` (VarChar(80) vs jusqu'à 100 caractères validés en entrée) ; (c) les tentatives de réessai de l'agent réutilisaient une signature déjà consommée, rejetée comme rejeu.
5. **`b419998`** — Une fois un booking résolu en `DEGRADED`, la boucle de réconciliation du Delivery Worker le retraitait indéfiniment (toutes les 250 ms) et écrasait le statut `operational` de la machine, empêchant tout retour à `AVAILABLE` même après une location réussie ultérieure sur la même machine.

`3c04db2` — commit de normalisation des fins de ligne du fichier `runner.py` (héritage de `main`, sans changement fonctionnel), séparé pour garder les diffs fonctionnels lisibles.

## Commits concernés (branche `feature/first-gpu-rental`)

```
3c04db2 chore(agent): normalize runner.py to LF line endings
b419998 fix(api): stop delivery worker from re-degrading machines forever
d8b0d33 fix(agent,api): fix job-completion contract mismatch and signature reuse on retry
c77fd71 fix(gpu-diagnostic): fix NVML injection in the scratch runtime image
e0fda0e fix(api): verify heartbeat v2 signature against raw request bytes
b63b158 fix(api): cast delivery-store claim RPC params to integer
```

## Preuve du nettoyage

- `docker ps -a --filter "name=gpubnb-diagnostic-"` : vide (aucun conteneur résiduel) après le run de référence.
- `result.metrics.containerCleaned: true` renvoyé par le job lui-même.
- Fenêtre HTTP complète du run de référence (création du booking → job `COMPLETED`) : **17 requêtes à 200, 1 à 204** (poll de job vide, normal), **0 requête ≥ 400, 0 heartbeat 401**.
- Trois services (API, Delivery Worker, agent) arrêtés proprement en fin de session ; aucun processus `node.exe`/`python.exe` résiduel ; Postgres/Redis toujours sains.

## Procédure exacte pour reproduire

Suivre le runbook officiel `docs/FIRST_GPU_RENTAL_E2E.md`, avec les précisions suivantes utilisées pour cette exécution :

1. Démarrer Docker Desktop. Valider le passthrough GPU : `docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi`.
2. `docker compose up -d postgres redis`.
3. Dans `apps/api/.env` : `DEV_PAYMENT_BYPASS=true`, `DEV_DIAGNOSTIC_IMAGE=ghcr.io/khemisset18/gpu-diagnostic@sha256:6c31bbf29c9a11a45ec88e3cd7ff34929c0b9aa6125ce591cbfbfa663303c748` (digest reconstruit après le correctif `c77fd71` — récupérer le digest courant via l'artefact `gpu-diagnostic-image-evidence` du workflow `gpu-diagnostic-image`).
4. `cd apps/api && npm ci && npx prisma generate && npx prisma migrate deploy`, puis `npm run dev` et `npm run dev:delivery` dans deux terminaux.
5. Installer l'agent (`pip install -e agent`), `gpubnb-agent setup --api-url http://localhost:8787 --diagnostic-image <digest>`.
6. Créer les deux comptes (host, renter) : soit via Phantom dans `apps/web`, soit — comme fait ici — par appel direct à `/auth/nonce` puis `/auth/verify` avec une paire de clés Solana générée localement (`@solana/web3.js` + `tweetnacl`), cryptographiquement équivalent à ce que fait Phantom.
7. Compléter le profil host (`PUT /profile`, `canHost:true`), générer un code de liaison (`POST /machines/link-code`), lier la machine (`gpubnb-agent link <code>`), démarrer l'agent (`gpubnb-agent start`).
8. Une fois la machine `ONLINE` et vérifiée, publier une annonce (`POST /listings`).
9. Compléter le profil renter (`canRent:true`), créer une réservation démarrant dans moins de 5 minutes (`POST /bookings`).
10. Le Delivery Worker bascule automatiquement `AWAITING_DEPOSIT → FUNDED → STARTING` et crée le job `GPU_DIAGNOSTIC` ; l'agent le réclame et l'exécute.
11. Vérifier : booking `COMPLETED`, job `COMPLETED`, `gpuDetected:true`, aucun conteneur résiduel, machine `AVAILABLE`.

## Limites du test — à connaître avant toute bêta publique

- **Bypass de paiement activé (`DEV_PAYMENT_BYPASS=true`)** : aucune transaction Solana réelle, aucun escrow déployé, aucun argent réel n'a été déplacé. L'API refuse de démarrer avec ce flag si `NODE_ENV=production` (garde-fou de code existant), mais le parcours de financement réel (déploiement devnet/mainnet du programme `gpu_escrow`, signature Phantom, vérification on-chain) n'a pas été testé ici.
- Un seul type de job testé : `GPU_DIAGNOSTIC` (sonde GPU isolée). Le parcours `GPU_PROOF` (charge CUDA réelle, plus proche d'un vrai usage locatif) et l'espace de travail interactif complet (`WORKSPACE_PREPARE`, code-server) n'ont pas été validés dans cette session.
- Une seule configuration hôte testée : Windows 11 + Docker Desktop (backend WSL2) + GTX 1650. Le correctif de l'image `gpu-diagnostic` (bug 3 ci-dessus) est motivé par un raisonnement valable aussi sur Linux natif avec le NVIDIA Container Toolkit standard, mais cela n'a pas été vérifié indépendamment sur une machine Linux.
- Hôte et locataire sur la même machine physique : le test ne couvre pas la latence réseau, le NAT, ni deux machines réellement distinctes (contrairement à ce que recommande le runbook officiel — « scénario testé sur deux machines distinctes »).
- Un booking issu du débogage intermédiaire (`cmsgyhpzy0005icmw9v78r5y7`) reste orphelin en base (`STARTING`, job bloqué en `UPLOADING_RESULTS`) : sans conséquence sur les réservations suivantes (bug 5 corrigé), mais aucun mécanisme de purge des jobs bloqués n'existe — hors périmètre de cette session (aucune nouvelle fonctionnalité ajoutée). **Résolu depuis :** la Phase 5 (tests de robustesse, Test 8) a mis en évidence ce même gap sous une forme plus grave (un job peut rester bloqué indéfiniment même après le rétablissement complet de l'agent) et l'a corrigé (`2d1acf7`, `sweepStaleJobs`, voir `CHANGELOG.md`).
- `apps/host-desktop` (application Tauri) n'a pas été utilisée ; le rôle hôte repose entièrement sur l'agent CLI Python, seul composant du dépôt déjà fonctionnel pour ce rôle.
