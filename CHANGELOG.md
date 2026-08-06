# Changelog

Toutes les entrées de ce fichier concernent la campagne RC1 menée sur la branche `feature/first-gpu-rental` (PR #44), du premier commit du parcours GPU réel jusqu'à la clôture de la Phase 5 (tests de robustesse). Format inspiré de [Keep a Changelog](https://keepachangelog.com/), horodatage UTC, un item = un commit réel.

## [RC1] — 2026-08-07

### Corrigé — trouvés en exécutant le parcours réel de bout en bout (première location GPU)

- **`b63b158`** — Le Delivery Worker plantait au démarrage : Prisma envoie les entiers JS en `bigint`, incompatible avec la signature `integer` des fonctions SQL `claim_outbox_events`/`claim_machine_commands`. Cast explicite `::integer` ajouté.
- **`e0fda0e`** — Le heartbeat de l'agent échouait pour toute machine hôte : le serveur recalculait le hash de signature via `JSON.stringify(req.body)` après `JSON.parse`, perdant le `.0` des flottants Python (`77.0` → `77`), cassant la signature v2. Corrigé en signant les octets bruts déjà capturés (`request.rawBody`).
- **`c77fd71`** — L'image Docker officielle `gpu-diagnostic` échouait systématiquement (`nvml_library_unavailable`) : dossier de montage GPU absent de l'image `scratch`, dépendances glibc manquantes pour NVML. Image reconstruite et republiée (nouveau digest signé cosign).
- **`d8b0d33`** — Trois bugs en cascade empêchaient la complétion d'un job : tableau imbriqué rejeté par le schéma serveur, message d'erreur dépassant la largeur de colonne `preparationStep` (VarChar(80)), et réutilisation de signature déjà consommée lors des réessais de l'agent.
- **`b419998`** — Une fois un booking `DEGRADED`, la boucle de réconciliation du Delivery Worker le retraitait indéfiniment (250 ms) et écrasait le statut `operational` de la machine, bloquant tout retour à `AVAILABLE`.

### Corrigé — audit CRITIQUE (C1–C11, C18)

- **`1c29a23` (C1)** — Route de finalisation de règlement (settlement) rendue joignable.
- **`8a9b9dc` (C2)** — Allocation de ressources câblée dans la création de réservation (empêche le double-provisionnement d'un même GPU).
- **`babd031` (C3)** — Delivery Worker déployé comme service Render indépendant (jusque-là absent de l'infrastructure de déploiement).
- **`618fb44` (C4)** — Signature V2 liée au corps de requête exigée sur chaque écriture agent (empêche la falsification en transit d'un rapport de job).
- **`5acf69c` (C5)** — Limites d'inventaire GPU du pairing d'appareil alignées sur la largeur réelle des colonnes DB.
- **`84af3e8` (C6)** — Ajout d'un chemin de résolution manuelle pour les paiements gelés.
- **`d57d5e3` (C7)** — Fermeture d'une course sur la préparation d'espace de travail et d'une fuite de message d'erreur Prisma brut.
- **`3c509c2` (C9)** — Correction définitive de la réutilisation de signature sur retry de heartbeat.
- **`129fddd` (C10)** — Clé de l'agent (`agent.key`) restreinte au propriétaire via ACL Windows.
- **`5fd89a7` (C11)** — Signature des téléversements d'artefacts.
- **`ace1b19` (C18)** — Suppression du paquet dupliqué `agent/src`, mort et cassé (import vers un module inexistant).

### Corrigé — hors périmètre agent/API

- **`e28dcc2` (C8)** — Autorisation du script CDN Supabase dans la CSP déployée.
- **`8c7b6a7`** — Correctifs de sécurité `postcss`/`vite` (host-desktop).
- **`1d9f182`** — Arrêt de l'émission de fichiers `.js` parasites par `tsc` à côté des sources (host-desktop).

### Corrigé — Phase 5, tests de robustesse (trouvés et corrigés en conditions réelles, preuve live à chaque fois)

- **`9f3f03e`** — `POST /bookings` exposait le message d'erreur interne brut de Prisma au client sous forte contention concurrente au lieu de `time_slot_unavailable` ; ajout d'un retry borné (3 tentatives, backoff avec jitter) réservé aux erreurs de transaction transitoires (Prisma `P2034`/`P2028`), jamais aux erreurs métier.
- **`2d1acf7`** — Aucune détection de staleness au niveau job : un job resté bloqué suite à une coupure API pouvait ne jamais atteindre d'état terminal même après le rétablissement complet de l'agent/machine. Ajout de `sweepStaleJobs`, indépendant du heartbeat machine.
- **`d4b1698`** — Un rapport agent honnête de nettoyage de conteneur non vérifié (`diagnostic_cleanup_unverified`/`gpu_proof_cleanup_unverified`) n'empêchait pas le heartbeat suivant de remettre la machine `AVAILABLE`. La machine est désormais mise en quarantaine (`moderationStatus`), bloquant tout heartbeat ultérieur jusqu'à levée administrative contrôlée.

### Ajouté — validation déterministe et régression pour le Test 2 (timeout de workload)

- **`agent/tests/test_agent.py::test_diagnostic_container_hang_is_reported_as_a_timeout`** — trois tentatives de reproduction en environnement réel (pause du conteneur Docker, blocage réseau sur une IP unique, blocage réseau sur une plage CIDR entière) n'ont pas permis de reproduire un timeout naturel, pour des raisons propres à l'environnement de test (workload officiel s'exécutant en moins d'une seconde, rotation d'IP côté GitHub, rejet instantané du pare-feu Windows) et non à cause d'un défaut du code. Le chemin de production du timeout (`run_gpu_diagnostic()` → `subprocess.run(timeout=...)`, `runner.py`) a ensuite été validé de manière déterministe en exerçant directement le code réel de l'agent, sans modification du code de production, via substitution temporaire du binaire `docker` sur `PATH` (n'interceptant que `docker run`, laissant les autres commandes Docker s'exécuter contre le démon réel). Résultat reproductible (deux exécutions, `RuntimeError('diagnostic_timeout')` après ~34s, zéro conteneur résiduel). Une régression automatisée garantit désormais ce comportement.

### Corrigé — vérification finale (bloquant CI, sans changement fonctionnel)

- **`ad3f5ea`** — Violation `rustfmt` faisant échouer le job CI « rust tests and lint » sur les trois plateformes (macOS/Ubuntu/Windows) dès l'étape `cargo fmt --check`, avant même l'exécution des tests.

### Documentation

- **`2dc1a91`** — Documentation du résultat de la première location GPU réelle de bout en bout.
- **`ee47ebf` (C12–C16)** — Corrections des lacunes de configuration du README, du statut obsolète, et des divergences de la documentation de sécurité.

### Maintenance

- **`3c04db2`** — Normalisation des fins de ligne de `runner.py` (héritage de `main`, sans changement fonctionnel).
- **`bb1b2c3`** — Ajout de `apps/api/data/` au `.gitignore` (répertoire de stockage local d'artefacts).
