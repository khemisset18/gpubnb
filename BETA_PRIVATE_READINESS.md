# GPUbnb — Préparation bêta privée (branche `feat/beta-readiness-hardening`)

Ce document synthétise l'état de préparation de GPUbnb pour une **bêta privée** : un nombre restreint d'hôtes et de locataires réels, sous supervision active, **sans argent réel** (Devnet et/ou `DEV_PAYMENT_BYPASS`, voir Priorité 6 ci-dessous). Il ne couvre pas une bêta publique ni un déploiement Mainnet — ces étapes restent gouvernées par `docs/MAINNET_GO_LIVE.md` et `scripts/mainnet-gate.sh`, non affectés par cette branche.

Toute affirmation ci-dessous distingue explicitement :
- **Prouvé** : test réel exécuté, avec preuve (commande, résultat, ou test automatisé nommé).
- **Vérifié par lecture de code** : le code a été lu et raisonné, aucune exécution réelle n'a eu lieu.
- **Non vérifié** : ni testé ni lu en détail dans le cadre de cette campagne.

## 1. Portée de cette branche

Quatre risques ouverts après RC1 (`RISKS_RC1.md`) ont été corrigés, chacun avec des tests réels et un commit isolé :

| Risque RC1 | Statut avant cette branche | Statut après | Commit |
|---|---|---|---|
| R4 — deux instances d'agent peuvent tourner en parallèle | MINEUR, non corrigé | **Corrigé** — verrou OS atomique (`instance_lock.py`), couvre `start`, `start --daemon`, `_run`, service Windows | `0b8ff74` |
| R1 — Delivery Worker sans politique de redémarrage | IMPORTANT, non corrigé | **Atténué** — retry borné en process + sortie délibérée vers le redémarrage automatique Render au-delà d'un seuil (`type: worker` dans `render.yaml`) | `85a0e15` |
| R2 — aucun ordonnanceur pour `/internal/sweep-offline` | IMPORTANT, non corrigé | **Corrigé** — processus dédié `sweep-scheduler.ts`, verrou Redis distribué, aucune exécution concurrente | `3deaefb` |
| R3 — aucune exclusivité GPU au niveau agent | IMPORTANT, non corrigé | **Corrigé** — verrou par GPU UUID (repli par machine), tous les types de job traités comme exclusifs | `513f1c7` |

R5 (couplage Docker/infra local, sans impact production) reste non traité — aucune action requise, déjà documenté comme sans risque en production dans `RISKS_RC1.md`.

Tests ajoutés dans cette branche : voir la section 7 (Revue finale) pour les chiffres exacts.

## 2. Priorité 6 — Audit du chemin de paiement réel (sans `DEV_PAYMENT_BYPASS`)

**Méthode : audit de code uniquement. Aucune transaction Solana n'a été émise, aucun SOL réel ou Devnet n'a été dépensé, aucun compte n'a été créé pour ce document.**

### 2.1 Chemin exact quand `DEV_PAYMENT_BYPASS=false`

1. `POST /bookings` — crée une réservation `AWAITING_DEPOSIT`. Ce chemin est identique que le bypass soit actif ou non (`server.ts`, transaction Serializable via `runBookingTransaction`, protégée contre les doubles réservations d'un même créneau — Test 5 Phase 5, régression `booking-transaction-retry.test.ts`).
2. `POST /bookings/:id/payment-intent` — refuse avec `503 escrow_not_deployed` tant que `ESCROW_PROGRAM_ID===NOT_DEPLOYED_YET`. **Constat vérifié par lecture de code : c'est le cas actuel de `render.yaml` (production) ET de `Anchor.toml` (`gpu_escrow="REPLACE_WITH_DEPLOYED_PROGRAM_ID"`, jamais remplacé). Le programme Anchor `gpu_escrow` conserve même son `declare_id!` par défaut du template (`Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m`), signe distinctif qu'il n'a jamais été construit avec un identifiant réellement généré.** Concrètement : **le chemin de paiement réel est aujourd'hui structurellement inatteignable en production**, indépendamment de `DEV_PAYMENT_BYPASS` — ce n'est pas seulement un flag désactivé, c'est un programme jamais déployé.
3. Si le programme était déployé : `buildOpenEscrowTransaction` construit une transaction non signée (`solana.ts`), le frontend la fait signer par Phantom, puis `POST /bookings/:id/confirm-deposit` appelle `verifyOpenEscrowTransaction`, qui **vérifie réellement on-chain** : signature du acheteur, programme invoqué, PDA d'escrow, propriétaire du compte, montant, durée (lecture des bytes du compte Anchor, pas seulement le résultat de la transaction). C'est un vrai verrou cryptographique — vérifié par lecture de code, jamais exercé en conditions réelles (cohérent avec `KNOWN_LIMITATIONS_RC1.md`).
4. Le job (`GPU_DIAGNOSTIC`/`GPU_PROOF`) s'exécute, `finalize-proof` exige une preuve d'usage signée et un nettoyage confirmé avant de passer la réservation à `COMPLETED` (`server.ts`, vérifié).
5. `POST /internal/bookings/:id/settlement/request` puis `POST /internal/bookings/:id/settlement/confirm` (routes internes, protégées par `INTERNAL_SERVICE_TOKEN`, **jamais appelées automatiquement — aucun ordonnanceur ne les déclenche**, contrairement au sweep offline désormais planifié en Priorité 3).

### 2.2 Constat de l'audit — CORRIGÉ depuis (commit `f29941e`)

**Constat initial (audit de code, avant correction) :** `confirmSettlement` (`settlement-transactions.ts`) ne vérifiait pas on-chain la signature qui lui était fournie. Contrairement à `verifyOpenEscrowTransaction` (dépôt), qui relit le compte Anchor et compare byte à byte, `confirmSettlement` se contentait de valider le **format** de la chaîne (`SIGNATURE_PATTERN`, regex base58) puis l'enregistrait comme preuve de règlement. Le contrat Anchor (`programs/gpu_escrow/src/lib.rs`) expose pourtant de vraies instructions de règlement on-chain (`propose_settlement`, `dispute`, `finalize`, `resolve_dispute`, `refund_expired`) — rien dans `apps/api` ne les appelait ni ne les vérifiait. C'était une lacune réelle, distincte de tout ce qui était documenté dans RC1.

**Correction apportée (commit `f29941e`) :** `POST /internal/bookings/:id/settlement/confirm` exige désormais une preuve on-chain réelle avant tout écriture, sauf en mode `DEV_PAYMENT_BYPASS` (voir décision de périmètre, section 2.6). `verifySettlementTransaction`/`evaluateSettlementTransaction` (`solana.ts`) relisent la transaction Solana et vérifient : programme invoqué, PDA d'escrow présent et accessible en écriture, une instruction `Finalize`/`ResolveDispute` a bien été exécutée, et — puisque le compte d'escrow est fermé vers l'acheteur à ce moment (`close = buyer` dans le programme Anchor, donc impossible à relire après coup comme pour le dépôt) — les **deltas de solde réels** de la transaction : le prestataire et la plateforme doivent avoir reçu exactement le montant calculé off-chain, l'acheteur au moins son remboursement (il récupère en plus la réserve de rent du compte fermé, d'où l'inégalité). Le montant vérifié on-chain provient de `previewSettlement`, jamais d'une valeur fournie par l'appelant. Un appel idempotent (signature déjà enregistrée) ne redéclenche jamais la vérification on-chain. Un programme non déployé (`ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET`, toujours le cas aujourd'hui) échoue proprement en `503` plutôt que de planter. 20 tests automatisés (`solana.test.ts`, `settlement-confirm-onchain-verification.test.ts`).

**Ce que cette correction ne change pas :** le programme `gpu_escrow` reste non déployé (section 2.4) — cette vérification ne peut donc pas encore être exercée en conditions réelles, seulement par tests avec des transactions simulées (fixtures). Elle sera exercée pour la première fois lors du premier cycle réel sur Devnet (section 2.5, étape 4).

### 2.3 Ce qui EST vérifié par du code et des tests (sans exécution réelle)

- Idempotence de `confirmSettlement` : un second appel avec la même signature renvoie le même résultat (`idempotent:true`) sans double écriture ; une signature différente pour une réservation déjà réglée est rejetée (`settlement_signature_conflict`). Vérifié par `settlement-transactions.ts` (isolation Serializable) — pas de test dédié à ce fichier trouvé dans `apps/api/test` au nom explicite, mais la logique est couverte transitivement par `settlement.test.ts`/`settlement-policy.test.ts` (invariants de calcul) et par lecture directe du code source.
- Gel manuel (`PaymentStatus.FROZEN`) : bloque toute tentative de règlement automatique tant qu'un humain n'a pas résolu la situation — test `settlement.test.ts` : *« a frozen payment has a manual resolution path (C6) »*.
- Invariant financier : `providerLamports + platformLamports + refundLamports === grossLamports`, jamais de montant négatif — `assertSettlementInvariant`, testé exhaustivement seconde par seconde dans `settlement-policy.test.ts` (*« settlement invariant holds for every second of an hour »*) et dans `rental_settlement.rs` côté Rust (6 tests, y compris *« settlement cannot be finalized twice »*).
- Pas de double transition : chaque `updateMany` de règlement est gardé par le statut source exact lu (mêmes garanties que les sweeps de Priorité 3), donc deux appels concurrents à `settlement/request` ne peuvent pas produire deux calculs différents.
- `POST /bookings` sous contention : retry automatique borné sur conflit de sérialisation Postgres (`booking-transaction-retry.ts`), avec preuve réelle en Phase 5 (Test 5).

### 2.4 Ce qui N'EST PAS vérifié

- Aucune transaction Solana réelle (Devnet ou Mainnet) n'a jamais été émise par ce dépôt, dans cette campagne ou les précédentes.
- Le programme `gpu_escrow` n'est déployé nulle part (ni Devnet ni Mainnet) — confirmé par `Anchor.toml` et `declare_id!`.
- Le lien cryptographique entre « la DB dit `SETTLED` » et « l'escrow on-chain a réellement payé » n'existe pas côté règlement (section 2.2).
- Aucun ordonnanceur n'appelle `settlement/request`/`settlement/confirm` automatiquement — un opérateur humain (ou un script externe, non fourni) doit les déclencher.
- Comportement sous re-org / transaction Solana droppée après confirmation optimiste : jamais testé, ni en code ni en réel.

### 2.5 Ce qu'il faut faire avant tout argent réel (Devnet inclus)

1. Générer une vraie paire de clés de programme et déployer `gpu_escrow` sur Devnet (`anchor deploy`), remplacer `REPLACE_WITH_DEPLOYED_PROGRAM_ID` dans `Anchor.toml` et `ESCROW_PROGRAM_ID` dans la configuration réelle.
2. Exécuter la suite Anchor (`anchor test`) contre le programme réellement déployé, pas seulement les 7 tests unitaires purs actuels.
3. ~~Combler la lacune de la section 2.2~~ — **fait** (commit `f29941e`) : `confirmSettlement` exige désormais une preuve on-chain réelle hors mode bypass. Reste à faire : exercer cette vérification contre un déploiement réel (elle n'a été prouvée que par tests avec fixtures jusqu'ici).
4. Exécuter un cycle complet réel sur Devnet : dépôt signé par un vrai wallet Phantom Devnet, job réel, règlement (`finalize` ou `resolve_dispute` réellement invoqué), remboursement partiel et total — avec preuve (signatures, montants observés, et confirmation que `verifySettlementTransaction` accepte la transaction réelle).
5. Avant Mainnet : suivre intégralement `docs/MAINNET_GO_LIVE.md` (audit externe, multisig, RPC privé, etc. — hors périmètre de cette branche).

### 2.6 Décision de périmètre paiement pour la bêta privée (provisoire, prise dans le cadre de cette tâche)

- **Aucun argent réel** pendant toute la durée de la bêta privée telle que couverte par ce document.
- **Aucun Mainnet** — inchangé, `README.md`/`docs/MAINNET_GO_LIVE.md` restent la référence, cette décision ne les remplace pas.
- Seuls deux modes sont autorisés pour la bêta privée : **`DEV_PAYMENT_BYPASS=true`** (aucune transaction Solana, comportement déjà exercé pendant toute la campagne RC1), **ou** un **Devnet contrôlé** (programme `gpu_escrow` réellement déployé sur Devnet, SOL de test uniquement, jamais de valeur réelle) une fois les étapes 1, 2 et 4 de la section 2.5 réalisées.
- Cette décision est **provisoire** : à reconfirmer explicitement par le porteur du produit avant l'ouverture effective de la bêta (case dédiée dans `BETA_PRIVATE_CHECKLIST.md`).

## 3. Priorité 5 — Validation multi-machines

Voir `BETA_PRIVATE_TEST_PLAN.md` pour le protocole complet. Résumé :

- **Prouvé** (Phase 4/5 RC1) : liaison, heartbeat, `GPU_DIAGNOSTIC` réel, robustesse — mais toujours **sur une seule machine physique** jouant les deux rôles (`KNOWN_LIMITATIONS_RC1.md`, non modifié par cette branche).
- **Non prouvé, protocole préparé dans cette branche** : deux machines physiques distinctes, réseau réel (NAT, latence), `apps/host-desktop` utilisé comme hôte réel, `GPU_PROOF`/`WORKSPACE_PREPARE` en conditions réelles, exclusivité GPU (Priorité 4) observée entre deux machines physiques partageant délibérément un même `gpuUuid` de test.
- **Aucun de ces tests n'a été exécuté dans le cadre de cette tâche.** Une seule machine physique de développement a été utilisée pour tout le travail de code de cette branche.

## 4. Revue finale — code, secrets, cohérence

Voir la section correspondante du rapport final livré en fin de tâche (chat) pour les résultats exacts (recherche TODO/FIXME/HACK, `console.log`, secrets, `cargo fmt`/`clippy`, CI, diff exact avec `main`).

## 5. Limitations reportées de RC1 (toujours valables, non affectées par cette branche)

Voir `KNOWN_LIMITATIONS_RC1.md`, en particulier : `GPU_PROOF`/`WORKSPACE_PREPARE` jamais exercés en conditions réelles, une seule configuration matérielle testée (Windows 11 + GTX 1650), aucune coupure réseau physique testée, aucun redémarrage complet de PC testé, aucun test de charge, `apps/host-desktop` jamais utilisé comme rôle hôte réel.

## 6. Estimation et verdict

Voir le rapport final livré dans la réponse de clôture de cette tâche (chiffres exacts de tests, diff, CI) pour l'estimation en pourcentage et le verdict final parmi `READY FOR PRIVATE BETA` / `READY AFTER SMALL FIXES` / `NOT READY`.
