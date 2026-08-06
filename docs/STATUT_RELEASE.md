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
- tests unitaires Node et contrôles statiques ;
- **exécution réelle d'un workload GPU isolé, sur GPU physique** — preuve datée et
  reproductible dans `docs/FIRST_REAL_GPU_RENTAL_RESULT.md` (2026-08-06 :
  booking + job `GPU_DIAGNOSTIC` `COMPLETED`, `gpuDetected=true`, nettoyage
  confirmé). Fait avec `DEV_PAYMENT_BYPASS=true` (pas d'escrow réel) et hôte/
  locataire sur la même machine — voir les limites de ce test dans ce document.

## Doit encore être prouvé sur une machine de développement

- compilation Rust/Anchor ;
- tests du programme sur `solana-test-validator` ;
- déploiement du programme avec un nouveau Program ID ;
- parcours Phantom → escrow → règlement sur Devnet ;
- reprise après panne et sauvegarde/restauration.

## Interdit pour le moment

- activer `ALLOW_MAINNET=true` ;
- utiliser un Program ID d’exemple ;
- recevoir des SOL Mainnet de clients ;
- présenter le projet comme audité ou garanti.

La release est une base Devnet sérieuse. Elle n’est pas une certification financière.
