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
| Moteur de tâches | Non commencé | Phase 3 |
| Docker isolé | Partiel | Lanceur présent, pas orchestré |
| Logs et artefacts | Non commencé | Phase 3 |
| Notifications/messagerie | Non commencé | Modèles partiels |
| Administration | Non commencé | Phase 7 |
| Audit externe/Mainnet | Bloqué | Preuves tierces requises |

## Phase active

Phase 1 : implémentée dans le code et soumise aux tests CI. Un test physique
Windows/Linux avec GPU reste nécessaire. Le moteur de tâches et le paiement
réel ne sont pas déclarés fonctionnels.
