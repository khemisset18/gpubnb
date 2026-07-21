# Statut de GPUbnb v1.0 Devnet

## Fonctionne ou est vérifiable sans fonds réels

- interface statique Netlify ;
- authentification par signature de portefeuille côté API ;
- schéma PostgreSQL et migrations ;
- sessions Redis ;
- réservation et préparation d’une transaction escrow ;
- vérification on-chain du dépôt ;
- agent GPU signé et heartbeats anti-rejeu ;
- calcul 95 % fournisseur / 5 % plateforme ;
- tests unitaires Node et contrôles statiques.

## Doit encore être prouvé sur une machine de développement

- compilation Rust/Anchor ;
- tests du programme sur `solana-test-validator` ;
- déploiement du programme avec un nouveau Program ID ;
- parcours Phantom → escrow → règlement sur Devnet ;
- exécution réelle d’un workload GPU isolé ;
- reprise après panne et sauvegarde/restauration.

## Interdit pour le moment

- activer `ALLOW_MAINNET=true` ;
- utiliser un Program ID d’exemple ;
- recevoir des SOL Mainnet de clients ;
- présenter le projet comme audité ou garanti.

La release est une base Devnet sérieuse. Elle n’est pas une certification financière.
