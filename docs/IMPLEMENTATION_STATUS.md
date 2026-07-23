# État d'implémentation

Dernière mise à jour : 23 juillet 2026.

| Domaine | État | Note |
|---|---|---|
| Audit complet initial | Terminé | Voir `docs/AUDIT.md` |
| Authentification et profils | Terminé | Google, e-mail, Phantom, onboarding |
| Agent CLI multiplateforme | Terminé | 12 commandes, Windows/Linux |
| Liaison machine par code | Terminé | Code Redis à usage unique, 10 min |
| Diagnostic machine | Terminé | GPU, OS, RAM, disque, Docker, API |
| Heartbeat signé | Terminé | CLI, challenge, Ed25519, compteur |
| Marketplace persistée | Partiel | Annonces oui, demandes non |
| Réservations | Partiel | Création et anti-chevauchement |
| Paiement Devnet | Bloqué | Program ID non déployé |
| Moteur de tâches | Implémenté et validé par CI | États stricts, API locataire/agent, diagnostic uniquement |
| Docker isolé | Implémenté, test GPU requis | Digest obligatoire, réseau coupé, lecture seule, capacités supprimées |
| Logs et artefacts | Partiel | Logs persistés et plafonnés ; stockage d’artefacts à connecter |
| Notifications/messagerie | Non commencé | Modèles partiels |
| Administration | Non commencé | Phase 7 |
| Audit externe/Mainnet | Bloqué | Preuves tierces requises |

## Phase active

Phase 1 : implémentée et validée par la CI (`29977272068`) : installation du
paquet, tests unitaires Python, migration PostgreSQL, tests API, compilation
TypeScript, tests Rust et scans de sécurité réussis. Un test physique
Windows/Linux avec GPU reste nécessaire. Le moteur de tâches et le paiement
réel ne sont pas déclarés fonctionnels.

## Phase 2

Le moteur de tâches MVP accepte uniquement `GPU_DIAGNOSTIC`. Une tâche exige
une réservation financée et active, est attribuée uniquement à la machine de
cette réservation, puis suit des transitions d’état explicites. Les appels de
l’agent sont signés Ed25519 et protégés contre le rejeu.

Le runner Docker refuse toute image non épinglée par digest SHA-256 et applique
les limites suivantes : aucun réseau, système de fichiers en lecture seule,
aucune capability, `no-new-privileges`, limites CPU/RAM/PID et délai maximal.
Une image de diagnostic contrôlée doit encore être construite, scannée, publiée
et renseignée avec `gpubnb-agent setup --diagnostic-image ...@sha256:...`.
La validation physique bout en bout reste bloquée tant qu’il n’existe pas de
réservation Devnet financée et de machine NVIDIA liée.

Validation logicielle Phase 2 : GitHub Actions `29978188424`, cinq jobs réussis
(API, agent, contrat, portes de production et analyse statique de sécurité).
