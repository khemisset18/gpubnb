# Audit et modifications — 21 juillet 2026

## Verdict

Le code a été renforcé mais reste **NO-GO Mainnet public**. Les éléments impossibles à fabriquer dans le dépôt restent bloquants : audit indépendant, déploiement et configuration multisig, Program ID final lié à une clé de déploiement sécurisée, pentest de la sandbox, infrastructure redondante, restauration de sauvegarde testée et validation juridique.

## Correctifs appliqués

1. Contraintes PDA canoniques sur toutes les instructions manipulant un escrow existant.
2. Blocage des propositions de règlement lorsque le programme est en pause.
3. Tests Rust supplémentaires sur les entrées invalides et les valeurs maximales.
4. Domaine d’authentification fixé par `PUBLIC_APP_DOMAIN`, sans confiance dans l’en-tête Host.
5. Engagement Solana configurable et obligatoirement `finalized` sur Mainnet.
6. Refus du RPC public Solana en configuration Mainnet.
7. Vérification des dépôts avec le même niveau d’engagement que la configuration.
8. Rejet des réservations passées, trop éloignées et des montants nuls.
9. Protection des compteurs heartbeat contre les dépassements de précision JavaScript.
10. Liaison obligatoire d’un `sessionId` agent à une réservation active de la même machine.
11. HTTPS obligatoire pour l’agent en production et validation stricte de la clé privée.
12. `.gitignore` pour secrets, keypairs, artefacts et dépendances.
13. Script de blocage `scripts/mainnet-gate.sh`.
14. Runbook d’incident et répertoire d’attestations externes.
15. Jobs CI pour tests Rust et contrôles de production.

## Vérifications exécutées

- Tests API : 5/5 réussis.
- Compilation Python de l’agent : réussie.
- Vérification syntaxique JavaScript frontend : réussie.
- Compilation TypeScript complète : non terminée localement, car Prisma tente de télécharger son moteur depuis `binaries.prisma.sh`, indisponible dans l’environnement d’exécution.
- Tests Rust : non exécutés localement, car `cargo` n’est pas installé dans l’environnement ; ils ont été ajoutés à la CI.

## Risques résiduels majeurs

- L’agent reste contrôlé par l’hôte GPU : sa signature ne constitue pas une attestation matérielle indépendante.
- Aucun runtime de workloads non fiables avec isolation microVM n’est fourni.
- Le règlement et l’administration restent conceptuellement dépendants des clés configurées tant que la multisig n’est pas réellement déployée.
- Le contrat conserve le Program ID de développement Anchor jusqu’à la génération sécurisée du Program ID final.
- La gestion de litiges ne contient pas encore de stockage complet de preuves, délais contradictoires et gouvernance d’arbitrage.
- La réconciliation on-chain/off-chain, l’indexeur et les procédures de reprise doivent être validés en environnement de production.

## Procédure de sortie Mainnet

1. Générer hors dépôt la keypair du programme et synchroniser `declare_id!`, `Anchor.toml`, API et frontend.
2. Déployer en Devnet, exécuter les tests d’intégration Anchor et les scénarios adversariaux.
3. Faire auditer le commit et le binaire `.so` exacts.
4. Transférer admin, oracle et upgrade authority vers une multisig testée.
5. Déployer et pentester la sandbox d’exécution.
6. Mettre en place RPC privé, observabilité, sauvegardes et réconciliation.
7. Lancer un Mainnet fermé avec plafonds faibles et fournisseurs approuvés.
