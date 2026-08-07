# GPUbnb — Checklist de lancement bêta privée

À cocher par un humain avant d'inviter le premier hôte/locataire externe réel. Chaque case renvoie au document qui en apporte la preuve. Ne pas cocher une case sans la preuve correspondante réellement produite.

## Code et tests

- [ ] `apps/api` : suite complète verte (`npm test` dans `apps/api`) — dernier chiffre connu : voir le rapport de fin de tâche.
- [ ] `agent` : suite complète verte (`python -m unittest discover -s tests`) — dernier chiffre connu : voir le rapport de fin de tâche.
- [ ] `apps/host-desktop` : `cargo test --locked -p gpubnb-host-desktop --all-targets`, `cargo fmt -- --check`, `cargo clippy -- -D warnings` — tous verts.
- [ ] `programs/gpu_escrow` : `cargo test` — vert (tests unitaires purs uniquement, programme non déployé).
- [ ] CI verte sur le dernier commit de la branche à fusionner (`gh run list --branch feat/beta-readiness-hardening`).
- [ ] Aucun `TODO`/`FIXME`/`HACK` dans le code de production touché par cette branche.
- [ ] Aucun `console.log`/`print` de debug oublié dans le code de production touché par cette branche.
- [ ] Aucun secret en clair dans le diff (`.gitleaks.toml` présent, revue manuelle du diff exact avec `main` effectuée).

## Priorités techniques (cette branche)

- [ ] Priorité 1 — instance unique de l'agent : commit `0b8ff74`, tests réels (verrou OS, pas de mock).
- [ ] Priorité 2 — reprise contrôlée du Delivery Worker : commit `85a0e15`, 11 tests.
- [ ] Priorité 3 — ordonnanceur du sweep : commit `3deaefb`, 21 tests (Redis réel).
- [ ] Priorité 4 — exclusivité GPU : commit `513f1c7`, 15 tests.

## Documentation

- [ ] `BETA_PRIVATE_READINESS.md` à jour, verdict final renseigné.
- [ ] `BETA_PRIVATE_TEST_PLAN.md` — protocole deux machines relu par une deuxième personne avant exécution.
- [ ] `BETA_PRIVATE_INSTALLATION.md` — vérifié contre le code réel (commandes testées, pas recopiées d'une version antérieure).
- [ ] `BETA_PRIVATE_OPERATIONS.md` — les trois processus (API, Delivery Worker, Sweep Scheduler) confirmés comme démarrant réellement dans l'environnement de déploiement cible.
- [ ] `BETA_PRIVATE_ROLLBACK.md` — procédure lue et comprise par au moins deux personnes de l'équipe avant ouverture.

## Validation multi-machines (Partie 1 de `BETA_PRIVATE_TEST_PLAN.md`) — AUCUNE case ne doit être cochée sans exécution réelle

- [ ] Étape A — diagnostic GPU réel sur PC A.
- [ ] Étape B — liaison via code temporaire depuis PC B.
- [ ] Étape C — heartbeat à travers un réseau réel, machine détectée hors-ligne automatiquement par le Sweep Scheduler après coupure.
- [ ] Étape D — `GPU_DIAGNOSTIC`, `WORKSPACE_PREPARE`, `GPU_PROOF` exécutés de bout en bout entre les deux machines.
- [ ] Étape E — exclusivité GPU observée entre deux machines partageant un `gpuUuid` de test.
- [ ] Étape F — arrêt/redémarrage propre de l'agent sur une machine physique différente de celle de développement.
- [ ] `apps/host-desktop` utilisé comme rôle hôte réel au moins une fois (pas seulement la CLI Python).

## Paiement (voir `BETA_PRIVATE_READINESS.md` section 2)

- [ ] Décision explicite prise et documentée : la bêta privée démarre-t-elle avec `DEV_PAYMENT_BYPASS=true` (aucun argent, même Devnet) ou avec un déploiement Devnet réel du programme `gpu_escrow` ?
- [ ] Si Devnet réel choisi : programme déployé, `Anchor.toml`/`ESCROW_PROGRAM_ID` mis à jour, `anchor test` rejoué contre le déploiement réel.
- [ ] Si Devnet réel choisi : lacune de vérification on-chain du règlement (`confirmSettlement`, section 2.2 de `BETA_PRIVATE_READINESS.md`) explicitement acceptée par un humain désigné, ou comblée avant ouverture.

## Exploitation

- [ ] Agrégation des logs JSON des trois processus en place (voir `BETA_PRIVATE_OPERATIONS.md` section 7).
- [ ] Procédure de levée de quarantaine manuelle testée au moins une fois par l'opérateur qui l'exécutera en bêta.
- [ ] Stratégie de sauvegarde/restauration de la base de données définie (hors périmètre de cette branche, à faire avant ouverture).

## Décision finale

- [ ] Verdict `BETA_PRIVATE_READINESS.md` = `READY FOR PRIVATE BETA`.
- [ ] Autorisation explicite donnée par le porteur du produit pour ouvrir la bêta au premier utilisateur externe réel.
