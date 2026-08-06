# GPUbnb — Release Candidate 1 (RC1)

**Branche :** `feature/first-gpu-rental` · **PR :** [#44](https://github.com/khemisset18/gpubnb/pull/44) (draft, non fusionnée) · **SHA final :** `ad3f5ea9a523dde09bca995aa1edc328fce42f2d`

## Ce que RC1 valide

Cette campagne part d'un objectif unique — faire réussir une première location GPU réelle de bout en bout — et l'étend en un cycle complet de durcissement avant bêta :

1. **Une location GPU réelle** exécutée intégralement sur du matériel physique (hôte et locataire, GTX 1650, Windows 11 + Docker Desktop), pas un environnement simulé.
2. **18 défauts CRITIQUE/IMPORTANT** identifiés par audit multi-agent, corrigés un par un avec test de régression et commit isolé.
3. **10 réservations GPU réelles consécutives** (Phase 4), avec surveillance thermique continue, zéro dépassement de seuil, zéro conteneur résiduel.
4. **10 scénarios de robustesse** (Phase 5) exécutés en conditions réelles autant que possible (coupure API, coupure Docker, arrêt/redémarrage d'agent, requêtes forgées signées, réservations concurrentes) — 3 défauts réels supplémentaires trouvés et corrigés en cours de route.
5. **Un défaut bloquant le CI** trouvé et corrigé lors de la vérification finale.

## Nouveautés / changements notables pour un opérateur

- **Le Delivery Worker est maintenant déployable** comme service indépendant (`render.yaml`) — il ne l'était pas avant cette campagne.
- **La route interne `/internal/sweep-offline`** couvre désormais deux mécanismes de réconciliation : machines hors-ligne (existant) et jobs bloqués indépendamment de la santé de la machine (nouveau, `JOB_STALE_AFTER_SECONDS`, défaut 900s). **Cette route doit être appelée périodiquement par une tâche planifiée en production — aucun ordonnanceur n'est inclus dans ce dépôt.**
- **Un job dont le nettoyage de conteneur GPU ne peut pas être confirmé met désormais la machine en quarantaine** (`moderationStatus`), bloquant tout nouveau heartbeat jusqu'à vérification manuelle — avant RC1, la machine redevenait disponible silencieusement.
- **`POST /bookings` réessaie automatiquement** (borné, avec jitter) les échecs de transaction transitoires sous forte contention, et ne renvoie plus jamais de message d'erreur interne brut au client.

## Ce que RC1 NE valide PAS

Voir `KNOWN_LIMITATIONS_RC1.md` et `RISKS_RC1.md` pour le détail complet. En résumé :
- Aucun paiement réel (`DEV_PAYMENT_BYPASS=true` sur toute la campagne) — le flux d'escrow Solana réel n'a jamais été exercé de bout en bout.
- Un seul type de job testé en conditions réelles (`GPU_DIAGNOSTIC`) ; `GPU_PROOF` et l'espace de travail interactif (`WORKSPACE_PREPARE`) ne le sont pas.
- Hôte et locataire sur la même machine physique tout du long — aucune latence réseau, NAT, ou séparation physique réelle testée.
- Une seule configuration matérielle (Windows 11 + Docker Desktop WSL2 + GTX 1650).
- Le Test 2 de robustesse (timeout de workload) n'a pas reproduit de timeout naturel en environnement réel (limite structurelle de l'environnement de test, pas un défaut de code) ; le chemin de production a ensuite été validé de manière déterministe en exerçant directement le code réel de l'agent, sans modification du code de production — voir `RISKS_RC1.md` pour le détail.

## Verdict

Voir le rapport RC1 complet pour le détail des preuves ; verdict de fusion et pourcentages de préparation bêta/1.0 fournis séparément dans ce même rapport.
