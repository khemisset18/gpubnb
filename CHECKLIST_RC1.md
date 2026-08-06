# Checklist RC1

Cases cochées uniquement sur preuve vérifiée dans cette campagne (voir le rapport RC1 pour le détail de chaque preuve).

## Avant fusion de la PR #44 vers `main`

- [x] `git status` propre (aucun fichier non suivi, aucune modification non commitée).
- [x] Aucun secret, `.env`, artefact temporaire suivi par git.
- [x] Le commit `3c04db2` (normalisation de fins de ligne) est vérifié sans changement fonctionnel.
- [x] Type-check TypeScript propre (`tsc --noEmit`, `apps/api`).
- [x] Suite de tests `apps/api` : 183/183 verts.
- [x] Suite de tests agent Python : 54/54 verts (1 skip attendu, contrat non-Windows).
- [x] Suite de tests `programs/gpu_escrow` (Rust) : 7/7 verts.
- [x] Suite de tests `apps/host-desktop` (Rust) : 440/440 verts.
- [x] `cargo fmt --check` (host-desktop) : propre (corrigé pendant la vérification finale, `ad3f5ea`).
- [x] `cargo clippy -- -D warnings` (host-desktop) : propre.
- [x] Commits poussés vers `origin/feature/first-gpu-rental`.
- [x] **CI GitHub Actions vert sur le SHA final `ad3f5ea9a523dde09bca995aa1edc328fce42f2d`** — confirmé (`gh pr checks 44`, exit code 0, tous les checks `pass`, y compris les deux builds d'installeur `host-desktop` initialement lents). Déclenché manuellement (`gh workflow run host-desktop`) suite à une anomalie de déclenchement webhook déjà observée dans cette campagne ; le déclenchement automatique par le push a fini par arriver aussi.
- [x] Aucun conteneur Docker résiduel (`gpubnb-diagnostic-*`) sur la machine de test.
- [x] Aucun processus agent dupliqué au moment de la clôture.
- [x] Machine de test GPU dans un état terminal sain (`AVAILABLE`).
- [ ] Revue humaine de la PR #44 par une personne autre que l'auteur des commits (non applicable dans le cadre de cette session solo — à faire avant fusion réelle).
- [ ] **Décision explicite de l'utilisateur de fusionner** — non donnée à ce stade ; ce document ne constitue pas une autorisation de fusion.

## Avant bêta privée (accès restreint, quelques hôtes/locataires de confiance)

- [x] Au moins une location GPU réelle de bout en bout réussie (10+ dans cette campagne).
- [x] Tests de robustesse de base exécutés (10/10 scénarios Phase 5, voir rapport pour le détail par scénario).
- [ ] Tâche planifiée pour `/internal/sweep-offline` configurée en production (R2, `RISKS_RC1.md`) — aucun ordonnanceur n'existe dans ce dépôt.
- [ ] Superviseur de processus pour le Delivery Worker en production (R1, `RISKS_RC1.md`).
- [ ] Flux de paiement réel (escrow Solana) exercé au moins une fois de bout en bout, hors bypass dev.
- [ ] Test avec hôte et locataire sur deux machines physiques distinctes.

## Avant bêta publique

- [ ] Tout ce qui précède la bêta privée, confirmé stable sur plusieurs semaines.
- [ ] Au moins un type de job réel supplémentaire validé (`GPU_PROOF` en conditions réelles).
- [ ] Verrou d'exclusivité GPU côté agent si un job de calcul soutenu est introduit (R3, `RISKS_RC1.md`).
- [ ] Validation croisée sur au moins une configuration matérielle Linux native.
- [ ] Test de charge (réservations concurrentes à l'échelle, pas seulement 2 simultanées).

## Avant 1.0

- [ ] Tout ce qui précède, en production depuis une durée significative sans incident non résolu.
- [ ] Couverture complète du Test 2 (timeout de workload) en conditions bout-en-bout réelles, avec un environnement de test adapté (R5, `RISKS_RC1.md`).
- [ ] Espace de travail interactif (`WORKSPACE_PREPARE`) validé en conditions réelles.
