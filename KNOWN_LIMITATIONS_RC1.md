# Limites connues — RC1

Ce document liste ce que RC1 **n'a délibérément pas testé ou couvert**, distinct de `RISKS_RC1.md` qui liste des défauts/lacunes trouvés. Une limite ici n'est pas un bug — c'est une frontière assumée du périmètre de cette campagne.

## Financement et paiement

- **`DEV_PAYMENT_BYPASS=true` sur l'intégralité de la campagne.** Aucune transaction Solana réelle, aucun escrow on-chain, aucun argent réel déplacé. Le code refuse de démarrer avec ce flag actif si `NODE_ENV=production` (garde-fou existant, vérifié), mais le parcours de financement réel (déploiement du programme `gpu_escrow` sur devnet/mainnet, signature Phantom, vérification on-chain de la transaction de dépôt) n'a été exercé à aucun moment.
- Le contrat `programs/gpu_escrow` est testé unitairement (7/7 tests, logique de règlement pure) mais **jamais déployé ni exercé en conditions réelles** pendant cette campagne.

## Types de charge de travail

- Seul `GPU_DIAGNOSTIC` (sonde GPU isolée, sans calcul soutenu) a été exécuté en conditions réelles — plus de 15 fois entre les Phases 4 et 5.
- `GPU_PROOF` (charge CUDA réelle avec preuve d'usage signée) n'a été validé que par lecture de code et tests unitaires (`test_gpu_proof_workspace.py`), jamais en conditions réelles.
- `WORKSPACE_PREPARE` (espace de travail interactif, code-server) n'a pas été testé du tout dans cette campagne.

## Topologie réseau et matérielle

- Hôte et locataire ont été joués par la même personne, sur la même machine physique, pour l'intégralité de la campagne (première location réelle + Phases 4 et 5). Aucune latence réseau réelle, aucun NAT, aucune séparation physique n'a été testée.
- Une seule configuration matérielle : Windows 11 (build 10.0.26200), Docker Desktop 29.6.2 (backend WSL2), NVIDIA GeForce GTX 1650. Le correctif de l'image `gpu-diagnostic` (bug NVML) repose sur un raisonnement valable aussi pour Linux natif + NVIDIA Container Toolkit standard, mais cela n'a pas été vérifié indépendamment sur une machine Linux.
- `apps/host-desktop` (application Tauri) n'a jamais été utilisée comme rôle hôte réel — le rôle hôte repose entièrement sur l'agent CLI Python tout au long de la campagne. `host-desktop` est testé unitairement (440/440) mais pas intégré à un parcours de location réel.

## Robustesse — couverture partielle

- **Timeout de workload (Test 2, Phase 5)** : trois tentatives réelles distinctes, aucune concluante — voir `RISKS_RC1.md` R5 pour le détail. Le chemin de code correspondant (`subprocess.run(timeout=120)`) est correct par lecture de code et testé unitairement, mais pas prouvé en conditions bout-en-bout réelles.
- **Perte de connexion réseau physique** (câble débranché, Wi-Fi coupé) n'a pas été testée — seules les coupures API/Docker/Redis ont été simulées, pas une coupure réseau au niveau OS.
- **Redémarrage complet du PC hôte** n'a pas été testé (explicitement exclu par consigne pendant la Phase 5).

## Échelle et charge

- Aucun test de charge (plusieurs dizaines/centaines de réservations simultanées) n'a été effectué. La réservation concurrente testée (Test 5) se limite à deux requêtes simultanées.
- Aucun test avec plusieurs machines hôtes distinctes actives simultanément.

## Documentation et artefacts RC1

- Ce jeu de documents (`CHANGELOG.md`, `RELEASE_NOTES_RC1.md`, `CHECKLIST_RC1.md`, `RISKS_RC1.md`, `KNOWN_LIMITATIONS_RC1.md`) est produit une seule fois, à la clôture de la Phase 5. Il ne sera pas maintenu automatiquement lors de futurs changements — à mettre à jour manuellement lors de la prochaine campagne.
